use std::path::{Path, PathBuf};

use anyhow::Context;
use tracing::{info, warn};

use crate::{LocalTrack, MatchResult};

pub struct ImportSummary {
    pub copied: usize,
    pub skipped_existing: usize,
}

pub fn import_matches(
    autoimport_dir: &Path,
    matches: &[MatchResult],
) -> anyhow::Result<ImportSummary> {
    if !autoimport_dir.exists() {
        std::fs::create_dir_all(autoimport_dir)
            .with_context(|| format!("creating {}", autoimport_dir.display()))?;
    }

    let mut copied = 0;
    let mut skipped_existing = 0;

    for m in matches {
        if let MatchResult::Hit { local, .. } = m {
            match copy_one(local, autoimport_dir)? {
                CopyOutcome::Copied => copied += 1,
                CopyOutcome::SkippedExisting => skipped_existing += 1,
            }
        }
    }

    info!(copied, skipped_existing, "rekordbox import done");
    Ok(ImportSummary {
        copied,
        skipped_existing,
    })
}

enum CopyOutcome {
    Copied,
    SkippedExisting,
}

fn copy_one(local: &LocalTrack, dest_dir: &Path) -> anyhow::Result<CopyOutcome> {
    let src = &local.path;
    let file_name = src
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("source has no file name: {}", src.display()))?;
    let dest = dest_dir.join(file_name);

    if dest.exists() {
        let src_size = std::fs::metadata(src)?.len();
        let dst_size = std::fs::metadata(&dest)?.len();
        if src_size == dst_size {
            return Ok(CopyOutcome::SkippedExisting);
        }
        let unique = unique_name(&dest);
        warn!(
            target_existing = %dest.display(),
            new_target = %unique.display(),
            "destination exists with different size; writing under unique name",
        );
        std::fs::copy(src, unique).context("copy with unique name")?;
        return Ok(CopyOutcome::Copied);
    }

    std::fs::copy(src, &dest)
        .with_context(|| format!("copy {} -> {}", src.display(), dest.display()))?;
    Ok(CopyOutcome::Copied)
}

fn unique_name(target: &Path) -> PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let stem = target.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
    let ext = target.extension().and_then(|s| s.to_str()).unwrap_or("");
    for n in 1..1000 {
        let candidate = if ext.is_empty() {
            parent.join(format!("{stem} ({n})"))
        } else {
            parent.join(format!("{stem} ({n}).{ext}"))
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{stem}-{}.{}", std::process::id(), ext))
}
