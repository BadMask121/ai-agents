//! Opt-in check against a real Rekordbox export:
//!
//! ```bash
//! DJ_SYNC_REAL_XML=~/path/to/rekordbox.xml cargo test --test location_roundtrip -- --ignored
//! ```
//!
//! Every `Location` must survive decode → encode unchanged, which proves our
//! writer produces the exact strings Rekordbox itself would.

use dj_sync::{location_path, location_uri};

#[test]
#[ignore]
fn real_export_locations_round_trip() {
    let Ok(path) = std::env::var("DJ_SYNC_REAL_XML") else {
        eprintln!("DJ_SYNC_REAL_XML not set; skipping");
        return;
    };
    let xml = std::fs::read_to_string(&path).expect("read export");

    let mut checked = 0usize;
    let mut mismatches = Vec::new();
    for chunk in xml.split("Location=\"").skip(1) {
        let Some(end) = chunk.find('"') else { continue };
        // Attribute values are XML-escaped; Locations only ever contain &amp;.
        let loc = chunk[..end].replace("&amp;", "&");
        let again = location_uri(&location_path(&loc));
        if again != loc {
            mismatches.push((loc, again));
        }
        checked += 1;
    }

    assert!(checked > 0, "no Location attributes found in {path}");
    assert!(
        mismatches.is_empty(),
        "{} of {checked} Locations did not round-trip; first: {:?}",
        mismatches.len(),
        mismatches.first()
    );
    eprintln!("{checked} Locations round-tripped");
}
