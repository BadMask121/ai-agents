use std::path::Path;

use tracing::warn;

pub struct UsbSyncResult {
    pub copied: usize,
    pub skipped_reason: Option<String>,
}

pub fn sync(_autoimport_dir: &Path, mount: Option<&Path>) -> anyhow::Result<UsbSyncResult> {
    let Some(mount) = mount else {
        return Ok(UsbSyncResult {
            copied: 0,
            skipped_reason: Some("no usb.mount configured".into()),
        });
    };

    if !mount.exists() {
        warn!(mount = %mount.display(), "configured USB mount not present");
        return Ok(UsbSyncResult {
            copied: 0,
            skipped_reason: Some(format!("mount {} not present", mount.display())),
        });
    }

    Ok(UsbSyncResult {
        copied: 0,
        skipped_reason: Some("usb sync stub: not implemented in v1".into()),
    })
}
