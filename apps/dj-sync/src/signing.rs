//! Ed25519 signatures for what DJ Sync downloads from its own server: the
//! tools manifest (`toolbox.rs`) and the app update feed. Detached, base64,
//! over the file's exact bytes. The private key never enters the repo
//! (`~/.dj-sync-release/ed25519.key`, see `dj-sync-sign`).

use anyhow::{anyhow, Context};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

/// The release public key compiled into dj-sync (and the menu app's updater).
pub const RELEASE_PUBLIC_KEY: &str = "p43nEWbe6SB4Fi/vAcdi87m55M3+NQBhVpz+gjXG4L4=";

pub fn release_key() -> VerifyingKey {
    parse_public_key(RELEASE_PUBLIC_KEY).expect("RELEASE_PUBLIC_KEY is valid")
}

pub fn parse_public_key(b64: &str) -> anyhow::Result<VerifyingKey> {
    let bytes: [u8; 32] = B64
        .decode(b64.trim())
        .context("public key is not base64")?
        .try_into()
        .map_err(|_| anyhow!("public key must be 32 bytes"))?;
    VerifyingKey::from_bytes(&bytes).context("invalid Ed25519 public key")
}

pub fn parse_secret_key(b64: &str) -> anyhow::Result<SigningKey> {
    let bytes: [u8; 32] = B64
        .decode(b64.trim())
        .context("secret key is not base64")?
        .try_into()
        .map_err(|_| anyhow!("secret key must be 32 bytes"))?;
    Ok(SigningKey::from_bytes(&bytes))
}

pub fn encode_public_key(key: &VerifyingKey) -> String {
    B64.encode(key.as_bytes())
}

pub fn encode_secret_key(key: &SigningKey) -> String {
    B64.encode(key.to_bytes())
}

/// Base64 detached signature over `data`.
pub fn sign(key: &SigningKey, data: &[u8]) -> String {
    B64.encode(key.sign(data).to_bytes())
}

/// Checks a base64 detached signature (surrounding whitespace allowed).
pub fn verify(key: &VerifyingKey, data: &[u8], signature_b64: &str) -> anyhow::Result<()> {
    let bytes: [u8; 64] = B64
        .decode(signature_b64.trim())
        .context("signature is not base64")?
        .try_into()
        .map_err(|_| anyhow!("signature must be 64 bytes"))?;
    key.verify(data, &Signature::from_bytes(&bytes))
        .map_err(|_| anyhow!("signature does not match"))
}

/// A fresh key from the OS's randomness.
pub fn generate() -> anyhow::Result<SigningKey> {
    let mut seed = [0u8; 32];
    std::io::Read::read_exact(
        &mut std::fs::File::open("/dev/urandom").context("opening /dev/urandom")?,
        &mut seed,
    )?;
    Ok(SigningKey::from_bytes(&seed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_round_trip_and_catch_tampering() {
        let sk = generate().unwrap();
        let pk = sk.verifying_key();
        let sig = sign(&sk, b"manifest");
        verify(&pk, b"manifest", &format!("{sig}\n")).unwrap();
        assert!(verify(&pk, b"manifest!", &sig).is_err());
        assert!(verify(&generate().unwrap().verifying_key(), b"manifest", &sig).is_err());
        assert!(verify(&pk, b"manifest", "not base64!").is_err());
        let again = parse_secret_key(&encode_secret_key(&sk)).unwrap();
        assert_eq!(
            parse_public_key(&encode_public_key(&pk)).unwrap(),
            again.verifying_key()
        );
    }

    #[test]
    fn the_compiled_in_release_key_is_valid() {
        release_key();
    }
}
