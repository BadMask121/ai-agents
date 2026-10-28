use std::sync::Arc;

use anyhow::{bail, Context};
use tokio::sync::{mpsc, watch, Mutex};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use dj_sync::{
    bot, cloud, cloud_v2, config, config::Config, downloader::ProcessFetcher, http, jobs::JobQueue,
    library::LibraryIndex, rekordbox_db, rekordbox_db::RekordboxLibrary,
    rekordbox_xml::RekordboxLib, spotify::SpotifyClient,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // ~/.dj-sync/.env first: under launchd the working directory isn't the repo.
    // dotenvy never overrides a variable that's already set, so the first file wins.
    if let Ok(dir) = config::state_dir() {
        let _ = dotenvy::from_path(dir.join(".env"));
    }
    let _ = dotenvy::dotenv();

    // stderr only: stdout stays clean for anything that might parse it.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        // No colour codes in launchd's log file.
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("dj_sync=info")),
        )
        .init();

    let cfg = Config::load().context("loading config")?;
    info!(
        cloud = cfg.cloud.enabled,
        local_mcp = cfg.mcp.enabled,
        rekordbox_db = cfg.rekordbox_db.enabled,
        "loaded config"
    );

    let bot_enabled = Config::telegram_bot_token().is_ok();
    // `[mcp] enabled` is the local secret-path MCP lane (Cloudflare Tunnel);
    // the local HTTP server itself always runs for the menu app.
    let http_enabled = cfg.mcp.enabled;
    let cloud_enabled = cfg.cloud.enabled;
    if !bot_enabled && !http_enabled && !cloud_enabled {
        bail!("nothing to run: set TELEGRAM_BOT_TOKEN, `[mcp] enabled = true` and/or `[cloud] enabled = true`");
    }
    // Fail fast on lane config so launchd's log says why.
    // v2 (default): this Mac registers itself; v1: the CLOUD_AGENT_TOKEN poll.
    let cloud_v1 = cloud_enabled && cfg.cloud.protocol == 1;
    let cloud_token = if cloud_v1 {
        Some(Config::cloud_agent_token()?)
    } else {
        None
    };
    let toolbox = if cfg.toolbox.enabled {
        Some(dj_sync::toolbox::Toolbox::new(
            dj_sync::toolbox::ToolPaths::new(dj_sync::toolbox::ToolPaths::default_root()),
            Some(cfg.toolbox.manifest_url.clone()),
        )?)
    } else {
        None
    };
    let cloud_session = if cloud_enabled && !cloud_v1 {
        Some(cloud_v2::CloudSession::new(
            &cfg.cloud.base_url,
            config::state_dir()?,
        )?)
    } else {
        None
    };

    // One download queue shared by the HTTP and cloud lanes. It is the only
    // writer of the import XML, so only one dj-sync may run it at a time.
    let downloads = http_enabled || cloud_enabled;
    // Rekordbox's own library (master.db), written alongside the import XML.
    let library = if downloads && cfg.rekordbox_db.enabled {
        let download = cfg.download.clone();
        Some(Arc::new(
            RekordboxLibrary::new(cfg.rekordbox_db.clone(), config::state_dir()?).with_own_dirs(
                move || {
                    // The current folder, plus the configured one songs may
                    // have landed in before the DJ picked another.
                    let mut dirs = vec![download.current_dir().0, download.dir.clone()];
                    dirs.dedup();
                    dirs
                },
            ),
        ))
    } else {
        None
    };
    let (jobs, _instance_lock) = if downloads {
        let lock = acquire_instance_lock()?;
        let fetcher = ProcessFetcher::from_config(&cfg.download)?;
        let (jobs, _worker) = JobQueue::start_with(cfg.download.clone(), fetcher, library.clone())?;
        (Some(jobs), Some(lock))
    } else {
        (None, None)
    };

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let shutdown_tx = Arc::new(shutdown_tx);
    {
        let tx = shutdown_tx.clone();
        tokio::spawn(async move {
            wait_for_shutdown_signal().await;
            info!("shutting down");
            let _ = tx.send(true);
        });
    }

    if let Some(lib) = library.clone() {
        tokio::spawn(rekordbox_db::run(lib, shutdown_rx.clone()));
    }

    // Lanes are independent: a bot failure must not take the others down.
    let bot_lane = {
        let (cfg, shutdown) = (cfg.clone(), shutdown_rx.clone());
        async move {
            if bot_enabled {
                if let Err(e) = run_bot_lane(cfg, shutdown).await {
                    error!(error = ?e, "telegram bot lane exited with error");
                }
            } else {
                info!("TELEGRAM_BOT_TOKEN not set; telegram bot disabled");
            }
        }
    };
    // HTTP or cloud lane failing is fatal: stop everything so launchd sees a
    // non-zero exit instead of a half-running process.
    let http_lane = {
        let (cfg, jobs, shutdown, tx) = (
            cfg.clone(),
            jobs.clone(),
            shutdown_rx.clone(),
            shutdown_tx.clone(),
        );
        let library = library.clone();
        let session = cloud_session.clone();
        let toolbox = toolbox.clone();
        async move {
            let Some(jobs) = jobs else {
                return Ok(());
            };
            let r = http::serve(cfg, jobs, library, session, toolbox, shutdown).await;
            if r.is_err() {
                let _ = tx.send(true);
            }
            r
        }
    };
    let toolbox_lane = {
        let (toolbox, shutdown) = (toolbox.clone(), shutdown_rx.clone());
        async move {
            match toolbox {
                Some(tb) => dj_sync::toolbox::run(tb, shutdown).await,
                None => Ok(()),
            }
        }
    };

    let cloud_lane = {
        let (cloud_cfg, tx) = (cfg.cloud.clone(), shutdown_tx.clone());
        let library = library.clone();
        let toolbox_gate = toolbox.clone();
        async move {
            let Some(jobs) = jobs else {
                return Ok(());
            };
            // Jobs wait in the cloud until the tools they need exist.
            if let Some(tb) = &toolbox_gate {
                tb.wait_first_pass().await;
            }
            let r = match (cloud_token, cloud_session) {
                (Some(token), _) => cloud::run(cloud_cfg, token, jobs, library, shutdown_rx).await,
                (None, Some(session)) => {
                    cloud_v2::run(cloud_cfg, session, jobs, library, shutdown_rx).await
                }
                (None, None) => return Ok(()),
            };
            if r.is_err() {
                let _ = tx.send(true);
            }
            r
        }
    };

    let ((), http_result, cloud_result, toolbox_result) =
        tokio::join!(bot_lane, http_lane, cloud_lane, toolbox_lane);
    if let Err(e) = toolbox_result {
        error!(error = %format!("{e:#}"), "toolbox lane failed");
    }
    http_result.context("http lane")?;
    cloud_result.context("cloud lane")
}

/// Exclusive lock on ~/.dj-sync/dj-sync.lock for the life of the process,
/// so a second dj-sync (e.g. `cargo run` while launchd's copy is up) can't
/// run a competing download worker.
fn acquire_instance_lock() -> anyhow::Result<std::fs::File> {
    let path = config::state_dir()?.join("dj-sync.lock");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => {
            bail!(
                "another dj-sync is already running ({} is locked)",
                path.display()
            )
        }
        Err(std::fs::TryLockError::Error(e)) => {
            Err(e).with_context(|| format!("locking {}", path.display()))
        }
    }
}

async fn run_bot_lane(cfg: Config, shutdown: watch::Receiver<bool>) -> anyhow::Result<()> {
    cfg.validate_bot()?;
    let spotify = SpotifyClient::from_env().context("spotify client")?;

    // Build the library index up front (off the async threads — it walks the
    // whole library). /scan rebuilds it.
    let roots = cfg.library.roots.clone();
    let index = tokio::task::spawn_blocking(move || LibraryIndex::build(&roots))
        .await
        .context("library index task")??;
    let library = Arc::new(Mutex::new(index));
    info!(tracks = library.lock().await.len(), "library indexed");

    let rb_lib = Arc::new(Mutex::new(load_rekordbox_xml(&cfg)));

    let (job_tx, job_rx) = mpsc::channel::<bot::Job>(16);

    let executor = tokio::spawn(bot::executor::run(
        job_rx,
        cfg.clone(),
        spotify,
        library.clone(),
        rb_lib.clone(),
    ));

    // run_bot drops job_tx when it returns, which ends the executor.
    let result = bot::run_bot(cfg, job_tx, shutdown).await;
    let _ = executor.await;
    result
}

/// Ctrl-C, or SIGTERM from launchd (`launchctl bootout` / logout).
async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(e) => {
                warn!(error = %e, "could not install SIGTERM handler; Ctrl-C only");
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn load_rekordbox_xml(cfg: &Config) -> Option<RekordboxLib> {
    let path = cfg.rekordbox.xml_path.as_ref()?;
    match RekordboxLib::load(path) {
        Ok(l) => Some(l),
        Err(e) => {
            warn!(path = %path.display(), error = %e, "failed to load rekordbox.xml; /playlists will be unavailable");
            None
        }
    }
}
