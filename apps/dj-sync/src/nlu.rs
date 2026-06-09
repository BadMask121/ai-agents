use crate::parser::extract_spotify_ref;

pub enum NluCommand {
    Sync(crate::parser::SpotifyRef),
    Scan,
    Missing,
    Help,
    Unknown,
}

pub async fn parse_freeform(text: &str) -> NluCommand {
    if let Some(r) = extract_spotify_ref(text) {
        return NluCommand::Sync(r);
    }
    let lower = text.to_lowercase();
    if lower.contains("scan") || lower.contains("rescan") {
        return NluCommand::Scan;
    }
    if lower.contains("missing") || lower.contains("buy list") {
        return NluCommand::Missing;
    }
    if lower.contains("help") || lower.contains("how") {
        return NluCommand::Help;
    }
    NluCommand::Unknown
}
