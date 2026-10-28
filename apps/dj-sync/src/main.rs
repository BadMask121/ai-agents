use std::sync::Arc;

use anyhow::{bail, Context};
use tokio::sync::{mpsc, watch, Mutex};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use dj_sync::{
    bot, config, config::Config, http, library::LibraryIndex, rekordbox_xml::RekordboxLib,
    spotify::SpotifyClient,
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
    if !bot_enabled && !http_enabled {
        bail!("nothing to run: set TELEGRAM_BOT_TOKEN and/or `[mcp] enabled = true`");
    }

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    tokio::spawn(async move {
        wait_for_shutdown_signal().await;
        info!("shutting down");
        let _ = shutdown_tx.send(true);
    });

    // Lanes are independent: a bot failure must not take the HTTP lane down.
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
    let http_lane = async move {
        if http_enabled {
            http::serve(cfg, shutdown_rx).await
        } else {
            Ok(())
        }
    };

    let ((), http_result) = tokio::join!(bot_lane, http_lane);
    // The HTTP lane failing (e.g. port already taken) is fatal so launchd
    // sees a non-zero exit instead of a half-running process.
    http_result
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
