use std::sync::Arc;

use anyhow::{bail, Context};
use tokio::sync::{mpsc, watch, Mutex};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use dj_sync::{
    bot, cloud, config, config::Config, downloader::ProcessFetcher, http, jobs::JobQueue,
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
    info!(roots = ?cfg.library.roots, "loaded config");

    let bot_enabled = Config::telegram_bot_token().is_ok();
    let http_enabled = cfg.mcp.enabled;
    let cloud_enabled = cfg.cloud.enabled;
    if !bot_enabled && !http_enabled && !cloud_enabled {
        bail!("nothing to run: set TELEGRAM_BOT_TOKEN, `[mcp] enabled = true` and/or `[cloud] enabled = true`");
    }
    // Fail fast on lane config so launchd's log says why.
    let cloud_token = if cloud_enabled {
        Some(Config::cloud_agent_token()?)
    } else {
        None
    };

    // One download queue shared by the HTTP and cloud lanes. It is the only
    // writer of the import XML, so only one dj-sync may run it at a time.
    let downloads = http_enabled || cloud_enabled;
    // Rekordbox's own library (master.db), written alongside the import XML.
    let library = if downloads && cfg.rekordbox_db.enabled {
        Some(Arc::new(RekordboxLibrary::new(
            cfg.rekordbox_db.clone(),
            config::state_dir()?,
        )))
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
        async move {
            let (true, Some(jobs)) = (http_enabled, jobs) else {
                return Ok(());
            };
            let r = http::serve(cfg, jobs, library, shutdown).await;
            if r.is_err() {
                let _ = tx.send(true);
            }
            r
        }
    };
    let cloud_lane = {
        let (cloud_cfg, tx) = (cfg.cloud.clone(), shutdown_tx.clone());
        async move {
            let (Some(token), Some(jobs)) = (cloud_token, jobs) else {
                return Ok(());
            };
            let r = cloud::run(cloud_cfg, token, jobs, shutdown_rx).await;
            if r.is_err() {
                let _ = tx.send(true);
            }
            r
        }
    };

    let ((), http_result, cloud_result) = tokio::join!(bot_lane, http_lane, cloud_lane);
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
