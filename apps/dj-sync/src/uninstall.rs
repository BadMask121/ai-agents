//! `dj-sync uninstall [--delete-backups]`: remove DJ Sync from this Mac
//! (docs/superpowers/specs/2026-10-28-dj-sync-uninstaller-design.md §1). The
//! menu app's Uninstall button and the FAQ's Terminal command both run it.
//!
//! Order matters:
//! 1. Stop the service first. A running service that the cloud forgets
//!    re-registers on its next 401 and writes a new `cloud.json`.
//! 2. Ask the cloud to forget this Mac (`DELETE /v2/agent`). Offline is only a
//!    warning: the cloud drops DJs after 90 days without use.
//! 3. Keep the library backups in `~/Music/DJ Sync Backups` (or delete them).
//! 4. Delete `~/.dj-sync`.
//! 5. Remove the menu app's preferences, caches, logs and permissions.
//!
//! Never touched: the download folders, Rekordbox's library and its import
//! XML. Every step skips what's already gone, so running it again is harmless.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::Context;
use tokio::sync::watch;
use tracing::warn;

use crate::cloud_v2::{Credentials, TENANT_HEADER};

/// The service's LaunchAgent label (the menu app's `ServiceInstaller`).
pub const SERVICE_LABEL: &str = "com.triplejmusic.dj-sync";
/// The menu app's bundle id.
pub const MENU_BUNDLE_ID: &str = "com.triplejmusic.dj-sync.menu";

const USAGE: &str = "usage: dj-sync uninstall [--delete-backups]

Removes DJ Sync from this Mac: stops the background service, asks the DJ Sync
cloud to forget this Mac, and deletes ~/.dj-sync and DJ Sync's preferences,
caches and logs. Library backups are moved to ~/Music/DJ Sync Backups unless
--delete-backups is given. Your music and Rekordbox library stay as they are.";

const RESTORE_NOTE: &str = "DJ Sync library backups

Each master.v<version>.db is a copy of your Rekordbox library from around a
change DJ Sync made; index.json says which change. The oldest one is your
library from before DJ Sync's first change.

To put one back:
1. Quit Rekordbox.
2. In Finder, choose Go > Go to Folder... and enter ~/Library/Pioneer/rekordbox
3. Rename master.db to master.before-restore.db, so you keep it. Move
   master.db-wal and master.db-shm aside too, if they're there.
4. Copy the backup you want into that folder and rename the copy master.db.
5. Open Rekordbox.
";

/// Everything DJ Sync puts on a Mac, from the home folder.
pub struct Paths {
    pub home: PathBuf,
}

impl Paths {
    pub fn state_dir(&self) -> PathBuf {
        self.home.join(".dj-sync")
    }

    pub fn launch_agent(&self) -> PathBuf {
        self.home
            .join(format!("Library/LaunchAgents/{SERVICE_LABEL}.plist"))
    }

    pub fn kept_backups(&self) -> PathBuf {
        self.home.join("Music/DJ Sync Backups")
    }

    /// The menu app's caches and the service's logs.
    pub fn leftovers(&self) -> Vec<PathBuf> {
        [
            format!("Library/Caches/{MENU_BUNDLE_ID}"),
            "Library/Caches/dj-sync-menu".into(),
            format!("Library/HTTPStorages/{MENU_BUNDLE_ID}"),
            "Library/Logs/dj-sync.log".into(),
            "Library/Logs/dj-sync.out.log".into(),
        ]
        .into_iter()
        .map(|p| self.home.join(p))
        .collect()
    }

    /// What must be gone afterwards.
    fn inventory(&self) -> Vec<PathBuf> {
        let mut all = vec![self.state_dir(), self.launch_agent()];
        all.extend(self.leftovers());
        all
    }

    /// `~/…` for people.
    fn show(&self, path: &Path) -> String {
        match path.strip_prefix(&self.home) {
            Ok(rest) => format!("~/{}", rest.display()),
            Err(_) => path.display().to_string(),
        }
    }
}

/// What the uninstall asks of the outside world (tests use a fake).
#[allow(async_fn_in_trait)]
pub trait System {
    /// Run a command (`launchctl`, `defaults`, `tccutil`); its exit code.
    fn run(&self, program: &str, args: &[&str]) -> i32;
    /// `DELETE {base_url}/v2/agent`: the HTTP status, or why it failed.
    async fn forget(&self, creds: &Credentials) -> Result<u16, String>;
    /// This user's id, for `launchctl bootout gui/<uid>/…`.
    fn uid(&self) -> u32;
}

#[derive(Debug, Default, Clone)]
pub struct Options {
    pub delete_backups: bool,
}

#[derive(Debug, Default)]
pub struct Report {
    /// One line per step, for people.
    pub lines: Vec<String>,
    /// Inventory paths still there afterwards.
    pub left: Vec<PathBuf>,
}

impl Report {
    pub fn ok(&self) -> bool {
        self.left.is_empty()
    }
}

pub async fn uninstall(
    paths: &Paths,
    sys: &impl System,
    opts: &Options,
    now: chrono::DateTime<chrono::Local>,
) -> Report {
    let mut r = Report::default();
    let mut say = |line: String| r.lines.push(line);

    // 1. The service.
    let plist = paths.launch_agent();
    if plist.exists() {
        match std::fs::remove_file(&plist) {
            Ok(()) => say(format!(
                "removed the background service's startup entry ({})",
                paths.show(&plist)
            )),
            Err(e) => say(format!("couldn't remove {}: {e}", paths.show(&plist))),
        }
    }
    let target = format!("gui/{}/{SERVICE_LABEL}", sys.uid());
    if sys.run("launchctl", &["bootout", &target]) == 0 {
        say("stopped the background service".into());
    } else {
        say("the background service wasn't running".into());
    }

    // 2. The cloud.
    let state = paths.state_dir();
    match std::fs::read(state.join("cloud.json"))
        .ok()
        .and_then(|raw| serde_json::from_slice::<Credentials>(&raw).ok())
    {
        None => say("this Mac wasn't connected to the DJ Sync cloud".into()),
        Some(creds) => match sys.forget(&creds).await {
            Ok(204) | Ok(404) => say("the DJ Sync cloud forgot this Mac".into()),
            Ok(status) => say(format!(
                "warning: the DJ Sync cloud answered {status}; it deletes this Mac's data after 90 days without use"
            )),
            Err(e) => say(format!(
                "warning: couldn't reach the DJ Sync cloud ({e}); it deletes this Mac's data after 90 days without use"
            )),
        },
    }

    // 3. Library backups.
    let backups = state.join("rekordbox-backups");
    if has_entries(&backups) {
        if opts.delete_backups {
            match std::fs::remove_dir_all(&backups) {
                Ok(()) => say("deleted the library backups".into()),
                Err(e) => say(format!("couldn't delete the library backups: {e}")),
            }
        } else {
            let mut dest = paths.kept_backups();
            if dest.exists() {
                dest = dest.join(now.format("%Y-%m-%d %H%M").to_string());
            }
            match keep_backups(&backups, &dest) {
                Ok(()) => say(format!(
                    "moved the library backups to {}",
                    paths.show(&dest)
                )),
                Err(e) => say(format!(
                    "couldn't move the library backups to {}: {e:#}",
                    paths.show(&dest)
                )),
            }
        }
    }

    // 4. Everything else DJ Sync keeps.
    if state.exists() {
        match std::fs::remove_dir_all(&state) {
            Ok(()) => say(format!(
                "deleted {} (tools, settings and connections)",
                paths.show(&state)
            )),
            Err(e) => say(format!("couldn't delete {}: {e}", paths.show(&state))),
        }
    }

    // 5. The menu app's leftovers.
    sys.run("defaults", &["delete", MENU_BUNDLE_ID]);
    for path in paths.leftovers() {
        let removed = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(e) = removed {
            if e.kind() != std::io::ErrorKind::NotFound {
                say(format!("couldn't remove {}: {e}", paths.show(&path)));
            }
        }
    }
    sys.run("tccutil", &["reset", "All", MENU_BUNDLE_ID]);
    say("removed DJ Sync's preferences, caches, logs and permissions".into());

    r.left = paths
        .inventory()
        .into_iter()
        .filter(|p| p.exists())
        .collect();
    r
}

fn has_entries(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|mut rd| rd.next().is_some())
        .unwrap_or(false)
}

/// Move the backups to `dest` (copying across volumes) and add the restore note.
fn keep_backups(src: &Path, dest: &Path) -> anyhow::Result<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::rename(src, dest).is_err() {
        copy_dir(src, dest).context("copying")?;
        std::fs::remove_dir_all(src)?;
    }
    std::fs::write(dest.join("How to restore.txt"), RESTORE_NOTE)?;
    Ok(())
}

fn copy_dir(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

/// The real Mac.
pub struct MacSystem {
    home: PathBuf,
    http: reqwest::Client,
}

impl MacSystem {
    pub fn new(home: PathBuf) -> Self {
        Self {
            home,
            http: reqwest::Client::new(),
        }
    }
}

impl System for MacSystem {
    fn run(&self, program: &str, args: &[&str]) -> i32 {
        std::process::Command::new(program)
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .ok()
            .and_then(|s| s.code())
            .unwrap_or(-1)
    }

    async fn forget(&self, creds: &Credentials) -> Result<u16, String> {
        let url = format!("{}/v2/agent", creds.base_url.trim_end_matches('/'));
        self.http
            .delete(url)
            .bearer_auth(&creds.agent_token)
            .header(TENANT_HEADER, &creds.tenant_id)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map(|res| res.status().as_u16())
            .map_err(|e| e.without_url().to_string())
    }

    fn uid(&self) -> u32 {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(&self.home)
            .map(|m| m.uid())
            .unwrap_or(501)
    }
}

// ---------- the app was dragged to the Bin (spec §3) ----------

/// How long the app may be gone before the service stops itself.
pub const APP_GONE_AFTER: Duration = Duration::from_secs(10 * 60);
const WATCH_EVERY: Duration = Duration::from_secs(60);

/// Notices the DJ Sync app is gone. Updates swap the bundle in place, so its
/// path never goes missing for long; an app moved elsewhere rewrites
/// `app_path` the next time it opens.
#[derive(Debug, Default)]
pub struct AppWatch {
    missing_since: Option<Instant>,
}

impl AppWatch {
    /// `true` once `app_path` has been missing for [`APP_GONE_AFTER`]. Never
    /// without an `app_path` (older apps, or dj-sync run from source).
    pub fn check(
        &mut self,
        app_path: Option<&Path>,
        exists: impl Fn(&Path) -> bool,
        now: Instant,
    ) -> bool {
        match app_path {
            Some(app) if !exists(app) => {
                let since = *self.missing_since.get_or_insert(now);
                now.duration_since(since) >= APP_GONE_AFTER
            }
            _ => {
                self.missing_since = None;
                false
            }
        }
    }
}

/// Stop the service for good, keeping its data: remove its startup entry,
/// then unload it (which ends this process). Opening the app reinstalls it.
pub fn stop_service(paths: &Paths, sys: &impl System) {
    let _ = std::fs::remove_file(paths.launch_agent());
    sys.run(
        "launchctl",
        &["bootout", &format!("gui/{}/{SERVICE_LABEL}", sys.uid())],
    );
}

/// The service's watchdog: checks `app_path` in `settings.json` every minute.
pub async fn watch_app(settings_file: PathBuf, home: PathBuf, mut shutdown: watch::Receiver<bool>) {
    let mut watch = AppWatch::default();
    loop {
        tokio::select! {
            _ = shutdown.wait_for(|s| *s) => return,
            _ = tokio::time::sleep(WATCH_EVERY) => {}
        }
        let app = crate::settings::Settings::load_from(&settings_file).app_path;
        if watch.check(app.as_deref(), Path::exists, Instant::now()) {
            warn!(
                app = %app.as_deref().unwrap_or(Path::new("")).display(),
                "the DJ Sync app is gone; stopping the service (data kept)"
            );
            let paths = Paths { home: home.clone() };
            let _ = tokio::task::spawn_blocking(move || {
                stop_service(&paths, &MacSystem::new(paths.home.clone()))
            })
            .await;
            return;
        }
    }
}

/// `dj-sync uninstall …` from `main`. Exits 1 if anything is left.
pub async fn cli(args: &[String]) -> anyhow::Result<()> {
    let mut opts = Options::default();
    for arg in args {
        match arg.as_str() {
            "--delete-backups" => opts.delete_backups = true,
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(());
            }
            other => anyhow::bail!("unknown option {other}\n\n{USAGE}"),
        }
    }
    let home = dirs::home_dir().context("could not resolve home directory")?;
    let paths = Paths { home: home.clone() };
    let report = uninstall(&paths, &MacSystem::new(home), &opts, chrono::Local::now()).await;
    for line in &report.lines {
        println!("{line}");
    }
    if report.ok() {
        println!("removed DJ Sync");
        Ok(())
    } else {
        for path in &report.left {
            eprintln!("still there: {}", paths.show(path));
        }
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Fake {
        forget: Result<u16, String>,
        events: Mutex<Vec<String>>,
    }

    impl Fake {
        fn new(forget: Result<u16, String>) -> Self {
            Self {
                forget,
                events: Mutex::new(Vec::new()),
            }
        }
        fn events(&self) -> Vec<String> {
            self.events.lock().unwrap().clone()
        }
    }

    impl System for Fake {
        fn run(&self, program: &str, args: &[&str]) -> i32 {
            self.events
                .lock()
                .unwrap()
                .push(format!("{program} {}", args.join(" ")));
            0
        }
        async fn forget(&self, creds: &Credentials) -> Result<u16, String> {
            self.events
                .lock()
                .unwrap()
                .push(format!("forget {}", creds.tenant_id));
            self.forget.clone()
        }
        fn uid(&self) -> u32 {
            501
        }
    }

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    /// A home folder with DJ Sync installed, plus music and Rekordbox files
    /// that must survive.
    fn installed() -> (tempfile::TempDir, Paths) {
        let tmp = tempfile::tempdir().unwrap();
        let p = Paths {
            home: tmp.path().to_path_buf(),
        };
        let s = p.state_dir();
        write(
            &s.join("cloud.json"),
            r#"{"base_url":"https://djsync.example","tenant_id":"t1","agent_token":"djsa_x"}"#,
        );
        write(&s.join("links.json"), "[]");
        write(&s.join("bin/dj-sync"), "binary");
        write(&s.join("tools/uv/1.0/uv"), "tool");
        write(&s.join("rekordbox-backups/master.v1.0.0.db"), "pristine");
        write(&s.join("rekordbox-backups/index.json"), "{}");
        write(&p.launch_agent(), "<plist/>");
        for leftover in p.leftovers() {
            if leftover.extension().is_some_and(|e| e == "log") {
                write(&leftover, "log");
            } else {
                write(&leftover.join("x"), "cache");
            }
        }
        write(&p.home.join("Music/DJ_Downloads/song.mp3"), "music");
        write(
            &p.home.join("Library/Pioneer/rekordbox/master.db"),
            "library",
        );
        write(
            &p.home.join("Library/rekordbox/rekordbox/rekordbox.xml"),
            "<xml/>",
        );
        (tmp, p)
    }

    fn now() -> chrono::DateTime<chrono::Local> {
        chrono::DateTime::parse_from_rfc3339("2026-10-28T18:30:00Z")
            .unwrap()
            .with_timezone(&chrono::Local)
    }

    fn untouched(p: &Paths) {
        for (path, body) in [
            ("Music/DJ_Downloads/song.mp3", "music"),
            ("Library/Pioneer/rekordbox/master.db", "library"),
            ("Library/rekordbox/rekordbox/rekordbox.xml", "<xml/>"),
        ] {
            assert_eq!(
                std::fs::read_to_string(p.home.join(path)).unwrap(),
                body,
                "{path}"
            );
        }
    }

    #[tokio::test]
    async fn removes_everything_keeps_backups_and_never_touches_music_or_rekordbox() {
        let (_tmp, p) = installed();
        let sys = Fake::new(Ok(204));
        let r = uninstall(&p, &sys, &Options::default(), now()).await;

        assert!(r.ok(), "left: {:?}", r.left);
        let kept = p.kept_backups();
        assert_eq!(
            std::fs::read_to_string(kept.join("master.v1.0.0.db")).unwrap(),
            "pristine"
        );
        assert!(kept.join("index.json").exists());
        assert!(std::fs::read_to_string(kept.join("How to restore.txt"))
            .unwrap()
            .contains("Quit Rekordbox"));
        untouched(&p);
        // The service stops before the cloud forgets the Mac (else it re-registers).
        assert_eq!(
            sys.events(),
            [
                "launchctl bootout gui/501/com.triplejmusic.dj-sync",
                "forget t1",
                "defaults delete com.triplejmusic.dj-sync.menu",
                "tccutil reset All com.triplejmusic.dj-sync.menu",
            ]
        );
        assert!(r
            .lines
            .iter()
            .any(|l| l == "the DJ Sync cloud forgot this Mac"));
        assert!(r
            .lines
            .iter()
            .any(|l| l == "moved the library backups to ~/Music/DJ Sync Backups"));
    }

    #[tokio::test]
    async fn running_it_again_is_harmless() {
        let (_tmp, p) = installed();
        uninstall(&p, &Fake::new(Ok(204)), &Options::default(), now()).await;
        let sys = Fake::new(Ok(204));
        let again = uninstall(&p, &sys, &Options::default(), now()).await;
        assert!(again.ok());
        assert!(
            !sys.events().iter().any(|e| e.starts_with("forget")),
            "no cloud.json, no call"
        );
        assert!(again
            .lines
            .iter()
            .any(|l| l == "this Mac wasn't connected to the DJ Sync cloud"));
        assert!(
            !p.kept_backups().join("2026-10-28 1830").exists(),
            "nothing new to keep"
        );
        untouched(&p);
    }

    #[tokio::test]
    async fn delete_backups_deletes_them() {
        let (_tmp, p) = installed();
        let opts = Options {
            delete_backups: true,
        };
        let r = uninstall(&p, &Fake::new(Ok(204)), &opts, now()).await;
        assert!(r.ok());
        assert!(!p.kept_backups().exists());
        assert!(r.lines.iter().any(|l| l == "deleted the library backups"));
    }

    #[tokio::test]
    async fn earlier_kept_backups_get_a_dated_folder_beside_them() {
        let (_tmp, p) = installed();
        write(&p.kept_backups().join("master.v9.0.0.db"), "older");
        let r = uninstall(&p, &Fake::new(Ok(204)), &Options::default(), now()).await;
        assert!(r.ok());
        let stamp = now().format("%Y-%m-%d %H%M").to_string();
        let dated = p.kept_backups().join(&stamp);
        assert_eq!(
            std::fs::read_to_string(dated.join("master.v1.0.0.db")).unwrap(),
            "pristine"
        );
        assert_eq!(
            std::fs::read_to_string(p.kept_backups().join("master.v9.0.0.db")).unwrap(),
            "older"
        );
    }

    #[test]
    fn the_watchdog_stops_after_ten_minutes_without_the_app() {
        let t0 = Instant::now();
        let at = |mins: u64| t0 + Duration::from_secs(mins * 60);
        let app = Path::new("/Applications/DJ Sync.app");
        let gone = |_: &Path| false;
        let there = |_: &Path| true;

        let mut w = AppWatch::default();
        assert!(!w.check(None, gone, at(0)), "no app_path: never");
        assert!(!w.check(None, gone, at(60)));
        assert!(!w.check(Some(app), gone, at(0)));
        assert!(!w.check(Some(app), gone, at(9)));
        assert!(!w.check(Some(app), there, at(9)), "back: the clock resets");
        assert!(!w.check(Some(app), gone, at(10)));
        assert!(!w.check(Some(app), gone, at(19)));
        assert!(w.check(Some(app), gone, at(20)));
    }

    #[test]
    fn stopping_the_service_keeps_its_data() {
        let (_tmp, p) = installed();
        let sys = Fake::new(Ok(204));
        stop_service(&p, &sys);
        assert!(!p.launch_agent().exists());
        assert!(p.state_dir().join("cloud.json").exists());
        assert!(p
            .state_dir()
            .join("rekordbox-backups/master.v1.0.0.db")
            .exists());
        assert_eq!(
            sys.events(),
            ["launchctl bootout gui/501/com.triplejmusic.dj-sync"]
        );
    }

    #[tokio::test]
    async fn an_unreachable_or_forgetful_cloud_only_warns() {
        for (answer, expect) in [
            (
                Err("timed out".to_string()),
                "warning: couldn't reach the DJ Sync cloud (timed out)",
            ),
            (Ok(500), "warning: the DJ Sync cloud answered 500"),
            (Ok(404), "the DJ Sync cloud forgot this Mac"),
        ] {
            let (_tmp, p) = installed();
            let r = uninstall(&p, &Fake::new(answer), &Options::default(), now()).await;
            assert!(r.ok(), "{expect}");
            assert!(
                r.lines.iter().any(|l| l.starts_with(expect)),
                "{expect}: {:?}",
                r.lines
            );
        }
    }
}
