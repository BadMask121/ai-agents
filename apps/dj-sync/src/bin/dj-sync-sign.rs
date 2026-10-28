//! Release signing for DJ Sync (not shipped):
//!
//!   dj-sync-sign keygen            create ~/.dj-sync-release/ed25519.key (0600) once
//!   dj-sync-sign pubkey            print the public key (base64) to compile in
//!   dj-sync-sign sign FILE…        write FILE.sig next to each file
//!   dj-sync-sign verify FILE       check FILE.sig against the compiled-in key
//!
//! `DJ_SYNC_RELEASE_KEY=<path>` overrides the key file.

use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;

use anyhow::{bail, Context};
use dj_sync::signing;

fn key_path() -> anyhow::Result<PathBuf> {
    if let Some(p) = std::env::var_os("DJ_SYNC_RELEASE_KEY") {
        return Ok(PathBuf::from(p));
    }
    Ok(dirs::home_dir()
        .context("no home directory")?
        .join(".dj-sync-release/ed25519.key"))
}

fn load_key() -> anyhow::Result<ed25519_dalek::SigningKey> {
    let path = key_path()?;
    let text = std::fs::read_to_string(&path).with_context(|| {
        format!(
            "reading {} (run `dj-sync-sign keygen` once)",
            path.display()
        )
    })?;
    signing::parse_secret_key(&text)
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("keygen") => {
            let path = key_path()?;
            if path.exists() {
                bail!(
                    "{} already exists; refusing to replace a release key",
                    path.display()
                );
            }
            if let Some(dir) = path.parent() {
                std::fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(dir)?;
            }
            let key = signing::generate()?;
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)?;
            std::io::Write::write_all(&mut f, signing::encode_secret_key(&key).as_bytes())?;
            eprintln!(
                "wrote {} — back it up somewhere safe (password manager)",
                path.display()
            );
            println!("{}", signing::encode_public_key(&key.verifying_key()));
        }
        Some("pubkey") => println!(
            "{}",
            signing::encode_public_key(&load_key()?.verifying_key())
        ),
        Some("sign") if args.len() > 1 => {
            let key = load_key()?;
            for file in &args[1..] {
                let data = std::fs::read(file).with_context(|| format!("reading {file}"))?;
                std::fs::write(format!("{file}.sig"), signing::sign(&key, &data) + "\n")?;
                eprintln!("signed {file}");
            }
        }
        Some("verify") if args.len() == 2 => {
            let data = std::fs::read(&args[1])?;
            let sig = std::fs::read_to_string(format!("{}.sig", args[1]))?;
            signing::verify(&signing::release_key(), &data, &sig)?;
            eprintln!("ok: {} is signed by the release key", args[1]);
        }
        _ => bail!("usage: dj-sync-sign keygen | pubkey | sign FILE… | verify FILE"),
    }
    Ok(())
}
