use std::sync::Arc;

use anyhow::Context;
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use dj_sync::{
    bot, config::Config, library::LibraryIndex, rekordbox_xml::RekordboxLib,
    spotify::SpotifyClient,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("dj_sync=info")),
        )
        .init();

    let cfg = Config::load().context("loading config")?;
    info!(roots = ?cfg.library.roots, "loaded config");

    let spotify = SpotifyClient::from_env().context("spotify client")?;

    // Build the library index up front. /scan rebuilds it.
    let library = Arc::new(Mutex::new(LibraryIndex::build(&cfg.library.roots)?));
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

    if let Err(e) = bot::run_bot(cfg, job_tx).await {
        error!(error = ?e, "bot loop exited with error");
    }

    let _ = executor.await;
    Ok(())
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
