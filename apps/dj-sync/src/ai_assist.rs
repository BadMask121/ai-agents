use crate::{LocalTrack, SpotifyTrack};

pub struct AiAssistResult {
    pub picked: Option<usize>,
}

pub async fn assist(
    _spotify: &SpotifyTrack,
    _candidates: &[LocalTrack],
) -> anyhow::Result<AiAssistResult> {
    if std::env::var("ANTHROPIC_API_KEY").is_err() {
        return Ok(AiAssistResult { picked: None });
    }
    Ok(AiAssistResult { picked: None })
}
