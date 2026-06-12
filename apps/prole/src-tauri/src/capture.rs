use std::path::{Path, PathBuf};
use std::process::ExitStatus;

#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("capture cancelled")]
    Cancelled,
    #[error("failed to launch screencapture: {0}")]
    Spawn(#[from] std::io::Error),
}

/// Seam so tests can run without invoking the real binary.
pub trait CommandRunner {
    fn run(&self, program: &str, args: &[&str]) -> std::io::Result<ExitStatus>;
}

pub struct ScreencaptureRunner;
impl CommandRunner for ScreencaptureRunner {
    fn run(&self, program: &str, args: &[&str]) -> std::io::Result<ExitStatus> {
        std::process::Command::new(program).args(args).status()
    }
}

/// Runs interactive region capture to `out_path`. Returns the path if a
/// non-empty file was produced, else `Cancelled` (user pressed Esc).
pub fn capture_region_with<R: CommandRunner>(
    runner: &R,
    out_path: &Path,
) -> Result<PathBuf, CaptureError> {
    let path_str = out_path.to_str().expect("temp path is valid UTF-8");
    runner.run("/usr/sbin/screencapture", &["-i", "-x", path_str])?;
    match std::fs::metadata(out_path) {
        Ok(meta) if meta.len() > 0 => Ok(out_path.to_path_buf()),
        _ => Err(CaptureError::Cancelled),
    }
}

/// Convenience wrapper used by the app: captures to a fresh temp file.
pub fn capture_region() -> Result<PathBuf, CaptureError> {
    let out = std::env::temp_dir().join(format!("prole-{}.png", std::process::id()));
    capture_region_with(&ScreencaptureRunner, &out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    struct FakeRunner { writes_file: bool }
    impl CommandRunner for FakeRunner {
        fn run(&self, _p: &str, args: &[&str]) -> std::io::Result<ExitStatus> {
            if self.writes_file {
                std::fs::write(args.last().unwrap(), b"\x89PNGfake")?;
            }
            Ok(ExitStatus::from_raw(0))
        }
    }

    #[test]
    fn returns_path_when_file_written() {
        let dir = std::env::temp_dir().join("prole_test_ok");
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("snip.png");
        let _ = std::fs::remove_file(&out);
        let runner = FakeRunner { writes_file: true };
        let got = capture_region_with(&runner, &out).unwrap();
        assert_eq!(got, out);
        std::fs::remove_file(&out).unwrap();
    }

    #[test]
    fn cancelled_when_no_file() {
        let out = std::env::temp_dir().join("prole_test_cancel/none.png");
        let _ = std::fs::remove_file(&out);
        let runner = FakeRunner { writes_file: false };
        assert!(matches!(
            capture_region_with(&runner, &out),
            Err(CaptureError::Cancelled)
        ));
    }
}
