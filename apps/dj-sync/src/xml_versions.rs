//! Semver-named snapshots of the import XML, kept next to it in
//! `<file>.versions/<stem>.vX.Y.Z.xml`. Every state dj-sync writes is
//! snapshotted, so any earlier version can be restored by copying it back
//! (or imported straight into Rekordbox — snapshots are ordinary XML).
//!
//! - **MAJOR**: the library changed underneath dj-sync — the first time a
//!   file is seen (a file that already existed, or the empty one dj-sync just
//!   created, becomes `1.0.0`), or the file no longer matches our latest
//!   snapshot because something else edited it. The outside version is
//!   snapshotted *before* dj-sync writes over it.
//! - **MINOR**: a save that created a new playlist.
//! - **PATCH**: a save that only added tracks to existing playlists.
//!
//! Saves that change nothing don't create a version.

use std::fmt;
use std::path::{Path, PathBuf};

use anyhow::Context;
use tracing::{info, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl Version {
    pub const BASELINE: Version = Version {
        major: 1,
        minor: 0,
        patch: 0,
    };

    pub fn bump(self, bump: Bump) -> Version {
        match bump {
            Bump::Major => Version {
                major: self.major + 1,
                minor: 0,
                patch: 0,
            },
            Bump::Minor => Version {
                minor: self.minor + 1,
                patch: 0,
                ..self
            },
            Bump::Patch => Version {
                patch: self.patch + 1,
                ..self
            },
        }
    }

    pub fn parse(s: &str) -> Option<Version> {
        let mut parts = s.split('.').map(|p| p.parse::<u64>().ok());
        let v = Version {
            major: parts.next()??,
            minor: parts.next()??,
            patch: parts.next()??,
        };
        parts.next().is_none().then_some(v)
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bump {
    Major,
    Minor,
    Patch,
}

pub struct Versions {
    dir: PathBuf,
    stem: String,
    keep: usize,
}

impl Versions {
    /// Snapshots for `xml` live in `<xml>.versions/`. The newest `keep`
    /// snapshots are kept, plus every `X.0.0` (the originals dj-sync adopted).
    pub fn for_xml(xml: &Path, keep: usize) -> Self {
        let name = xml
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "rekordbox.xml".into());
        let stem = xml
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "rekordbox".into());
        Self {
            dir: xml.with_file_name(format!("{name}.versions")),
            stem,
            keep: keep.max(1),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path_for(&self, v: Version) -> PathBuf {
        self.dir.join(format!("{}.v{v}.xml", self.stem))
    }

    /// All snapshots, oldest first.
    pub fn list(&self) -> Vec<(Version, PathBuf)> {
        let prefix = format!("{}.v", self.stem);
        let mut out: Vec<(Version, PathBuf)> = match std::fs::read_dir(&self.dir) {
            Ok(rd) => rd
                .filter_map(Result::ok)
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    let v = name.strip_prefix(&prefix)?.strip_suffix(".xml")?;
                    Some((Version::parse(v)?, e.path()))
                })
                .collect(),
            Err(_) => Vec::new(),
        };
        out.sort();
        out
    }

    pub fn latest(&self) -> Option<(Version, PathBuf)> {
        self.list().pop()
    }

    /// Make sure the file's current contents are covered by a snapshot,
    /// before anything writes to it. Returns the version the file is at now
    /// (`None` only if the file doesn't exist and never had a snapshot).
    pub fn reconcile(&self, xml: &Path) -> anyhow::Result<Option<Version>> {
        let current = match std::fs::read(xml) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(self.latest().map(|(v, _)| v));
            }
            Err(e) => return Err(e).with_context(|| format!("reading {}", xml.display())),
        };
        let next = match self.latest() {
            None => Version::BASELINE,
            Some((v, path)) => {
                if std::fs::read(&path).ok().as_deref() == Some(current.as_slice()) {
                    return Ok(Some(v));
                }
                warn!(
                    file = %xml.display(),
                    last = %v,
                    "import xml changed outside dj-sync; keeping that version before writing"
                );
                v.bump(Bump::Major)
            }
        };
        self.snapshot(next, &current)?;
        info!(version = %next, dir = %self.dir.display(), "snapshotted import xml");
        Ok(Some(next))
    }

    /// Snapshot the file as just written, one `bump` above `previous`.
    pub fn record(
        &self,
        xml: &Path,
        previous: Option<Version>,
        bump: Bump,
    ) -> anyhow::Result<Version> {
        let next = previous.map_or(Version::BASELINE, |p| p.bump(bump));
        let bytes = std::fs::read(xml).with_context(|| format!("reading {}", xml.display()))?;
        self.snapshot(next, &bytes)?;
        self.prune();
        Ok(next)
    }

    fn snapshot(&self, v: Version, bytes: &[u8]) -> anyhow::Result<PathBuf> {
        std::fs::create_dir_all(&self.dir)
            .with_context(|| format!("creating {}", self.dir.display()))?;
        let path = self.path_for(v);
        // Versions are immutable: never replace an existing snapshot.
        anyhow::ensure!(!path.exists(), "snapshot {} already exists", path.display());
        let tmp = path.with_extension("xml.tmp");
        std::fs::write(&tmp, bytes).with_context(|| format!("writing {}", tmp.display()))?;
        std::fs::rename(&tmp, &path)
            .with_context(|| format!("renaming {} -> {}", tmp.display(), path.display()))?;
        Ok(path)
    }

    /// Drop the oldest snapshots beyond `keep`, never an `X.0.0`.
    fn prune(&self) {
        let all = self.list();
        let excess = all.len().saturating_sub(self.keep);
        for (v, path) in all.into_iter().take(excess) {
            if v.minor == 0 && v.patch == 0 {
                continue;
            }
            if let Err(e) = std::fs::remove_file(&path) {
                warn!(file = %path.display(), error = %e, "could not prune old snapshot");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn semver_parse_bump_and_order() {
        assert_eq!(v("1.2.3").to_string(), "1.2.3");
        assert_eq!(Version::parse("1.2"), None);
        assert_eq!(Version::parse("1.2.3.4"), None);
        assert_eq!(Version::parse("1.x.3"), None);
        assert_eq!(v("1.2.3").bump(Bump::Patch), v("1.2.4"));
        assert_eq!(v("1.2.3").bump(Bump::Minor), v("1.3.0"));
        assert_eq!(v("1.2.3").bump(Bump::Major), v("2.0.0"));
        assert!(v("1.10.0") > v("1.9.9"), "numeric, not lexical");
    }

    #[test]
    fn snapshots_live_next_to_the_file() {
        let s = Versions::for_xml(Path::new("/m/rekordbox.xml"), 10);
        assert_eq!(s.dir(), Path::new("/m/rekordbox.xml.versions"));
        assert_eq!(
            s.path_for(v("1.2.3")),
            PathBuf::from("/m/rekordbox.xml.versions/rekordbox.v1.2.3.xml")
        );
    }

    #[test]
    fn baseline_then_bumps_then_outside_edit_is_a_major() {
        let dir = tempfile::tempdir().unwrap();
        let xml = dir.path().join("rekordbox.xml");
        let s = Versions::for_xml(&xml, 100);

        assert_eq!(s.reconcile(&xml).unwrap(), None, "no file, no snapshots");

        std::fs::write(&xml, "original").unwrap();
        assert_eq!(s.reconcile(&xml).unwrap(), Some(v("1.0.0")));
        assert_eq!(s.reconcile(&xml).unwrap(), Some(v("1.0.0")), "idempotent");

        std::fs::write(&xml, "new playlist").unwrap();
        assert_eq!(
            s.record(&xml, Some(v("1.0.0")), Bump::Minor).unwrap(),
            v("1.1.0")
        );
        std::fs::write(&xml, "more tracks").unwrap();
        assert_eq!(
            s.record(&xml, Some(v("1.1.0")), Bump::Patch).unwrap(),
            v("1.1.1")
        );
        assert_eq!(s.reconcile(&xml).unwrap(), Some(v("1.1.1")));

        // Someone else edits the file: preserved as the next major before we write.
        std::fs::write(&xml, "edited in another tool").unwrap();
        assert_eq!(s.reconcile(&xml).unwrap(), Some(v("2.0.0")));
        assert_eq!(
            std::fs::read_to_string(s.path_for(v("2.0.0"))).unwrap(),
            "edited in another tool"
        );
        // Every earlier state is still restorable.
        assert_eq!(
            std::fs::read_to_string(s.path_for(v("1.0.0"))).unwrap(),
            "original"
        );
        assert_eq!(
            s.list()
                .iter()
                .map(|(v, _)| v.to_string())
                .collect::<Vec<_>>(),
            ["1.0.0", "1.1.0", "1.1.1", "2.0.0"]
        );
    }

    #[test]
    fn snapshots_are_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let xml = dir.path().join("x.xml");
        let s = Versions::for_xml(&xml, 100);
        std::fs::write(&xml, "a").unwrap();
        s.reconcile(&xml).unwrap();
        assert!(
            s.record(&xml, None, Bump::Patch).is_err(),
            "1.0.0 already taken"
        );
    }

    #[test]
    fn prune_keeps_newest_and_every_major_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let xml = dir.path().join("x.xml");
        let s = Versions::for_xml(&xml, 3);
        std::fs::write(&xml, "0").unwrap();
        let mut cur = s.reconcile(&xml).unwrap();
        for i in 1..=5 {
            std::fs::write(&xml, i.to_string()).unwrap();
            cur = Some(s.record(&xml, cur, Bump::Patch).unwrap());
        }
        let kept: Vec<String> = s.list().iter().map(|(v, _)| v.to_string()).collect();
        assert_eq!(kept, ["1.0.0", "1.0.3", "1.0.4", "1.0.5"]);
    }
}
