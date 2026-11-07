//! Serato DJ's library. Serato has no API, so this writes the files it keeps
//! exporting for its own older versions: `database V2`, `Subcrates/*.crate`
//! and `neworder.pref` in `~/Music/_Serato_`. Its real library is SQLite
//! (`~/Library/Application Support/Serato/Library`), which is never written.
//!
//! How that works, proven on Serato DJ Pro 5.0.0 (docs/dj-sync/44-serato-library.md):
//!
//! - At launch Serato compares those files with the size and md5 it stored in
//!   `last_seen_dbv2_library`. Any difference triggers a re-import.
//! - The import replaces a crate's contents, so removing a track or a crate
//!   works, and so does losing one: anything the old format can't hold would
//!   be gone. [`preflight`] refuses to write when that could happen.
//! - Serato rewrites these files when it quits, so they're only written while
//!   it's closed. `dj_library.rs` queues everything until then.
//! - A track needs only a type and a path. Serato reads the tags and analyses
//!   the file itself.
//!
//! The format is reverse-engineered: records are a 4-byte ASCII tag, a 4-byte
//! big-endian length and the payload; text is UTF-16BE; paths have no leading
//! slash and are relative to the drive. Records this code doesn't know are
//! kept byte for byte.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::SystemTime;

use anyhow::{anyhow, bail, Context};
use md5::Md5;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tracing::warn;
use unicode_normalization::UnicodeNormalization;

use crate::config::SeratoCfg;
use crate::dj_library::{ApplyOutcome, Backend, DjLibrary};

const DATABASE: &str = "database V2";
const CRATES: &str = "Subcrates";
const ORDER: &str = "neworder.pref";
/// New crates go inside this one, like Rekordbox's DJ Sync folder.
const PARENT_CRATE: &str = "DJ Sync";
/// Separates a crate from its parent in file names and `neworder.pref`.
const NESTING: &str = "%%";
/// The only major version writes have been tested on.
const SUPPORTED_MAJOR: u64 = 5;
/// Spaces in Serato's database that hold files on this Mac. A crate track in
/// any other space (a streaming service, today) can't be written to a
/// `.crate` file, so a re-import might drop it.
const LOCAL_SPACES: &[&str] = &[
    "Serato Library",
    "iTunes",
    "iTunes_temp",
    "Stems",
    "Prepare",
    "Transfer",
    "Serato Video",
];
const PROCESS_NAMES: &[&str] = &["Serato DJ Pro", "Serato DJ Lite"];

type RunningCheck = Arc<dyn Fn() -> bool + Send + Sync>;

/// The real thing: Serato detected with `pgrep`.
pub fn library(cfg: SeratoCfg, state_dir: PathBuf) -> DjLibrary {
    library_with_parts(cfg, state_dir, Arc::new(serato_is_running))
}

pub fn library_with_parts(cfg: SeratoCfg, state_dir: PathBuf, running: RunningCheck) -> DjLibrary {
    let backend = Serato {
        cfg,
        state_dir: state_dir.clone(),
        running,
    };
    DjLibrary::new(Box::new(backend), state_dir)
}

pub fn serato_is_running() -> bool {
    PROCESS_NAMES.iter().any(|name| {
        Command::new("/usr/bin/pgrep")
            .args(["-x", name])
            .stdout(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

struct Serato {
    cfg: SeratoCfg,
    state_dir: PathBuf,
    running: RunningCheck,
}

impl Backend for Serato {
    fn app(&self) -> &'static str {
        "Serato"
    }

    fn key(&self) -> &'static str {
        "serato"
    }

    fn backup_name(&self) -> (&'static str, &'static str) {
        ("serato-library", "tar")
    }

    fn keep_backups(&self) -> usize {
        self.cfg.keep_backups
    }

    fn check_secs(&self) -> u64 {
        self.cfg.check_secs
    }

    fn running(&self) -> bool {
        (self.running)()
    }

    fn location(&self) -> PathBuf {
        self.cfg.root.clone()
    }

    /// The exported files as one tar, identical whenever they are, so the
    /// shared semver backups work on it like they do on Rekordbox's master.db.
    fn library_file(&self) -> anyhow::Result<PathBuf> {
        std::fs::create_dir_all(&self.state_dir)?;
        let file = self.state_dir.join("serato-library.tar");
        write_bundle(&self.cfg.root, &file)?;
        Ok(file)
    }

    fn apply(&self, ops: Vec<Value>, _own_dirs: &[PathBuf]) -> anyhow::Result<ApplyOutcome> {
        if self.running() {
            return Ok(ApplyOutcome::AppRunning);
        }
        preflight(&self.cfg)?;
        let mut workspace = Workspace::load(&self.cfg)?;
        let mut results = Vec::with_capacity(ops.len());
        for (i, op) in ops.iter().enumerate() {
            let kind = op.get("op").and_then(Value::as_str).unwrap_or("");
            let result = workspace
                .apply(kind, op)
                .with_context(|| format!("op {i} ({kind})"))?;
            results.push(result);
        }
        // Nothing has touched the disk yet, so a late launch costs nothing.
        if self.running() {
            return Ok(ApplyOutcome::AppRunning);
        }
        workspace.commit()?;
        Ok(ApplyOutcome::Done(
            json!({ "ok": true, "applied": ops.len(), "results": results }),
        ))
    }

    fn snapshot(&self) -> anyhow::Result<Value> {
        snapshot(&self.cfg)
    }

    fn change_stamp(&self) -> Option<SystemTime> {
        change_stamp(&self.cfg)
    }

    fn restored(&self, file: &Path) -> anyhow::Result<()> {
        unpack_bundle(file, &self.cfg.root)
    }

    fn restore_note(&self) -> &'static str {
        " Open Serato to load it."
    }
}

// ---------- the record format ----------

#[derive(Debug, Clone, PartialEq, Eq)]
struct Tag {
    name: [u8; 4],
    data: Vec<u8>,
}

impl Tag {
    fn text(name: &[u8; 4], value: &str) -> Self {
        Self {
            name: *name,
            data: value.encode_utf16().flat_map(u16::to_be_bytes).collect(),
        }
    }

    fn nested(name: &[u8; 4], children: &[Tag]) -> Self {
        Self {
            name: *name,
            data: encode_tags(children),
        }
    }

    fn as_text(&self) -> String {
        decode_text(&self.data)
    }

    fn children(&self) -> anyhow::Result<Vec<Tag>> {
        parse_tags(&self.data)
    }
}

fn decode_text(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

fn parse_tags(bytes: &[u8]) -> anyhow::Result<Vec<Tag>> {
    let mut tags = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let header = bytes
            .get(at..at + 8)
            .ok_or_else(|| anyhow!("record cut short at byte {at}"))?;
        let len = u32::from_be_bytes([header[4], header[5], header[6], header[7]]) as usize;
        let data = bytes
            .get(at + 8..at + 8 + len)
            .ok_or_else(|| anyhow!("record cut short at byte {at}"))?;
        tags.push(Tag {
            name: [header[0], header[1], header[2], header[3]],
            data: data.to_vec(),
        });
        at += 8 + len;
    }
    Ok(tags)
}

fn encode_tags(tags: &[Tag]) -> Vec<u8> {
    let mut out = Vec::with_capacity(tags.iter().map(|t| t.data.len() + 8).sum());
    for tag in tags {
        out.extend_from_slice(&tag.name);
        out.extend_from_slice(&(tag.data.len() as u32).to_be_bytes());
        out.extend_from_slice(&tag.data);
    }
    out
}

/// The header Serato gives a new crate.
fn new_crate() -> Vec<Tag> {
    let column = |name: &str| {
        Tag::nested(
            b"ovct",
            &[Tag::text(b"tvcn", name), Tag::text(b"tvcw", "0")],
        )
    };
    let mut tags = vec![
        Tag::text(b"vrsn", "1.0/Serato ScratchLive Crate"),
        Tag::nested(
            b"osrt",
            &[
                Tag::text(b"tvcn", "song"),
                Tag {
                    name: *b"brev",
                    data: vec![0],
                },
            ],
        ),
    ];
    tags.extend(
        [
            "song",
            "artist",
            "bpm",
            "key",
            "playCount",
            "album",
            "length",
            "comment",
        ]
        .map(column),
    );
    tags
}

/// The tracks of a crate, as stored.
fn crate_tracks(tags: &[Tag]) -> Vec<String> {
    tags.iter()
        .filter(|t| &t.name == b"otrk")
        .filter_map(|t| t.children().ok())
        .flat_map(|children| {
            children
                .into_iter()
                .filter(|c| &c.name == b"ptrk")
                .map(|c| c.as_text())
        })
        .collect()
}

fn crate_has(tags: &[Tag], path: &str) -> bool {
    let wanted = nfc(path);
    crate_tracks(tags).iter().any(|p| nfc(p) == wanted)
}

fn crate_entry(path: &str) -> Tag {
    Tag::nested(b"otrk", &[Tag::text(b"ptrk", path)])
}

fn database_entry(path: &str) -> Tag {
    let kind = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    Tag::nested(
        b"otrk",
        &[Tag::text(b"ttyp", &kind), Tag::text(b"pfil", path)],
    )
}

/// Paths are compared composed: macOS and Serato don't always agree.
fn nfc(s: &str) -> String {
    s.nfc().collect()
}

/// The id a track has in snapshots: its full path, hashed, so paths never
/// leave the Mac and the id survives Serato rewriting its files.
fn track_id(absolute: &str) -> String {
    let hash = Sha256::digest(nfc(absolute).as_bytes());
    hash.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn absolute(stored: &str) -> String {
    format!("/{stored}")
}

fn write_atomic(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!(".dj-sync-{name}.tmp"));
    std::fs::write(&tmp, bytes).with_context(|| format!("writing {}", tmp.display()))?;
    // Serato's own files are world-readable; a temp file's default may not be.
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644))?;
    std::fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

fn crate_files(root: &Path) -> anyhow::Result<Vec<(String, PathBuf)>> {
    let dir = root.join(CRATES);
    let mut files = Vec::new();
    match std::fs::read_dir(&dir) {
        Ok(entries) => {
            for entry in entries {
                let path = entry?.path();
                let is_crate = path.extension().is_some_and(|e| e == "crate");
                if let (true, Some(stem)) = (is_crate, path.file_stem()) {
                    files.push((stem.to_string_lossy().into_owned(), path.clone()));
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e).with_context(|| format!("reading {}", dir.display())),
    }
    files.sort();
    Ok(files)
}

// ---------- safety checks ----------

/// Refuse to write unless it's known to be safe. Any doubt is a refusal, with
/// a message the DJ can act on: the batch is set aside and can be retried.
pub fn preflight(cfg: &SeratoCfg) -> anyhow::Result<()> {
    check_version(cfg)?;
    let master = cfg.library_dir.join("master.sqlite");
    let root_db = cfg.library_dir.join("root.sqlite");
    anyhow::ensure!(
        master.is_file() && root_db.is_file() && cfg.root.join(DATABASE).is_file(),
        "Serato hasn't set up its library yet. Open Serato DJ Pro once, quit it, then try again."
    );
    // A clean quit folds the write-ahead log into the database. If one is left
    // the database isn't the whole story, and `sql` wouldn't see the rest.
    for db in [&master, &root_db] {
        let log = db.with_extension("sqlite-wal");
        if std::fs::metadata(&log).is_ok_and(|m| m.len() > 0) {
            bail!(
                "Serato didn't close cleanly, usually because it was force quit. Open Serato, \
                 quit it normally, then try again. Nothing was changed."
            );
        }
    }

    let status = sql(
        cfg,
        &root_db,
        "SELECT autosync_disabled AS off FROM dbv2_status",
    )?;
    if status.first().and_then(|r| r["off"].as_i64()) != Some(0) {
        bail!(
            "Serato's automatic library sync is off, so it wouldn't load DJ Sync's changes. \
             Nothing was changed."
        );
    }

    let outside = sql(
        cfg,
        &master,
        &format!(
            "SELECT DISTINCT c.name AS name
             FROM dj_container_metadata m
             JOIN container c ON c.id = m.container_id
             JOIN location_container lc ON lc.container_id = c.id
             JOIN container_asset ca ON ca.location_container_id = lc.id
             LEFT JOIN space_asset sa ON sa.id = ca.space_asset_id
             LEFT JOIN space s ON s.id = sa.space_id
             WHERE c.type = 1 AND (s.name IS NULL OR s.name NOT IN ({}))",
            LOCAL_SPACES
                .iter()
                .map(|s| format!("'{s}'"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    )?;
    if !outside.is_empty() {
        let names: Vec<&str> = outside.iter().filter_map(|r| r["name"].as_str()).collect();
        bail!(
            "Your Serato crates {} hold streaming tracks, and DJ Sync can't change a Serato \
             library like that yet without risking them. Nothing was changed.",
            names.join(", ")
        );
    }

    let seen: HashMap<String, String> = sql(
        cfg,
        &root_db,
        "SELECT filename AS file, lower(hex(md5_hash)) AS md5 FROM last_seen_dbv2_library",
    )?
    .iter()
    .filter_map(|r| {
        Some((
            r["file"].as_str()?.to_string(),
            r["md5"].as_str()?.to_string(),
        ))
    })
    .collect();
    let crates = sql(
        cfg,
        &root_db,
        "SELECT c.name AS name, m.filename AS file, count(ca.id) AS tracks
         FROM dj_container_metadata m
         JOIN container c ON c.id = m.container_id
         LEFT JOIN container_asset ca ON ca.container_id = m.container_id
         WHERE c.type = 1 AND (m.filename IS NULL OR m.filename LIKE '%.crate')
         GROUP BY m.container_id",
    )?;
    for row in &crates {
        let name = row["name"].as_str().unwrap_or("?");
        let expected = row["tracks"].as_u64().unwrap_or(0) as usize;
        check_crate(cfg, name, row["file"].as_str(), expected, &seen)?;
    }
    Ok(())
}

/// A crate in Serato's database must be fully in its exported file, or a
/// re-import would lose the difference. Files changed since Serato's export
/// are skipped: they're a write of ours Serato hasn't loaded yet.
fn check_crate(
    cfg: &SeratoCfg,
    name: &str,
    file: Option<&str>,
    expected: usize,
    seen: &HashMap<String, String>,
) -> anyhow::Result<()> {
    let out_of_date = || {
        anyhow!(
            "Serato's crate \"{name}\" isn't fully in its exported files, usually because Serato \
             was force quit. Open Serato, quit it normally, then try again. Nothing was changed."
        )
    };
    let file = file.ok_or_else(out_of_date)?;
    let key = format!("{CRATES}/{file}");
    let path = cfg.root.join(CRATES).join(file);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return if seen.contains_key(&key) {
                Ok(()) // deleted since the export: ours, waiting to load
            } else {
                Err(out_of_date())
            };
        }
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    let Some(stored) = seen.get(&key) else {
        return Ok(()); // created since the export
    };
    if md5_hex(&bytes) != *stored {
        return Ok(()); // changed since the export
    }
    let tracks = parse_tags(&bytes).with_context(|| format!("reading {}", path.display()))?;
    if crate_tracks(&tracks).len() != expected {
        return Err(out_of_date());
    }
    Ok(())
}

fn md5_hex(bytes: &[u8]) -> String {
    Md5::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn check_version(cfg: &SeratoCfg) -> anyhow::Result<()> {
    let version = installed_version(cfg).ok_or_else(|| {
        anyhow!("DJ Sync can't find Serato DJ Pro on this Mac. Nothing was changed.")
    })?;
    let major = version
        .split('.')
        .next()
        .and_then(|m| m.parse::<u64>().ok());
    if major != Some(SUPPORTED_MAJOR) {
        bail!(
            "DJ Sync works with Serato DJ Pro {SUPPORTED_MAJOR}, and this Mac has {version}. \
             Nothing was changed."
        );
    }
    Ok(())
}

/// The first Serato app on this Mac (Pro before Lite).
pub fn installed_version(cfg: &SeratoCfg) -> Option<String> {
    cfg.app_paths.iter().find_map(|app| {
        let info = plist::Value::from_file(app.join("Contents/Info.plist")).ok()?;
        info.as_dictionary()?
            .get("CFBundleShortVersionString")?
            .as_string()
            .map(str::to_string)
    })
}

/// A read-only query. A database that's missing a table this expects is an
/// error, which is how an unrecognised Serato schema ends up refused.
///
/// Serato's databases are in WAL mode, which a plain read-only open can't
/// read once the log files are gone. Opening as immutable can: this only runs
/// while Serato is closed, and `preflight` has checked no log was left behind.
fn sql(cfg: &SeratoCfg, db: &Path, query: &str) -> anyhow::Result<Vec<Value>> {
    let path = db.to_string_lossy();
    let uri = format!(
        "file:{}?immutable=1",
        utf8_percent_encode(&path, NON_ALPHANUMERIC)
    );
    let output = Command::new(&cfg.sqlite3_bin)
        .args(["-readonly", "-json"])
        .arg(uri)
        .arg(query)
        .output()
        .with_context(|| format!("running {}", cfg.sqlite3_bin.display()))?;
    if !output.status.success() {
        let why = String::from_utf8_lossy(&output.stderr);
        warn!(db = %db.display(), error = %why.trim(), "couldn't read Serato's database");
        bail!(
            "DJ Sync doesn't recognise this Serato library, so nothing was changed. ({})",
            why.trim()
        );
    }
    if output.stdout.iter().all(u8::is_ascii_whitespace) {
        return Ok(Vec::new());
    }
    serde_json::from_slice(&output.stdout).context("reading Serato's database")
}

// ---------- changes ----------

/// The library in memory. Ops change this; only `commit` touches the disk, so
/// a batch that fails halfway leaves Serato's files as they were.
struct Workspace {
    root: PathBuf,
    volumes_dir: PathBuf,
    database: Vec<Tag>,
    /// Composed path → path as stored.
    tracks: HashMap<String, String>,
    /// Snapshot id → path as stored.
    ids: HashMap<String, String>,
    database_changed: bool,
    /// Crate file stem → records.
    crates: BTreeMap<String, Vec<Tag>>,
    changed: BTreeSet<String>,
    removed: BTreeSet<String>,
    /// Lines of `neworder.pref`.
    order: Vec<String>,
    order_changed: bool,
}

impl Workspace {
    fn load(cfg: &SeratoCfg) -> anyhow::Result<Self> {
        let root = cfg.root.clone();
        let path = root.join(DATABASE);
        let bytes = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
        let database = parse_tags(&bytes).with_context(|| format!("reading {}", path.display()))?;
        let mut crates = BTreeMap::new();
        for (stem, path) in crate_files(&root)? {
            let bytes = std::fs::read(&path)?;
            let tags = parse_tags(&bytes).with_context(|| format!("reading {}", path.display()))?;
            crates.insert(stem, tags);
        }
        let order = match std::fs::read(root.join(ORDER)) {
            Ok(bytes) => decode_text(&bytes).lines().map(str::to_string).collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e).context("reading neworder.pref"),
        };
        let mut workspace = Self {
            root,
            volumes_dir: cfg.volumes_dir.clone(),
            database,
            tracks: HashMap::new(),
            ids: HashMap::new(),
            database_changed: false,
            crates,
            changed: BTreeSet::new(),
            removed: BTreeSet::new(),
            order,
            order_changed: false,
        };
        let stored: Vec<String> = workspace
            .database
            .iter()
            .filter(|t| &t.name == b"otrk")
            .filter_map(|t| t.children().ok())
            .flatten()
            .filter(|c| &c.name == b"pfil")
            .map(|c| c.as_text())
            .collect();
        for path in stored {
            workspace.remember(path);
        }
        Ok(workspace)
    }

    fn remember(&mut self, stored: String) {
        self.ids
            .insert(track_id(&absolute(&stored)), stored.clone());
        self.tracks.insert(nfc(&stored), stored);
    }

    fn apply(&mut self, kind: &str, op: &Value) -> anyhow::Result<Value> {
        match kind {
            "add_track" => self.add_track(op),
            "ensure_playlist" => self.ensure_crate(op),
            "add_to_playlist" => self.add_to_crate(op),
            "remove_from_playlist" => self.remove_from_crate(op),
            "rename_playlist" => self.rename_crate(op),
            "delete_playlist" => self.delete_crate(op),
            other => bail!("unknown op {other:?}"),
        }
    }

    /// `/Users/me/a.mp3` → `Users/me/a.mp3`. Serato keeps tracks on another
    /// drive in that drive's own `_Serato_` folder, which is read but never
    /// written: only this Mac's own disk has been tested.
    fn stored_path(&self, path: &str) -> anyhow::Result<String> {
        if Path::new(path).starts_with(&self.volumes_dir) {
            bail!("DJ Sync can't change Serato crates on an external drive yet: {path}");
        }
        path.strip_prefix('/')
            .map(str::to_string)
            .ok_or_else(|| anyhow!("not a full path: {path}"))
    }

    fn add_track(&mut self, op: &Value) -> anyhow::Result<Value> {
        let path = op["path"]
            .as_str()
            .ok_or_else(|| anyhow!("op needs `path`"))?;
        let stored = self.stored_path(path)?;
        let id = track_id(path);
        if self.tracks.contains_key(&nfc(&stored)) {
            return Ok(json!({ "content_id": id, "created": false }));
        }
        anyhow::ensure!(Path::new(path).is_file(), "file not found: {path}");
        self.database.push(database_entry(&stored));
        self.database_changed = true;
        self.remember(stored);
        Ok(json!({ "content_id": id, "created": true }))
    }

    /// The stored path an op means, if Serato has that track.
    fn track_of(&self, op: &Value) -> anyhow::Result<Option<String>> {
        if let Some(id) = op["content_id"].as_str() {
            return Ok(self.ids.get(id).cloned());
        }
        let path = op["path"]
            .as_str()
            .ok_or_else(|| anyhow!("op needs `path` or `content_id`"))?;
        let stored = self.stored_path(path)?;
        Ok(self.tracks.get(&nfc(&stored)).cloned())
    }

    /// The crate an op means: the pinned one, then an exact name (the one in
    /// the DJ Sync crate if names repeat), then any case.
    fn find_crate(&self, name: &str, pinned: Option<&str>) -> Option<String> {
        if let Some(id) = pinned.filter(|id| self.crates.contains_key(*id)) {
            return Some(id.to_string());
        }
        let wanted = crate_name(name).ok()?;
        let own = format!("{PARENT_CRATE}{NESTING}{wanted}");
        if self.crates.contains_key(&own) {
            return Some(own);
        }
        let leaf = |stem: &&String| leaf_of(stem.as_str()).to_string();
        self.crates
            .keys()
            .find(|s| leaf(s) == wanted)
            .or_else(|| {
                self.crates
                    .keys()
                    .find(|s| leaf(s).eq_ignore_ascii_case(&wanted))
            })
            .cloned()
    }

    fn require_crate(&self, op: &Value, key: &str) -> anyhow::Result<String> {
        let name = op[key].as_str().unwrap_or_default();
        self.find_crate(name, op["playlist_id"].as_str())
            .ok_or_else(|| anyhow!("no crate named {name:?}"))
    }

    fn add_new_crate(&mut self, stem: &str) {
        self.crates.insert(stem.to_string(), new_crate());
        self.changed.insert(stem.to_string());
        self.removed.remove(stem);
        self.order_insert(stem);
    }

    fn ensure_crate(&mut self, op: &Value) -> anyhow::Result<Value> {
        let name = op["name"]
            .as_str()
            .ok_or_else(|| anyhow!("op needs `name`"))?;
        if let Some(stem) = self.find_crate(name, op["playlist_id"].as_str()) {
            return Ok(json!({ "playlist_id": stem, "created": false }));
        }
        if !self.crates.contains_key(PARENT_CRATE) {
            self.add_new_crate(PARENT_CRATE);
        }
        let stem = format!("{PARENT_CRATE}{NESTING}{}", crate_name(name)?);
        self.add_new_crate(&stem);
        Ok(json!({ "playlist_id": stem, "created": true }))
    }

    fn add_to_crate(&mut self, op: &Value) -> anyhow::Result<Value> {
        let stem = self.require_crate(op, "playlist")?;
        let Some(track) = self.track_of(op)? else {
            bail!(
                "track isn't in this Mac's Serato library: {}",
                op["path"]
                    .as_str()
                    .or(op["content_id"].as_str())
                    .unwrap_or("?")
            );
        };
        let tags = self.crates.get_mut(&stem).expect("found above");
        if crate_has(tags, &track) {
            return Ok(json!({ "added": false }));
        }
        tags.push(crate_entry(&track));
        self.changed.insert(stem);
        Ok(json!({ "added": true }))
    }

    fn remove_from_crate(&mut self, op: &Value) -> anyhow::Result<Value> {
        let stem = self.require_crate(op, "playlist")?;
        let Some(track) = self.track_of(op)? else {
            return Ok(json!({ "removed": false }));
        };
        let wanted = nfc(&track);
        let tags = self.crates.get_mut(&stem).expect("found above");
        let before = tags.len();
        // Compared record by record: only the track's own entry goes.
        tags.retain(|t| {
            !(&t.name == b"otrk"
                && crate_tracks(std::slice::from_ref(t))
                    .iter()
                    .any(|p| nfc(p) == wanted))
        });
        if tags.len() == before {
            return Ok(json!({ "removed": false }));
        }
        self.changed.insert(stem);
        Ok(json!({ "removed": true }))
    }

    fn rename_crate(&mut self, op: &Value) -> anyhow::Result<Value> {
        let stem = self.require_crate(op, "name")?;
        let new_name = crate_name(
            op["new_name"]
                .as_str()
                .ok_or_else(|| anyhow!("op needs `new_name`"))?,
        )?;
        if leaf_of(&stem) == new_name {
            return Ok(json!({ "renamed": false }));
        }
        let new_stem = match stem.rsplit_once(NESTING) {
            Some((parent, _)) => format!("{parent}{NESTING}{new_name}"),
            None => new_name,
        };
        let taken = self
            .crates
            .keys()
            .any(|s| s.eq_ignore_ascii_case(&new_stem));
        anyhow::ensure!(!taken, "a crate named {new_stem:?} already exists");
        // Children are named after their parents.
        let prefix = format!("{stem}{NESTING}");
        let moved: Vec<String> = self
            .crates
            .keys()
            .filter(|s| **s == stem || s.starts_with(&prefix))
            .cloned()
            .collect();
        for old in moved {
            let renamed = format!("{new_stem}{}", &old[stem.len()..]);
            let tags = self.crates.remove(&old).expect("listed above");
            self.crates.insert(renamed.clone(), tags);
            self.changed.remove(&old);
            self.changed.insert(renamed.clone());
            self.removed.insert(old.clone());
            self.removed.remove(&renamed);
            self.order_rename(&old, &renamed);
        }
        Ok(json!({ "renamed": true }))
    }

    fn delete_crate(&mut self, op: &Value) -> anyhow::Result<Value> {
        let name = op["name"].as_str().unwrap_or_default();
        let Some(stem) = self.find_crate(name, op["playlist_id"].as_str()) else {
            return Ok(json!({ "deleted": false }));
        };
        let prefix = format!("{stem}{NESTING}");
        anyhow::ensure!(
            !self.crates.keys().any(|s| s.starts_with(&prefix)),
            "the crate {name:?} has crates inside it, so DJ Sync won't delete it"
        );
        self.crates.remove(&stem);
        self.changed.remove(&stem);
        self.removed.insert(stem.clone());
        self.order_remove(&stem);
        Ok(json!({ "deleted": true }))
    }

    fn order_insert(&mut self, stem: &str) {
        let line = format!("[crate]{stem}");
        if self.order.contains(&line) {
            return;
        }
        if self.order.is_empty() {
            self.order.push("[begin record]".into());
            self.order.push("[end record]".into());
        }
        let at = self
            .order
            .iter()
            .rposition(|l| l == "[end record]")
            .unwrap_or(self.order.len());
        self.order.insert(at, line);
        self.order_changed = true;
    }

    fn order_remove(&mut self, stem: &str) {
        let line = format!("[crate]{stem}");
        let before = self.order.len();
        self.order.retain(|l| *l != line);
        self.order_changed |= self.order.len() != before;
    }

    fn order_rename(&mut self, old: &str, new: &str) {
        let (old, new) = (format!("[crate]{old}"), format!("[crate]{new}"));
        for line in &mut self.order {
            if *line == old {
                line.clone_from(&new);
                self.order_changed = true;
            }
        }
    }

    fn commit(&self) -> anyhow::Result<()> {
        let dir = self.root.join(CRATES);
        std::fs::create_dir_all(&dir)?;
        for stem in &self.changed {
            let tags = self.crates.get(stem).expect("changed crates exist");
            write_atomic(&dir.join(format!("{stem}.crate")), &encode_tags(tags))?;
        }
        for stem in &self.removed {
            let path = dir.join(format!("{stem}.crate"));
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e).with_context(|| format!("removing {}", path.display())),
            }
        }
        if self.database_changed {
            write_atomic(&self.root.join(DATABASE), &encode_tags(&self.database))?;
        }
        if self.order_changed {
            let mut text = self.order.join("\n");
            text.push('\n');
            write_atomic(&self.root.join(ORDER), &Tag::text(b"text", &text).data)?;
        }
        Ok(())
    }
}

fn leaf_of(stem: &str) -> &str {
    stem.rsplit(NESTING).next().unwrap_or(stem)
}

/// A playlist name as a crate file name: `/` can't be in one, and `%%` would
/// read as nesting.
fn crate_name(name: &str) -> anyhow::Result<String> {
    let cleaned: String = name
        .replace(NESTING, "%")
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':') || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim();
    anyhow::ensure!(
        !cleaned.is_empty(),
        "that's not a usable crate name: {name:?}"
    );
    Ok(cleaned.chars().take(120).collect())
}

// ---------- snapshot ----------

/// What assistants browse: every crate and track, including those on
/// external drives. Read-only, so it's safe while Serato runs.
fn snapshot(cfg: &SeratoCfg) -> anyhow::Result<Value> {
    let mut tracks = BTreeMap::new();
    let mut crates: BTreeMap<String, Vec<String>> = BTreeMap::new();
    read_library(&cfg.root, "/", &mut tracks, &mut crates)?;
    for (drive, root) in external_libraries(cfg) {
        let base = format!("{}/", drive.display());
        if let Err(e) = read_library(&root, &base, &mut tracks, &mut crates) {
            warn!(drive = %drive.display(), error = %format!("{e:#}"), "skipping a Serato drive");
        }
    }
    let playlists: Vec<Value> = crates
        .iter()
        .filter(|(stem, ids)| {
            // A crate that only groups others is a folder.
            let prefix = format!("{stem}{NESTING}");
            !ids.is_empty() || !crates.keys().any(|s| s.starts_with(&prefix))
        })
        .map(|(stem, ids)| {
            let mut parts: Vec<&str> = stem.split(NESTING).collect();
            let name = parts.pop().unwrap_or(stem);
            json!({
                "id": stem,
                "name": name,
                "folder": parts.join("/"),
                "track_ids": ids,
            })
        })
        .collect();
    let tracks: Vec<Value> = tracks.into_values().collect();
    Ok(json!({ "ok": true, "playlists": playlists, "tracks": tracks }))
}

fn external_libraries(cfg: &SeratoCfg) -> Vec<(PathBuf, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(&cfg.volumes_dir) else {
        return Vec::new();
    };
    let mut drives: Vec<(PathBuf, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| (e.path(), e.path().join("_Serato_")))
        .filter(|(_, root)| root.join(DATABASE).is_file())
        .collect();
    drives.sort();
    drives
}

fn read_library(
    root: &Path,
    base: &str,
    tracks: &mut BTreeMap<String, Value>,
    crates: &mut BTreeMap<String, Vec<String>>,
) -> anyhow::Result<()> {
    let path = root.join(DATABASE);
    let bytes = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
    let tags = parse_tags(&bytes).with_context(|| format!("reading {}", path.display()))?;
    for tag in tags.iter().filter(|t| &t.name == b"otrk") {
        if let Some(row) = track_row(tag, base) {
            tracks.insert(row["id"].as_str().unwrap_or_default().to_string(), row);
        }
    }
    for (stem, path) in crate_files(root)? {
        let tags = parse_tags(&std::fs::read(&path)?)
            .with_context(|| format!("reading {}", path.display()))?;
        let ids = crates.entry(stem).or_default();
        for stored in crate_tracks(&tags) {
            let full = format!("{base}{stored}");
            let id = track_id(&full);
            tracks
                .entry(id.clone())
                .or_insert_with(|| row_from_file(&full));
            ids.push(id);
        }
    }
    Ok(())
}

fn track_row(tag: &Tag, base: &str) -> Option<Value> {
    let fields: HashMap<[u8; 4], String> = tag
        .children()
        .ok()?
        .iter()
        .filter(|c| c.name[0] == b't' || c.name[0] == b'p')
        .map(|c| (c.name, c.as_text()))
        .collect();
    let full = format!("{base}{}", fields.get(b"pfil")?);
    let text = |name: &[u8; 4]| fields.get(name).filter(|v| !v.is_empty()).cloned();
    let Some(title) = text(b"tsng") else {
        // Added by DJ Sync and not opened in Serato yet: only a type and a path.
        return Some(row_from_file(&full));
    };
    Some(json!({
        "id": track_id(&full),
        "title": title,
        "artist": text(b"tart"),
        "album": text(b"talb"),
        "genre": text(b"tgen"),
        "bpm": fields.get(b"tbpm").and_then(|b| b.parse::<f64>().ok()).filter(|b| *b > 0.0),
        "key": text(b"tkey"),
        "duration_secs": fields.get(b"tlen").and_then(|l| duration_secs(l)),
        "path": full,
    }))
}

fn row_from_file(full: &str) -> Value {
    let path = Path::new(full);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| full.to_string());
    match crate::library::read_meta(path) {
        Ok(meta) => json!({
            "id": track_id(full),
            "title": meta.title,
            "artist": meta.artist,
            "album": meta.album,
            "genre": meta.genre,
            // Serato works these out the first time it opens the track.
            "bpm": null,
            "key": null,
            "duration_secs": (meta.duration_ms + 500) / 1000,
            "path": full,
        }),
        Err(_) => json!({
            "id": track_id(full),
            "title": stem,
            "artist": null,
            "album": null,
            "genre": null,
            "bpm": null,
            "key": null,
            "duration_secs": null,
            "path": full,
        }),
    }
}

/// `02:58.46` → 178.
fn duration_secs(length: &str) -> Option<u64> {
    let mut seconds = 0.0;
    for part in length.split(':') {
        seconds = seconds * 60.0 + part.parse::<f64>().ok()?;
    }
    Some(seconds.round() as u64)
}

fn change_stamp(cfg: &SeratoCfg) -> Option<SystemTime> {
    let mut roots = vec![cfg.root.clone()];
    roots.extend(external_libraries(cfg).into_iter().map(|(_, root)| root));
    let mut newest = None;
    for root in roots {
        let mut paths = vec![root.join(DATABASE), root.join(ORDER), root.join(CRATES)];
        paths.extend(
            crate_files(&root)
                .unwrap_or_default()
                .into_iter()
                .map(|(_, p)| p),
        );
        for path in paths {
            let stamp = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
            newest = newest.max(stamp);
        }
    }
    newest
}

// ---------- backups ----------

/// The files DJ Sync writes as one tar. Sorted, and stamped with nothing that
/// changes, so the same library always gives the same bytes: that's how
/// `Versions` tells an outside change from no change.
fn write_bundle(root: &Path, file: &Path) -> anyhow::Result<()> {
    let mut entries = vec![(DATABASE.to_string(), root.join(DATABASE))];
    let order = root.join(ORDER);
    if order.is_file() {
        entries.push((ORDER.to_string(), order));
    }
    for (stem, path) in crate_files(root)? {
        entries.push((format!("{CRATES}/{stem}.crate"), path));
    }
    let tmp = file.with_extension("tar.tmp");
    let mut builder = tar::Builder::new(std::fs::File::create(&tmp)?);
    for (name, path) in entries {
        let bytes = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_mtime(0);
        builder.append_data(&mut header, name, bytes.as_slice())?;
    }
    builder.into_inner()?.sync_all()?;
    std::fs::rename(&tmp, file)?;
    Ok(())
}

/// Make a bundle the live library: its files go back, and crates that weren't
/// in it go away. Serato loads the result at its next launch.
fn unpack_bundle(file: &Path, root: &Path) -> anyhow::Result<()> {
    let mut archive = tar::Archive::new(std::fs::File::open(file)?);
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let name = entry.path()?.to_string_lossy().into_owned();
        let plain_crate = name
            .strip_prefix(&format!("{CRATES}/"))
            .is_some_and(|n| n.ends_with(".crate") && !n.contains('/') && !n.contains(".."));
        anyhow::ensure!(
            name == DATABASE || name == ORDER || plain_crate,
            "unexpected file in a Serato backup: {name}"
        );
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut bytes)?;
        files.push((name, bytes));
    }
    anyhow::ensure!(
        files.iter().any(|(name, _)| name == DATABASE),
        "that backup has no Serato database in it"
    );
    std::fs::create_dir_all(root.join(CRATES))?;
    for (stem, path) in crate_files(root)? {
        let name = format!("{CRATES}/{stem}.crate");
        if !files.iter().any(|(n, _)| *n == name) {
            std::fs::remove_file(&path)?;
        }
    }
    for (name, bytes) in &files {
        write_atomic(&root.join(name), bytes)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dj_library::BatchOutcome;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// A Serato 5 library on disk: exported files, the two SQLite databases
    /// with the tables `preflight` reads, an app bundle, and one real track.
    struct Rig {
        tmp: tempfile::TempDir,
        cfg: SeratoCfg,
        track: String,
    }

    const EXISTING: &str = "Users/dj/Music/Old Song.mp3";

    fn database_with(paths: &[&str]) -> Vec<u8> {
        let mut tags = vec![Tag::text(b"vrsn", "2.0/Serato Scratch LIVE Database")];
        for path in paths {
            tags.push(Tag::nested(
                b"otrk",
                &[
                    Tag::text(b"ttyp", "mp3"),
                    Tag::text(b"pfil", path),
                    Tag::text(b"tsng", "Old Song"),
                    Tag::text(b"tart", "An Artist"),
                    Tag::text(b"tbpm", "128.00"),
                    Tag::text(b"tkey", "8A"),
                    Tag::text(b"tlen", "02:58.46"),
                    Tag {
                        name: *b"bmis",
                        data: vec![0],
                    },
                    // A field nobody here has heard of.
                    Tag {
                        name: *b"uzzz",
                        data: vec![1, 2, 3, 4],
                    },
                ],
            ));
        }
        encode_tags(&tags)
    }

    fn crate_with(paths: &[&str]) -> Vec<u8> {
        let mut tags = new_crate();
        tags.extend(paths.iter().map(|p| crate_entry(p)));
        encode_tags(&tags)
    }

    fn sqlite(db: &Path, script: &str) {
        let out = Command::new("/usr/bin/sqlite3")
            .arg(db)
            .arg(script)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn rig() -> Rig {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("_Serato_");
        std::fs::create_dir_all(root.join(CRATES)).unwrap();
        std::fs::write(root.join(DATABASE), database_with(&[EXISTING])).unwrap();
        let existing_crate = crate_with(&[EXISTING]);
        std::fs::write(root.join(CRATES).join("crate 1.crate"), &existing_crate).unwrap();
        std::fs::write(
            root.join(ORDER),
            Tag::text(b"text", "[begin record]\n[crate]crate 1\n[end record]\n").data,
        )
        .unwrap();

        let library_dir = tmp.path().join("Library");
        std::fs::create_dir_all(&library_dir).unwrap();
        sqlite(
            &library_dir.join("root.sqlite"),
            &format!(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE dbv2_status (autosync_disabled INTEGER NOT NULL DEFAULT 0);
                 INSERT INTO dbv2_status VALUES (0);
                 CREATE TABLE last_seen_dbv2_library (filename TEXT, size INTEGER, md5_hash BLOB);
                 INSERT INTO last_seen_dbv2_library VALUES
                   ('Subcrates/crate 1.crate', {}, x'{}');
                 CREATE TABLE container (id INTEGER PRIMARY KEY, name TEXT, type INTEGER);
                 INSERT INTO container VALUES (4, 'crate 1', 1);
                 CREATE TABLE dj_container_metadata (container_id INTEGER, filename TEXT);
                 INSERT INTO dj_container_metadata VALUES (4, 'crate 1.crate');
                 CREATE TABLE container_asset (id INTEGER PRIMARY KEY, container_id INTEGER);
                 INSERT INTO container_asset VALUES (1, 4);",
                existing_crate.len(),
                md5_hex(&existing_crate),
            ),
        );
        sqlite(
            &library_dir.join("master.sqlite"),
            "PRAGMA journal_mode = WAL;
             CREATE TABLE container (id INTEGER PRIMARY KEY, name TEXT, type INTEGER);
             INSERT INTO container VALUES (17, 'crate 1', 1);
             CREATE TABLE dj_container_metadata (container_id INTEGER, filename TEXT);
             INSERT INTO dj_container_metadata VALUES (17, 'crate 1.crate');
             CREATE TABLE location_container (id INTEGER PRIMARY KEY, container_id INTEGER);
             INSERT INTO location_container VALUES (1, 17);
             CREATE TABLE space (id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO space VALUES (5, 'Serato Library'), (12, 'Tidal');
             CREATE TABLE space_asset (id INTEGER PRIMARY KEY, space_id INTEGER);
             INSERT INTO space_asset VALUES (1, 5), (2, 12);
             CREATE TABLE container_asset (id INTEGER PRIMARY KEY,
               location_container_id INTEGER, space_asset_id INTEGER);
             INSERT INTO container_asset VALUES (1, 1, 1);",
        );

        let app = tmp.path().join("Serato DJ Pro.app");
        set_version(&app, "5.0.0");

        let track = tmp.path().join("New Song.mp3");
        std::fs::copy(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tone.mp3"),
            &track,
        )
        .unwrap();
        let cfg = SeratoCfg {
            enabled: true,
            root,
            library_dir,
            volumes_dir: tmp.path().join("Volumes"),
            app_paths: vec![app],
            sqlite3_bin: "/usr/bin/sqlite3".into(),
            keep_backups: 10,
            check_secs: 3,
        };
        Rig {
            track: track.to_string_lossy().into_owned(),
            cfg,
            tmp,
        }
    }

    fn set_version(app: &Path, version: &str) {
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        let mut info = plist::Dictionary::new();
        info.insert("CFBundleShortVersionString".into(), version.into());
        plist::Value::Dictionary(info)
            .to_file_xml(app.join("Contents/Info.plist"))
            .unwrap();
    }

    impl Rig {
        fn crate_path(&self, stem: &str) -> PathBuf {
            self.cfg.root.join(CRATES).join(format!("{stem}.crate"))
        }

        fn tracks_in(&self, stem: &str) -> Vec<String> {
            crate_tracks(&parse_tags(&std::fs::read(self.crate_path(stem)).unwrap()).unwrap())
        }

        fn stored(&self) -> String {
            self.track.trim_start_matches('/').to_string()
        }

        fn order(&self) -> String {
            decode_text(&std::fs::read(self.cfg.root.join(ORDER)).unwrap())
        }

        fn run(&self, ops: Vec<Value>) -> anyhow::Result<Vec<Value>> {
            let backend = Serato {
                cfg: self.cfg.clone(),
                state_dir: self.tmp.path().join("state"),
                running: Arc::new(|| false),
            };
            match backend.apply(ops, &[])? {
                ApplyOutcome::Done(v) => Ok(v["results"].as_array().unwrap().clone()),
                ApplyOutcome::AppRunning => panic!("reported running"),
            }
        }

        fn download(&self, playlist: &str) -> Vec<Value> {
            vec![
                json!({"op": "add_track", "path": self.track}),
                json!({"op": "ensure_playlist", "name": playlist}),
                json!({"op": "add_to_playlist", "playlist": playlist, "path": self.track}),
            ]
        }

        fn files(&self) -> BTreeMap<String, Vec<u8>> {
            let mut files: BTreeMap<String, Vec<u8>> = crate_files(&self.cfg.root)
                .unwrap()
                .into_iter()
                .map(|(stem, path)| (stem, std::fs::read(path).unwrap()))
                .collect();
            for name in [DATABASE, ORDER] {
                files.insert(
                    name.into(),
                    std::fs::read(self.cfg.root.join(name)).unwrap(),
                );
            }
            files
        }

        fn in_sqlite(&self, db: &str, script: &str) {
            sqlite(&self.cfg.library_dir.join(db), script);
        }
    }

    #[test]
    fn records_round_trip_byte_for_byte() {
        let bytes = database_with(&[EXISTING, "Users/dj/Music/Ünï.mp3"]);
        assert_eq!(encode_tags(&parse_tags(&bytes).unwrap()), bytes);
    }

    #[test]
    fn a_cut_short_file_is_an_error_not_a_partial_read() {
        let bytes = database_with(&[EXISTING]);
        assert!(parse_tags(&bytes[..bytes.len() - 3]).is_err());
    }

    #[test]
    fn a_new_crate_header_matches_what_serato_writes() {
        // Dumped from a crate Serato DJ Pro 5.0.0 exported (605 bytes, one track).
        let tags = new_crate();
        assert_eq!(tags[0].as_text(), "1.0/Serato ScratchLive Crate");
        assert_eq!(tags[0].data.len(), 56);
        let bytes = encode_tags(&[&tags[1..]].concat());
        assert_eq!(tags[1].data.len(), 25);
        assert_eq!(tags.iter().filter(|t| &t.name == b"ovct").count(), 8);
        assert_eq!(
            tags.iter()
                .filter(|t| &t.name == b"ovct")
                .map(|t| t.data.len())
                .collect::<Vec<_>>(),
            [26, 30, 24, 24, 36, 28, 30, 32]
        );
        assert!(!bytes.is_empty());
    }

    #[test]
    fn a_download_adds_only_a_type_and_path_inside_a_dj_sync_crate() {
        let r = rig();
        let before = std::fs::read(r.cfg.root.join(DATABASE)).unwrap();
        let results = r.run(r.download("Friday")).unwrap();
        assert_eq!(results[0]["created"], true);
        assert_eq!(results[1]["playlist_id"], "DJ Sync%%Friday");
        assert_eq!(results[1]["created"], true);
        assert_eq!(results[2]["added"], true);

        assert_eq!(r.tracks_in("DJ Sync%%Friday"), [r.stored()]);
        assert!(r.tracks_in("DJ Sync").is_empty());
        let after = std::fs::read(r.cfg.root.join(DATABASE)).unwrap();
        assert_eq!(
            &after[..before.len()],
            before.as_slice(),
            "existing bytes kept"
        );
        let tags = parse_tags(&after[before.len()..]).unwrap();
        let names: Vec<_> = tags[0].children().unwrap().iter().map(|t| t.name).collect();
        assert_eq!(names, [*b"ttyp", *b"pfil"]);
        assert_eq!(
            r.order(),
            "[begin record]\n[crate]crate 1\n[crate]DJ Sync\n[crate]DJ Sync%%Friday\n[end record]\n"
        );
    }

    #[test]
    fn written_files_are_readable_like_seratos_own() {
        let r = rig();
        r.run(r.download("Friday")).unwrap();
        for path in [
            r.crate_path("DJ Sync%%Friday"),
            r.cfg.root.join(DATABASE),
            r.cfg.root.join(ORDER),
        ] {
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o644, "{}", path.display());
        }
        let leftovers: Vec<_> = std::fs::read_dir(r.cfg.root.join(CRATES))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn repeating_a_download_changes_nothing() {
        let r = rig();
        r.run(r.download("Friday")).unwrap();
        let files = r.files();
        let results = r.run(r.download("Friday")).unwrap();
        assert_eq!(results[0]["created"], false);
        assert_eq!(results[1]["created"], false);
        assert_eq!(results[2]["added"], false);
        assert_eq!(r.files(), files);
    }

    #[test]
    fn a_failed_op_leaves_every_file_alone() {
        let r = rig();
        let files = r.files();
        let mut ops = r.download("Friday");
        ops.push(json!({"op": "add_to_playlist", "playlist": "Nope", "path": r.track}));
        let error = r.run(ops).unwrap_err();
        assert!(
            format!("{error:#}").contains("op 3 (add_to_playlist)"),
            "{error:#}"
        );
        assert_eq!(r.files(), files);
    }

    #[test]
    fn removing_a_track_keeps_every_other_record() {
        let r = rig();
        let other = "Users/dj/Music/Kept.mp3";
        std::fs::write(r.crate_path("crate 1"), crate_with(&[EXISTING, other])).unwrap();
        let results = r
            .run(vec![json!({
                "op": "remove_from_playlist",
                "playlist": "crate 1",
                "path": absolute(EXISTING),
            })])
            .unwrap();
        assert_eq!(results[0]["removed"], true);
        assert_eq!(r.tracks_in("crate 1"), [other]);
        assert_eq!(
            std::fs::read(r.crate_path("crate 1")).unwrap(),
            crate_with(&[other])
        );
    }

    #[test]
    fn tracks_are_found_by_their_snapshot_id() {
        let r = rig();
        let id = track_id(&absolute(EXISTING));
        let results = r
            .run(vec![
                json!({"op": "ensure_playlist", "name": "Friday"}),
                json!({"op": "add_to_playlist", "playlist": "Friday", "content_id": id}),
            ])
            .unwrap();
        assert_eq!(results[1]["added"], true);
        assert_eq!(r.tracks_in("DJ Sync%%Friday"), [EXISTING]);
    }

    #[test]
    fn a_pinned_crate_wins_over_a_same_named_one() {
        let r = rig();
        std::fs::write(r.crate_path("Sets%%Friday"), crate_with(&[])).unwrap();
        std::fs::write(r.crate_path("DJ Sync%%Friday"), crate_with(&[])).unwrap();
        r.run(vec![json!({
            "op": "add_to_playlist",
            "playlist": "Friday",
            "playlist_id": "Sets%%Friday",
            "path": absolute(EXISTING),
        })])
        .unwrap();
        assert_eq!(r.tracks_in("Sets%%Friday"), [EXISTING]);
        assert!(r.tracks_in("DJ Sync%%Friday").is_empty());
    }

    #[test]
    fn renaming_keeps_the_parent_and_moves_children() {
        let r = rig();
        std::fs::write(r.crate_path("DJ Sync%%Fri"), crate_with(&[EXISTING])).unwrap();
        std::fs::write(r.crate_path("DJ Sync%%Fri%%Late"), crate_with(&[])).unwrap();
        r.run(vec![
            json!({"op": "rename_playlist", "name": "Fri", "new_name": "Friday"}),
        ])
        .unwrap();
        assert_eq!(r.tracks_in("DJ Sync%%Friday"), [EXISTING]);
        assert!(r.crate_path("DJ Sync%%Friday%%Late").is_file());
        assert!(!r.crate_path("DJ Sync%%Fri").exists());
        assert!(!r.crate_path("DJ Sync%%Fri%%Late").exists());
    }

    #[test]
    fn renaming_onto_another_crate_is_refused() {
        let r = rig();
        std::fs::write(r.crate_path("Other"), crate_with(&[])).unwrap();
        let error = r
            .run(vec![
                json!({"op": "rename_playlist", "name": "Other", "new_name": "CRATE 1"}),
            ])
            .unwrap_err();
        assert!(format!("{error:#}").contains("already exists"), "{error:#}");
    }

    #[test]
    fn deleting_removes_the_crate_and_its_order_line_but_not_tracks() {
        let r = rig();
        let database = std::fs::read(r.cfg.root.join(DATABASE)).unwrap();
        let results = r
            .run(vec![json!({"op": "delete_playlist", "name": "crate 1"})])
            .unwrap();
        assert_eq!(results[0]["deleted"], true);
        assert!(!r.crate_path("crate 1").exists());
        assert!(!r.order().contains("crate 1"));
        assert_eq!(std::fs::read(r.cfg.root.join(DATABASE)).unwrap(), database);
    }

    #[test]
    fn a_crate_with_crates_inside_it_is_not_deleted() {
        let r = rig();
        std::fs::write(r.crate_path("crate 1%%Inner"), crate_with(&[])).unwrap();
        let error = r
            .run(vec![json!({"op": "delete_playlist", "name": "crate 1"})])
            .unwrap_err();
        assert!(format!("{error:#}").contains("inside it"), "{error:#}");
        assert!(r.crate_path("crate 1").exists());
    }

    #[test]
    fn deleting_a_crate_that_isnt_there_is_a_no_op() {
        let r = rig();
        let results = r
            .run(vec![json!({"op": "delete_playlist", "name": "Ghost"})])
            .unwrap();
        assert_eq!(results[0]["deleted"], false);
    }

    #[test]
    fn names_that_cant_be_file_names_are_cleaned_up() {
        assert_eq!(crate_name("AC/DC: Live").unwrap(), "AC-DC- Live");
        assert_eq!(crate_name("50%%off").unwrap(), "50%off");
        assert_eq!(crate_name("  .hidden ").unwrap(), "hidden");
        assert!(crate_name(" ... ").is_err());
    }

    #[test]
    fn a_crate_named_with_a_slash_is_found_again() {
        let r = rig();
        r.run(r.download("AC/DC")).unwrap();
        let results = r.run(r.download("AC/DC")).unwrap();
        assert_eq!(results[1]["created"], false);
        assert_eq!(r.tracks_in("DJ Sync%%AC-DC"), [r.stored()]);
    }

    #[test]
    fn external_drives_are_read_but_never_written() {
        let r = rig();
        let path = r.cfg.volumes_dir.join("USB/a.mp3");
        let error = r
            .run(vec![json!({"op": "add_track", "path": path})])
            .unwrap_err();
        assert!(format!("{error:#}").contains("external drive"), "{error:#}");
    }

    #[test]
    fn a_library_without_a_crate_folder_or_order_file_still_works() {
        let r = rig();
        std::fs::remove_file(r.cfg.root.join(ORDER)).unwrap();
        r.run(r.download("Friday")).unwrap();
        assert_eq!(
            r.order(),
            "[begin record]\n[crate]DJ Sync\n[crate]DJ Sync%%Friday\n[end record]\n"
        );
    }

    #[test]
    fn the_snapshot_has_the_shape_the_worker_stores_and_hides_paths_by_id() {
        let r = rig();
        r.run(r.download("Friday")).unwrap();
        let snapshot = snapshot(&r.cfg).unwrap();
        let tracks = snapshot["tracks"].as_array().unwrap();
        assert_eq!(tracks.len(), 2);
        let old = tracks.iter().find(|t| t["title"] == "Old Song").unwrap();
        assert_eq!(old["artist"], "An Artist");
        assert_eq!(old["bpm"], 128.0);
        assert_eq!(old["key"], "8A");
        assert_eq!(old["duration_secs"], 178);
        assert_eq!(old["path"], absolute(EXISTING));
        assert_eq!(old["id"], track_id(&absolute(EXISTING)));
        let new = tracks.iter().find(|t| t["path"] == json!(r.track)).unwrap();
        assert!(new["title"].as_str().is_some_and(|t| !t.is_empty()));

        let playlists = snapshot["playlists"].as_array().unwrap();
        let names: Vec<_> = playlists
            .iter()
            .map(|p| p["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["Friday", "crate 1"]);
        assert_eq!(playlists[0]["id"], "DJ Sync%%Friday");
        assert_eq!(playlists[0]["folder"], "DJ Sync");
        assert_eq!(playlists[0]["track_ids"][0], new["id"]);
    }

    #[test]
    fn an_empty_crate_still_shows_unless_it_only_groups_others() {
        let r = rig();
        std::fs::write(r.crate_path("Empty"), crate_with(&[])).unwrap();
        std::fs::write(r.crate_path("Group"), crate_with(&[])).unwrap();
        std::fs::write(r.crate_path("Group%%Inner"), crate_with(&[EXISTING])).unwrap();
        let snapshot = snapshot(&r.cfg).unwrap();
        let ids: Vec<_> = snapshot["playlists"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, ["Empty", "Group%%Inner", "crate 1"]);
    }

    #[test]
    fn the_snapshot_merges_external_drives_by_crate() {
        let r = rig();
        let drive = r.cfg.volumes_dir.join("USB");
        let root = drive.join("_Serato_");
        std::fs::create_dir_all(root.join(CRATES)).unwrap();
        std::fs::write(root.join(DATABASE), database_with(&["Music/On Drive.mp3"])).unwrap();
        std::fs::write(
            root.join(CRATES).join("crate 1.crate"),
            crate_with(&["Music/On Drive.mp3"]),
        )
        .unwrap();
        let snapshot = snapshot(&r.cfg).unwrap();
        let ids = snapshot["playlists"][0]["track_ids"].as_array().unwrap();
        assert_eq!(ids.len(), 2, "both drives' tracks, one crate");
        let on_drive = format!("{}/Music/On Drive.mp3", drive.display());
        assert!(snapshot["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["path"] == json!(on_drive)));
    }

    #[test]
    fn a_broken_external_drive_doesnt_hide_the_library() {
        let r = rig();
        let root = r.cfg.volumes_dir.join("USB/_Serato_");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(DATABASE), [1, 2, 3]).unwrap();
        assert_eq!(
            snapshot(&r.cfg).unwrap()["tracks"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn the_change_stamp_moves_when_a_crate_changes() {
        let r = rig();
        let before = change_stamp(&r.cfg).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        r.run(r.download("Friday")).unwrap();
        assert!(change_stamp(&r.cfg).unwrap() > before);
    }

    // ---------- preflight ----------

    #[test]
    fn a_healthy_library_passes() {
        preflight(&rig().cfg).unwrap();
    }

    #[test]
    fn other_serato_versions_are_refused() {
        for version in ["3.2.1", "4.0.9", "6.0.0", "garbage"] {
            let r = rig();
            set_version(&r.cfg.app_paths[0], version);
            let error = preflight(&r.cfg).unwrap_err().to_string();
            assert!(error.contains("Serato DJ Pro 5"), "{error}");
            assert!(error.contains(version), "{error}");
        }
    }

    #[test]
    fn point_releases_of_the_tested_major_pass() {
        let r = rig();
        set_version(&r.cfg.app_paths[0], "5.1.3");
        preflight(&r.cfg).unwrap();
    }

    #[test]
    fn no_serato_app_is_refused() {
        let mut r = rig();
        r.cfg.app_paths = vec![r.tmp.path().join("Nope.app")];
        assert!(preflight(&r.cfg)
            .unwrap_err()
            .to_string()
            .contains("can't find"));
    }

    #[test]
    fn a_library_serato_hasnt_set_up_is_refused() {
        let r = rig();
        std::fs::remove_file(r.cfg.library_dir.join("master.sqlite")).unwrap();
        assert!(preflight(&r.cfg)
            .unwrap_err()
            .to_string()
            .contains("set up"));
    }

    #[test]
    fn a_log_left_by_a_force_quit_is_refused() {
        let r = rig();
        std::fs::write(r.cfg.library_dir.join("root.sqlite-wal"), b"uncommitted").unwrap();
        let error = preflight(&r.cfg).unwrap_err().to_string();
        assert!(error.contains("didn't close cleanly"), "{error}");
    }

    #[test]
    fn an_empty_log_is_fine() {
        let r = rig();
        std::fs::write(r.cfg.library_dir.join("root.sqlite-wal"), b"").unwrap();
        preflight(&r.cfg).unwrap();
    }

    #[test]
    fn a_library_path_with_spaces_and_odd_characters_can_be_read() {
        let mut r = rig();
        let odd = r.tmp.path().join("Application Support #1 ?100%");
        std::fs::rename(&r.cfg.library_dir, &odd).unwrap();
        r.cfg.library_dir = odd;
        preflight(&r.cfg).unwrap();
    }

    #[test]
    fn switched_off_auto_sync_is_refused() {
        let r = rig();
        r.in_sqlite(
            "root.sqlite",
            "UPDATE dbv2_status SET autosync_disabled = 1",
        );
        assert!(preflight(&r.cfg)
            .unwrap_err()
            .to_string()
            .contains("sync is off"));
    }

    #[test]
    fn a_crate_with_a_streaming_track_blocks_every_write() {
        let r = rig();
        r.in_sqlite(
            "master.sqlite",
            "INSERT INTO container_asset VALUES (2, 1, 2)",
        );
        let files = r.files();
        let error = r.run(r.download("Friday")).unwrap_err().to_string();
        assert!(error.contains("streaming"), "{error}");
        assert!(error.contains("crate 1"), "{error}");
        assert_eq!(r.files(), files);
    }

    #[test]
    fn a_crate_track_with_no_space_is_treated_as_not_local() {
        let r = rig();
        r.in_sqlite(
            "master.sqlite",
            "INSERT INTO container_asset VALUES (2, 1, 999)",
        );
        assert!(preflight(&r.cfg).is_err());
    }

    #[test]
    fn a_crate_serato_holds_more_of_than_its_file_blocks_writes() {
        let r = rig();
        r.in_sqlite("root.sqlite", "INSERT INTO container_asset VALUES (2, 4)");
        let error = preflight(&r.cfg).unwrap_err().to_string();
        assert!(error.contains("force quit"), "{error}");
    }

    #[test]
    fn a_crate_with_no_exported_file_blocks_writes() {
        let r = rig();
        r.in_sqlite(
            "root.sqlite",
            "INSERT INTO container VALUES (9, 'Lost', 1);
             INSERT INTO dj_container_metadata VALUES (9, 'Lost.crate');",
        );
        assert!(preflight(&r.cfg).unwrap_err().to_string().contains("Lost"));
    }

    #[test]
    fn a_smart_crate_isnt_mistaken_for_a_crate_with_no_file() {
        let r = rig();
        r.in_sqlite(
            "root.sqlite",
            "INSERT INTO container VALUES (9, 'Smart', 1);
             INSERT INTO dj_container_metadata VALUES (9, 'Smart.scrate');",
        );
        preflight(&r.cfg).unwrap();
    }

    #[test]
    fn a_crate_serato_never_exported_blocks_writes() {
        let r = rig();
        r.in_sqlite(
            "root.sqlite",
            "INSERT INTO container VALUES (9, 'New', 1);
             INSERT INTO dj_container_metadata VALUES (9, NULL);",
        );
        assert!(preflight(&r.cfg).unwrap_err().to_string().contains("New"));
    }

    #[test]
    fn our_own_write_serato_hasnt_loaded_yet_isnt_mistaken_for_a_problem() {
        let r = rig();
        // Two downloads while Serato stays closed: the second sees crate 1
        // changed and a new crate, neither of which SQLite knows about.
        r.run(vec![
            json!({"op": "add_track", "path": r.track}),
            json!({"op": "add_to_playlist", "playlist": "crate 1", "path": r.track}),
        ])
        .unwrap();
        r.run(r.download("Friday")).unwrap();
        assert_eq!(r.tracks_in("crate 1").len(), 2);
        // ...and a crate deleted by an earlier write.
        r.run(vec![json!({"op": "delete_playlist", "name": "crate 1"})])
            .unwrap();
        preflight(&r.cfg).unwrap();
    }

    #[test]
    fn an_unrecognised_database_is_refused_not_guessed_at() {
        let r = rig();
        r.in_sqlite("master.sqlite", "DROP TABLE space_asset");
        let error = preflight(&r.cfg).unwrap_err().to_string();
        assert!(error.contains("doesn't recognise"), "{error}");
    }

    // ---------- the whole thing ----------

    fn library_for(r: &Rig) -> (DjLibrary, Arc<AtomicBool>) {
        let running = Arc::new(AtomicBool::new(false));
        let flag = running.clone();
        let lib = library_with_parts(
            r.cfg.clone(),
            r.tmp.path().join("state"),
            Arc::new(move || flag.load(Ordering::SeqCst)),
        );
        (lib, running)
    }

    #[test]
    fn changes_wait_for_serato_to_close_then_apply_with_backups() {
        let r = rig();
        let (lib, running) = library_for(&r);
        let files = r.files();
        let id = lib
            .enqueue("Add 1 track".into(), r.download("Friday"))
            .unwrap();

        running.store(true, Ordering::SeqCst);
        assert!(lib.apply_pending().unwrap().is_none());
        assert_eq!(lib.status().pending.len(), 1);
        assert_eq!(lib.batch_outcome(&id), BatchOutcome::Pending);
        assert_eq!(r.files(), files, "nothing written while Serato is open");

        running.store(false, Ordering::SeqCst);
        let applied = lib.apply_pending().unwrap().expect("applied");
        assert_eq!(
            applied.version.as_deref(),
            Some("1.1.0"),
            "a new crate is MINOR"
        );
        assert_eq!(
            lib.batch_outcome(&id),
            BatchOutcome::Applied {
                version: Some("1.1.0".into())
            }
        );
        let status = lib.status();
        assert_eq!(status.app, "Serato");
        assert!(status.pending.is_empty());
        assert_eq!(
            status
                .backups
                .iter()
                .map(|b| b.version.as_str())
                .collect::<Vec<_>>(),
            ["1.1.0", "1.0.0"]
        );
    }

    #[test]
    fn serato_changing_its_library_is_kept_as_a_major_version() {
        let r = rig();
        let (lib, _) = library_for(&r);
        lib.enqueue("one".into(), r.download("Friday")).unwrap();
        lib.apply_pending().unwrap().unwrap();
        // Serato exports differently, as it does on every quit.
        std::fs::write(r.crate_path("Made In Serato"), crate_with(&[])).unwrap();
        lib.enqueue("two".into(), r.download("Saturday")).unwrap();
        assert_eq!(
            lib.apply_pending().unwrap().unwrap().version.as_deref(),
            Some("2.1.0")
        );
    }

    #[test]
    fn nothing_new_makes_no_new_backup() {
        let r = rig();
        let (lib, _) = library_for(&r);
        lib.enqueue("one".into(), r.download("Friday")).unwrap();
        lib.apply_pending().unwrap().unwrap();
        lib.enqueue("again".into(), r.download("Friday")).unwrap();
        assert_eq!(
            lib.apply_pending().unwrap().unwrap().version.as_deref(),
            Some("1.1.0")
        );
    }

    #[test]
    fn restoring_brings_the_old_library_back_and_can_be_undone() {
        let r = rig();
        let (lib, running) = library_for(&r);
        let original = r.files();
        lib.ensure_baseline().unwrap();
        lib.enqueue("Add".into(), r.download("Friday")).unwrap();
        lib.apply_pending().unwrap().unwrap();
        let changed = r.files();
        assert_ne!(changed, original);

        running.store(true, Ordering::SeqCst);
        assert!(lib
            .restore("1.0.0")
            .unwrap_err()
            .to_string()
            .contains("Quit Serato"));
        running.store(false, Ordering::SeqCst);

        let message = lib.restore("1.0.0").unwrap();
        assert!(message.contains("Serato"), "{message}");
        assert!(message.contains("Open Serato"), "{message}");
        assert_eq!(r.files(), original, "added crates are gone again");

        lib.restore("1.1.0").unwrap();
        assert_eq!(r.files(), changed);
    }

    #[test]
    fn the_same_library_always_bundles_to_the_same_bytes() {
        let r = rig();
        let (a, b) = (r.tmp.path().join("a.tar"), r.tmp.path().join("b.tar"));
        write_bundle(&r.cfg.root, &a).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        // Same content, new modification times, as after a Serato export.
        for (_, path) in crate_files(&r.cfg.root).unwrap() {
            let bytes = std::fs::read(&path).unwrap();
            std::fs::write(&path, bytes).unwrap();
        }
        write_bundle(&r.cfg.root, &b).unwrap();
        assert_eq!(std::fs::read(a).unwrap(), std::fs::read(b).unwrap());
    }

    #[test]
    fn a_backup_with_anything_unexpected_in_it_is_refused() {
        let r = rig();
        let bad = r.tmp.path().join("bad.tar");
        let mut builder = tar::Builder::new(std::fs::File::create(&bad).unwrap());
        let mut header = tar::Header::new_gnu();
        header.set_size(1);
        header.set_mode(0o644);
        builder
            .append_data(&mut header, "Subcrates/evil.txt", &b"x"[..])
            .unwrap();
        builder.finish().unwrap();
        drop(builder);
        let files = r.files();
        assert!(unpack_bundle(&bad, &r.cfg.root).is_err());
        assert_eq!(r.files(), files);
    }

    #[test]
    fn a_refused_write_is_set_aside_with_the_reason_and_can_be_retried() {
        let r = rig();
        let (lib, _) = library_for(&r);
        r.in_sqlite(
            "master.sqlite",
            "INSERT INTO container_asset VALUES (2, 1, 2)",
        );
        let id = lib.enqueue("Add".into(), r.download("Friday")).unwrap();
        for _ in 0..3 {
            assert!(lib.apply_pending().is_err());
        }
        let BatchOutcome::Failed { error } = lib.batch_outcome(&id) else {
            panic!("should be set aside");
        };
        assert!(error.contains("streaming"), "{error}");

        r.in_sqlite("master.sqlite", "DELETE FROM container_asset WHERE id = 2");
        assert_eq!(lib.retry_failed().unwrap(), 1);
        assert!(lib.apply_pending().unwrap().is_some());
    }

    /// The real thing, on a copy: `SERATO_SANDBOX=<dir>` holding `_Serato_/`
    /// and `Library/` copied from a Mac with Serato closed. Never point this
    /// at a live library.
    #[test]
    #[ignore = "needs a copy of a real Serato library"]
    fn a_copy_of_a_real_library() {
        let sandbox = PathBuf::from(std::env::var("SERATO_SANDBOX").expect("SERATO_SANDBOX"));
        let track = std::env::var("SERATO_TRACK").expect("SERATO_TRACK");
        let cfg = SeratoCfg {
            enabled: true,
            root: sandbox.join("_Serato_"),
            library_dir: sandbox.join("Library"),
            volumes_dir: sandbox.join("Volumes"),
            ..SeratoCfg::default()
        };
        preflight(&cfg).expect("a real library passes the guard");
        let before = snapshot(&cfg).unwrap();
        println!(
            "before: {} tracks, {} crates",
            before["tracks"].as_array().unwrap().len(),
            before["playlists"].as_array().unwrap().len()
        );
        let lib = library_with_parts(cfg.clone(), sandbox.join("state"), Arc::new(|| false));
        lib.enqueue(
            "Add".into(),
            vec![
                json!({"op": "add_track", "path": track}),
                json!({"op": "ensure_playlist", "name": "Sandbox"}),
                json!({"op": "add_to_playlist", "playlist": "Sandbox", "path": track}),
            ],
        )
        .unwrap();
        println!("{:?}", lib.apply_pending().unwrap());
        preflight(&cfg).expect("still passes with our own write waiting");
        let after = snapshot(&cfg).unwrap();
        println!(
            "after: {}",
            serde_json::to_string(&after["playlists"]).unwrap()
        );
    }
}
