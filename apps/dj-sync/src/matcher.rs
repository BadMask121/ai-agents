use strsim::jaro_winkler;
use unicode_normalization::UnicodeNormalization;

use crate::config::MatcherCfg;
use crate::library::LibraryIndex;
use crate::{Confidence, LocalTrack, MatchResult, MissReason, SpotifyTrack};

pub fn match_playlist(
    spotify_tracks: &[SpotifyTrack],
    library: &LibraryIndex,
    cfg: &MatcherCfg,
) -> Vec<MatchResult> {
    spotify_tracks
        .iter()
        .map(|t| match_one(t, library, cfg))
        .collect()
}

pub fn match_one(
    spotify: &SpotifyTrack,
    library: &LibraryIndex,
    cfg: &MatcherCfg,
) -> MatchResult {
    if let Some(isrc) = &spotify.isrc {
        if let Some(local) = library.lookup_isrc(isrc) {
            return MatchResult::Hit {
                spotify: spotify.clone(),
                local: local.clone(),
                confidence: Confidence::Isrc,
            };
        }
    }

    let target = normalize(&format!("{} {}", spotify.artist, spotify.title));
    let mut best: Option<(&LocalTrack, f64)> = None;
    let mut second_best_score = 0.0_f64;

    for local in library.all() {
        let candidate = normalize(&format!("{} {}", local.artist, local.title));
        let score = jaro_winkler(&target, &candidate);
        match best {
            None => best = Some((local, score)),
            Some((_, b)) if score > b => {
                second_best_score = b;
                best = Some((local, score));
            }
            Some((_, b)) if score > second_best_score && score < b => {
                second_best_score = score;
            }
            _ => {}
        }
    }

    match best {
        Some((local, score)) if score >= cfg.fuzzy_accept => MatchResult::Hit {
            spotify: spotify.clone(),
            local: local.clone(),
            confidence: if score >= 0.97 {
                Confidence::FuzzyHigh
            } else {
                Confidence::FuzzyLow
            },
        },
        Some((_, score)) if score >= 0.80 && (score - second_best_score).abs() < 0.02 => {
            MatchResult::Miss {
                spotify: spotify.clone(),
                reason: MissReason::AmbiguousFuzzy,
            }
        }
        _ => MatchResult::Miss {
            spotify: spotify.clone(),
            reason: MissReason::NotInLibrary,
        },
    }
}

fn normalize(s: &str) -> String {
    s.nfkd()
        .filter(|c| !c.is_ascii_punctuation() || *c == ' ')
        .flat_map(|c| c.to_lowercase())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
