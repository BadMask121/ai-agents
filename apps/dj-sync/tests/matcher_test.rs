use std::path::PathBuf;

use dj_sync::config::MatcherCfg;
use dj_sync::library::LibraryIndex;
use dj_sync::matcher::match_one;
use dj_sync::{Confidence, LocalTrack, MatchResult, SpotifyTrack};

fn cfg() -> MatcherCfg {
    MatcherCfg {
        fuzzy_accept: 0.92,
        ai_budget_per_playlist: 0,
    }
}

#[test]
fn isrc_hit_takes_priority_over_fuzzy_decoy() {
    let lib = LibraryIndex::from_tracks_for_test(vec![
        LocalTrack {
            path: PathBuf::from("/lib/a.mp3"),
            isrc: Some("USRC17607839".into()),
            artist: "Totally Different".into(),
            title: "Mismatched Name".into(),
            duration_ms: None,
        },
        LocalTrack {
            path: PathBuf::from("/lib/b.mp3"),
            isrc: None,
            artist: "Daft Punk".into(),
            title: "One More Time".into(),
            duration_ms: None,
        },
    ]);
    let spotify = SpotifyTrack {
        spotify_id: "x".into(),
        isrc: Some("US-RC1-76-07839".into()),
        artist: "Daft Punk".into(),
        title: "One More Time".into(),
        album: "Discovery".into(),
        duration_ms: 320_000,
    };
    match match_one(&spotify, &lib, &cfg()) {
        MatchResult::Hit { local, confidence, .. } => {
            assert_eq!(confidence, Confidence::Isrc);
            assert_eq!(local.path, PathBuf::from("/lib/a.mp3"));
        }
        MatchResult::Miss { .. } => panic!("expected ISRC hit"),
    }
}

#[test]
fn fuzzy_hit_when_no_isrc() {
    let lib = LibraryIndex::from_tracks_for_test(vec![LocalTrack {
        path: PathBuf::from("/lib/c.mp3"),
        isrc: None,
        artist: "Daft Punk".into(),
        title: "One More Time".into(),
        duration_ms: None,
    }]);
    let spotify = SpotifyTrack {
        spotify_id: "x".into(),
        isrc: None,
        artist: "daft punk".into(),
        title: "One More Time".into(),
        album: "Discovery".into(),
        duration_ms: 320_000,
    };
    assert!(matches!(
        match_one(&spotify, &lib, &cfg()),
        MatchResult::Hit { .. }
    ));
}

#[test]
fn miss_when_library_empty() {
    let lib = LibraryIndex::from_tracks_for_test(vec![]);
    let spotify = SpotifyTrack {
        spotify_id: "x".into(),
        isrc: Some("USRC17607839".into()),
        artist: "Daft Punk".into(),
        title: "One More Time".into(),
        album: "Discovery".into(),
        duration_ms: 320_000,
    };
    assert!(matches!(
        match_one(&spotify, &lib, &cfg()),
        MatchResult::Miss { .. }
    ));
}
