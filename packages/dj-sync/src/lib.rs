pub mod ai_assist;
pub mod bot;
pub mod config;
pub mod library;
pub mod matcher;
pub mod nlu;
pub mod parser;
pub mod rekordbox;
pub mod rekordbox_xml;
pub mod spotify;
pub mod usb;

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct SpotifyTrack {
    pub spotify_id: String,
    pub isrc: Option<String>,
    pub artist: String,
    pub title: String,
    pub album: String,
    pub duration_ms: u32,
}

#[derive(Debug, Clone)]
pub struct LocalTrack {
    pub path: PathBuf,
    pub isrc: Option<String>,
    pub artist: String,
    pub title: String,
    pub duration_ms: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    Isrc,
    FuzzyHigh,
    FuzzyLow,
    AiAssisted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissReason {
    NotInLibrary,
    AmbiguousFuzzy,
    AiUncertain,
}

#[derive(Debug, Clone)]
pub enum MatchResult {
    Hit {
        spotify: SpotifyTrack,
        local: LocalTrack,
        confidence: Confidence,
    },
    Miss {
        spotify: SpotifyTrack,
        reason: MissReason,
    },
}

impl MatchResult {
    pub fn spotify(&self) -> &SpotifyTrack {
        match self {
            MatchResult::Hit { spotify, .. } | MatchResult::Miss { spotify, .. } => spotify,
        }
    }
}
