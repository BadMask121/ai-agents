use std::sync::Arc;

use anyhow::Context;
use teloxide::dptree;
use teloxide::prelude::*;
use teloxide::types::{ChatId, MessageId};
use teloxide::utils::command::BotCommands;
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};

use crate::config::Config;
use crate::library::LibraryIndex;
use crate::nlu::{parse_freeform, NluCommand};
use crate::parser::{SpotifyKind, SpotifyRef};
use crate::rekordbox_xml::RekordboxLib;
use crate::spotify::SpotifyClient;

#[derive(BotCommands, Clone)]
#[command(
    rename_rule = "lowercase",
    description = "dj-sync — paste a Spotify URL or use a command:"
)]
enum Command {
    #[command(description = "show this help")]
    Start,
    #[command(description = "show this help")]
    Help,
    #[command(description = "list rekordbox playlists")]
    Playlists,
    #[command(description = "show tracks in a playlist: /playlist <number-or-name>")]
    Playlist(String),
    #[command(description = "rekordbox library stats")]
    Lib,
    #[command(description = "(paused) sync a Spotify playlist")]
    Sync(String),
    #[command(description = "rescan local audio library")]
    Scan,
    #[command(description = "show last run's missing tracks")]
    Missing,
}

#[derive(Debug, Clone)]
pub struct Job {
    pub kind: JobKind,
    pub reply_to: ReplyHandle,
}

#[derive(Debug, Clone)]
pub enum JobKind {
    Sync(SpotifyRef),
    Scan,
    Missing,
    Playlists,
    Playlist(String),
    Lib,
}

#[derive(Debug, Clone)]
pub struct ReplyHandle {
    pub chat_id: ChatId,
    pub status_message_id: MessageId,
}

type AllowedIds = Arc<Vec<i64>>;
type JobTx = Arc<mpsc::Sender<Job>>;

pub async fn run_bot(_cfg: Config, job_tx: mpsc::Sender<Job>) -> anyhow::Result<()> {
    let token = Config::telegram_bot_token().context("telegram token")?;
    let bot = Bot::new(token);
    let allowed: AllowedIds = Arc::new(Config::allowed_user_ids());
    info!(allowed = ?allowed, "starting telegram bot");
    bot.set_my_commands(Command::bot_commands()).await.ok();

    let job_tx: JobTx = Arc::new(job_tx);
    let handler = Update::filter_message().endpoint(handle_message);

    Dispatcher::builder(bot, handler)
        .dependencies(dptree::deps![allowed, job_tx])
        .enable_ctrlc_handler()
        .build()
        .dispatch()
        .await;
    Ok(())
}

async fn handle_message(
    bot: Bot,
    msg: Message,
    allowed: AllowedIds,
    job_tx: JobTx,
) -> Result<(), teloxide::RequestError> {
    if let Some(user) = msg.from() {
        if !allowed.is_empty() && !allowed.contains(&(user.id.0 as i64)) {
            return Ok(());
        }
    }

    let text = match msg.text() {
        Some(t) => t.to_string(),
        None => return Ok(()),
    };

    let parsed_command = Command::parse(&text, "dj_sync_bot").ok();

    let kind: JobKind = match parsed_command {
        Some(Command::Start) | Some(Command::Help) => {
            bot.send_message(msg.chat.id, Command::descriptions().to_string())
                .await?;
            return Ok(());
        }
        Some(Command::Sync(_)) => {
            bot.send_message(
                msg.chat.id,
                "Spotify sync is paused — Spotify restricted Web API access for new dev apps. \
                 Browse Rekordbox instead: /playlists",
            )
            .await?;
            return Ok(());
        }
        Some(Command::Scan) => JobKind::Scan,
        Some(Command::Missing) => JobKind::Missing,
        Some(Command::Playlists) => JobKind::Playlists,
        Some(Command::Playlist(arg)) => {
            if arg.trim().is_empty() {
                bot.send_message(msg.chat.id, "usage: /playlist <number-or-name>")
                    .await?;
                return Ok(());
            }
            JobKind::Playlist(arg)
        }
        Some(Command::Lib) => JobKind::Lib,
        None => match parse_freeform(&text).await {
            NluCommand::Sync(_) => {
                bot.send_message(msg.chat.id, "Spotify sync is paused. Try /playlists.")
                    .await?;
                return Ok(());
            }
            NluCommand::Scan => JobKind::Scan,
            NluCommand::Missing => JobKind::Missing,
            NluCommand::Help => {
                bot.send_message(msg.chat.id, Command::descriptions().to_string())
                    .await?;
                return Ok(());
            }
            NluCommand::Unknown => {
                bot.send_message(
                    msg.chat.id,
                    "send /playlists to browse, or /help to see commands.",
                )
                .await?;
                return Ok(());
            }
        },
    };

    let status = bot
        .send_message(msg.chat.id, status_starting(&kind))
        .await?;

    let job = Job {
        kind,
        reply_to: ReplyHandle {
            chat_id: msg.chat.id,
            status_message_id: status.id,
        },
    };

    if let Err(e) = job_tx.send(job).await {
        warn!(error = %e, "executor channel closed");
        bot.edit_message_text(msg.chat.id, status.id, "executor unavailable")
            .await?;
    }
    Ok(())
}

fn status_starting(kind: &JobKind) -> String {
    match kind {
        JobKind::Sync(r) => format!(
            "🎧 starting sync — fetching {}…",
            match r.kind {
                SpotifyKind::Playlist => "playlist",
                SpotifyKind::Album => "album",
                SpotifyKind::Track => "track",
            }
        ),
        JobKind::Scan => "🔎 rescanning local library…".to_string(),
        JobKind::Missing => "📋 looking up last run's misses…".to_string(),
        JobKind::Playlists => "📚 reading rekordbox.xml…".to_string(),
        JobKind::Playlist(arg) => format!("📚 opening playlist {arg}…"),
        JobKind::Lib => "📚 checking rekordbox library…".to_string(),
    }
}

pub mod executor {
    use super::*;
    use crate::matcher;
    use crate::rekordbox;
    use crate::rekordbox_xml::{render_lib_stats, render_playlist, render_playlists_listing};
    use crate::usb;
    use crate::{Confidence, MatchResult, MissReason};
    use std::path::PathBuf;

    pub async fn run(
        mut rx: mpsc::Receiver<Job>,
        cfg: Config,
        spotify: SpotifyClient,
        library: Arc<Mutex<LibraryIndex>>,
        rb_lib: Arc<Mutex<Option<RekordboxLib>>>,
    ) {
        let token = match Config::telegram_bot_token() {
            Ok(t) => t,
            Err(e) => {
                tracing::error!(error = %e, "executor cannot acquire telegram token");
                return;
            }
        };
        let bot = Bot::new(token);
        let mut last_misses: Vec<MatchResult> = Vec::new();

        while let Some(job) = rx.recv().await {
            let reply_to = job.reply_to.clone();
            let result = match job.kind {
                JobKind::Sync(r) => do_sync(&bot, &spotify, &library, &cfg, r, &reply_to).await,
                JobKind::Scan => do_scan(&bot, &cfg, &library, &reply_to).await,
                JobKind::Missing => do_missing(&bot, &last_misses, &reply_to).await,
                JobKind::Playlists => do_playlists(&bot, &rb_lib, &reply_to).await,
                JobKind::Playlist(arg) => do_playlist(&bot, &rb_lib, &arg, &reply_to).await,
                JobKind::Lib => do_lib(&bot, &rb_lib, &reply_to).await,
            };
            match result {
                Ok(Some(misses)) => last_misses = misses,
                Ok(None) => {}
                Err(e) => {
                    tracing::error!(error = ?e, "job failed");
                    let _ = bot
                        .edit_message_text(
                            reply_to.chat_id,
                            reply_to.status_message_id,
                            format!("❌ job failed: {e:#}"),
                        )
                        .await;
                }
            }
        }
    }

    async fn do_playlists(
        bot: &Bot,
        rb_lib: &Mutex<Option<RekordboxLib>>,
        reply_to: &ReplyHandle,
    ) -> anyhow::Result<Option<Vec<MatchResult>>> {
        let mut guard = rb_lib.lock().await;
        let lib = match guard.as_mut() {
            Some(l) => l,
            None => {
                edit(bot, reply_to, "rekordbox.xml not configured. Set rekordbox.xml_path in ~/.dj-sync/config.toml.").await;
                return Ok(None);
            }
        };
        let _ = lib.reload_if_changed();
        let chunks = render_playlists_listing(lib);
        send_chunks(bot, reply_to, chunks).await;
        Ok(None)
    }

    async fn do_playlist(
        bot: &Bot,
        rb_lib: &Mutex<Option<RekordboxLib>>,
        arg: &str,
        reply_to: &ReplyHandle,
    ) -> anyhow::Result<Option<Vec<MatchResult>>> {
        let mut guard = rb_lib.lock().await;
        let lib = match guard.as_mut() {
            Some(l) => l,
            None => {
                edit(bot, reply_to, "rekordbox.xml not configured.").await;
                return Ok(None);
            }
        };
        let _ = lib.reload_if_changed();
        let entry = match lib.lookup(arg) {
            Some(e) => e.clone(),
            None => {
                edit(
                    bot,
                    reply_to,
                    &format!("no playlist matched \"{arg}\". Try /playlists."),
                )
                .await;
                return Ok(None);
            }
        };
        let chunks = render_playlist(lib, &entry);
        send_chunks(bot, reply_to, chunks).await;
        Ok(None)
    }

    async fn do_lib(
        bot: &Bot,
        rb_lib: &Mutex<Option<RekordboxLib>>,
        reply_to: &ReplyHandle,
    ) -> anyhow::Result<Option<Vec<MatchResult>>> {
        let mut guard = rb_lib.lock().await;
        match guard.as_mut() {
            Some(l) => {
                let _ = l.reload_if_changed();
                edit(bot, reply_to, &render_lib_stats(l)).await;
            }
            None => edit(bot, reply_to, "rekordbox.xml not configured.").await,
        }
        Ok(None)
    }

    async fn send_chunks(bot: &Bot, reply_to: &ReplyHandle, chunks: Vec<String>) {
        if chunks.is_empty() {
            return;
        }
        // First chunk replaces the "starting…" status message.
        let first = &chunks[0];
        let _ = bot
            .edit_message_text(reply_to.chat_id, reply_to.status_message_id, first)
            .await;
        // Any remaining chunks land as fresh messages in order.
        for c in &chunks[1..] {
            let _ = bot.send_message(reply_to.chat_id, c).await;
        }
    }

    async fn do_sync(
        bot: &Bot,
        spotify: &SpotifyClient,
        library: &Mutex<LibraryIndex>,
        cfg: &Config,
        r: SpotifyRef,
        reply_to: &ReplyHandle,
    ) -> anyhow::Result<Option<Vec<MatchResult>>> {
        let tracks = match r.kind {
            SpotifyKind::Playlist => spotify.fetch_playlist(&r.id).await?,
            SpotifyKind::Album => spotify.fetch_album(&r.id).await?,
            SpotifyKind::Track => spotify.fetch_track(&r.id).await?,
        };
        edit(
            bot,
            reply_to,
            &format!("🎧 fetched {} tracks — matching…", tracks.len()),
        )
        .await;

        let lib = library.lock().await;
        let results = matcher::match_playlist(&tracks, &lib, &cfg.matcher);
        drop(lib);

        let import = rekordbox::import_matches(&cfg.rekordbox.autoimport_dir, &results)?;

        let usb_mount: Option<PathBuf> = cfg.usb.mount.clone();
        let usb_res = usb::sync(&cfg.rekordbox.autoimport_dir, usb_mount.as_deref())?;

        let summary = render_summary(&results, import.copied, &usb_res.skipped_reason);
        edit(bot, reply_to, &summary).await;

        let misses = results
            .into_iter()
            .filter(|m| matches!(m, MatchResult::Miss { .. }))
            .collect::<Vec<_>>();
        Ok(Some(misses))
    }

    async fn do_scan(
        bot: &Bot,
        cfg: &Config,
        library: &Mutex<LibraryIndex>,
        reply_to: &ReplyHandle,
    ) -> anyhow::Result<Option<Vec<MatchResult>>> {
        let new_idx = LibraryIndex::build(&cfg.library.roots)?;
        let count = new_idx.len();
        *library.lock().await = new_idx;
        edit(bot, reply_to, &format!("✅ rescanned — {count} tracks indexed")).await;
        Ok(None)
    }

    async fn do_missing(
        bot: &Bot,
        last: &[MatchResult],
        reply_to: &ReplyHandle,
    ) -> anyhow::Result<Option<Vec<MatchResult>>> {
        if last.is_empty() {
            edit(bot, reply_to, "no recent misses").await;
            return Ok(None);
        }
        let mut out = String::from("missing from last run:\n");
        for m in last {
            if let MatchResult::Miss { spotify, reason } = m {
                out.push_str(&format!(
                    "• {} — {} ({})\n",
                    spotify.artist,
                    spotify.title,
                    match reason {
                        MissReason::NotInLibrary => "not in library",
                        MissReason::AmbiguousFuzzy => "ambiguous",
                        MissReason::AiUncertain => "ai uncertain",
                    }
                ));
            }
        }
        edit(bot, reply_to, &out).await;
        Ok(None)
    }

    async fn edit(bot: &Bot, reply_to: &ReplyHandle, text: &str) {
        let _ = bot
            .edit_message_text(reply_to.chat_id, reply_to.status_message_id, text)
            .await;
    }

    fn render_summary(
        results: &[MatchResult],
        copied: usize,
        usb_skipped: &Option<String>,
    ) -> String {
        let total = results.len();
        let mut isrc = 0;
        let mut fuzzy = 0;
        let mut ai = 0;
        let mut miss = 0;
        for r in results {
            match r {
                MatchResult::Hit { confidence, .. } => match confidence {
                    Confidence::Isrc => isrc += 1,
                    Confidence::FuzzyHigh | Confidence::FuzzyLow => fuzzy += 1,
                    Confidence::AiAssisted => ai += 1,
                },
                MatchResult::Miss { .. } => miss += 1,
            }
        }
        let matched = isrc + fuzzy + ai;
        let mut out = format!(
            "✅ {total} tracks processed\n✅ {matched} matched ({isrc} ISRC · {fuzzy} fuzzy · {ai} AI)\n"
        );
        if miss > 0 {
            out.push_str(&format!("❌ {miss} missing — see /missing\n"));
        }
        out.push_str(&format!("🎧 {copied} copied to Rekordbox\n"));
        if let Some(reason) = usb_skipped {
            out.push_str(&format!("💾 USB skipped: {reason}\n"));
        }
        out
    }
}
