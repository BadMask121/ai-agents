//! The DJ's personal iPhone Shortcut "DJ Sync" (connect-anywhere spec §2b):
//! built here with the API address and key baked in, signed by macOS
//! (`shortcuts sign`, which uses the DJ's own Apple ID), then uploaded so the
//! iPhone can install it from a QR code in one tap.
//!
//! What it does, from the Share sheet in Spotify or YouTube:
//! 1. Get Contents of URL — GET `<base>/api/playlists` (Authorization header)
//! 2. Get Dictionary Value `names`
//! 3. Choose from List — "Add to which playlist?"
//! 4. Get Contents of URL — POST `<base>/api/downloads`, JSON
//!    `{text: Shortcut Input, playlist_name: Chosen Item}`
//! 5. Get Dictionary Value `message`
//! 6. Show Notification "DJ Sync" with that message

use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use plist::{Dictionary, Value};

/// Fixed per action: they only need to be unique inside this one Shortcut,
/// and fixed keeps the builder pure.
const GET_PLAYLISTS: &str = "8E7C1D4A-2B6F-4F1E-9A3C-5D0B7E1F2A01";
const NAMES: &str = "8E7C1D4A-2B6F-4F1E-9A3C-5D0B7E1F2A02";
const CHOOSE: &str = "8E7C1D4A-2B6F-4F1E-9A3C-5D0B7E1F2A03";
const SEND: &str = "8E7C1D4A-2B6F-4F1E-9A3C-5D0B7E1F2A04";
const MESSAGE: &str = "8E7C1D4A-2B6F-4F1E-9A3C-5D0B7E1F2A05";
const NOTIFY: &str = "8E7C1D4A-2B6F-4F1E-9A3C-5D0B7E1F2A06";

/// The unsigned Shortcut plist. `base` is the API origin
/// (`https://djsync.jeffrey.build`), `token` the shortcut link's key
/// (`<tenant_id>.<secret>`).
pub fn build(base: &str, token: &str) -> Value {
    let base = base.trim_end_matches('/');
    let actions = vec![
        action(
            "is.workflow.actions.downloadurl",
            dict([
                ("UUID", s(GET_PLAYLISTS)),
                ("WFURL", s(&format!("{base}/api/playlists"))),
                ("WFHTTPMethod", s("GET")),
                ("ShowHeaders", Value::Boolean(true)),
                (
                    "WFHTTPHeaders",
                    field_dict(vec![("Authorization", text(&format!("Bearer {token}")))]),
                ),
            ]),
        ),
        action(
            "is.workflow.actions.getvalueforkey",
            dict([
                ("UUID", s(NAMES)),
                ("WFGetDictionaryValueType", s("Value")),
                ("WFDictionaryKey", s("names")),
                (
                    "WFInput",
                    attachment(output(GET_PLAYLISTS, "Contents of URL")),
                ),
            ]),
        ),
        action(
            "is.workflow.actions.choosefromlist",
            dict([
                ("UUID", s(CHOOSE)),
                ("WFInput", attachment(output(NAMES, "Dictionary Value"))),
                ("WFChooseFromListActionPrompt", s("Add to which playlist?")),
            ]),
        ),
        action(
            "is.workflow.actions.downloadurl",
            dict([
                ("UUID", s(SEND)),
                ("WFURL", s(&format!("{base}/api/downloads"))),
                ("WFHTTPMethod", s("POST")),
                ("ShowHeaders", Value::Boolean(true)),
                (
                    "WFHTTPHeaders",
                    field_dict(vec![("Authorization", text(&format!("Bearer {token}")))]),
                ),
                ("WFHTTPBodyType", s("JSON")),
                (
                    "WFJSONValues",
                    field_dict(vec![
                        ("text", token_string(extension_input())),
                        ("playlist_name", token_string(output(CHOOSE, "Chosen Item"))),
                    ]),
                ),
            ]),
        ),
        action(
            "is.workflow.actions.getvalueforkey",
            dict([
                ("UUID", s(MESSAGE)),
                ("WFGetDictionaryValueType", s("Value")),
                ("WFDictionaryKey", s("message")),
                ("WFInput", attachment(output(SEND, "Contents of URL"))),
            ]),
        ),
        action(
            "is.workflow.actions.notification",
            dict([
                ("UUID", s(NOTIFY)),
                ("WFNotificationActionTitle", s("DJ Sync")),
                (
                    "WFNotificationActionBody",
                    token_string(output(MESSAGE, "Dictionary Value")),
                ),
                ("WFNotificationActionSound", Value::Boolean(true)),
            ]),
        ),
    ];

    dict([
        ("WFWorkflowMinimumClientVersion", Value::Integer(900.into())),
        ("WFWorkflowMinimumClientVersionString", s("900")),
        ("WFWorkflowClientVersion", s("2302.0.4")),
        (
            "WFWorkflowIcon",
            dict([
                // Purple, like the app; a music-note glyph.
                (
                    "WFWorkflowIconStartColor",
                    Value::Integer(2071128575u64.into()),
                ),
                ("WFWorkflowIconGlyphNumber", Value::Integer(61447.into())),
            ]),
        ),
        ("WFWorkflowImportQuestions", Value::Array(vec![])),
        // Share sheet only, for links and text.
        ("WFWorkflowTypes", Value::Array(vec![s("ActionExtension")])),
        (
            "WFWorkflowInputContentItemClasses",
            Value::Array(vec![s("WFURLContentItem"), s("WFStringContentItem")]),
        ),
        ("WFWorkflowHasShortcutInputVariables", Value::Boolean(true)),
        ("WFWorkflowOutputContentItemClasses", Value::Array(vec![])),
        ("WFWorkflowActions", Value::Array(actions)),
    ])
}

/// `build` as the binary plist `shortcuts sign` takes.
pub fn unsigned_bytes(base: &str, token: &str) -> anyhow::Result<Vec<u8>> {
    let mut out = Vec::new();
    plist::to_writer_binary(&mut out, &build(base, token)).context("encoding the Shortcut")?;
    Ok(out)
}

/// Signs with `/usr/bin/shortcuts sign --mode anyone`. Needs this Mac's user
/// to be signed into iCloud; takes a few seconds. The key is in the files, so
/// they live in a private temp dir that's removed afterwards.
pub async fn sign(unsigned: &[u8]) -> anyhow::Result<Vec<u8>> {
    sign_with(Path::new("/usr/bin/shortcuts"), unsigned).await
}

pub async fn sign_with(tool: &Path, unsigned: &[u8]) -> anyhow::Result<Vec<u8>> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let dir = std::env::temp_dir().join(format!("dj-sync-shortcut-{}", uuid::Uuid::new_v4()));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .context("making a temp dir")?;
    let result = async {
        let input = dir.join("DJ Sync.shortcut");
        let output = dir.join("DJ Sync signed.shortcut");
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&input)?;
            f.write_all(unsigned)?;
        }
        let mut cmd = tokio::process::Command::new(tool);
        cmd.args(["sign", "--mode", "anyone", "--input"])
            .arg(&input)
            .arg("--output")
            .arg(&output)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        let out = tokio::time::timeout(Duration::from_secs(60), cmd.output())
            .await
            .map_err(|_| anyhow!("macOS took too long to sign the Shortcut"))?
            .context("running shortcuts sign")?;
        if !out.status.success() {
            let why = String::from_utf8_lossy(&out.stderr);
            let why = why
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .trim();
            bail!(
                "macOS couldn't sign the Shortcut{}",
                if why.is_empty() {
                    String::new()
                } else {
                    format!(": {why}")
                }
            );
        }
        let signed = std::fs::read(&output).context("reading the signed Shortcut")?;
        // Signed Shortcuts are Apple Encrypted Archives.
        if !signed.starts_with(b"AEA1") {
            bail!("macOS returned something that isn't a signed Shortcut");
        }
        anyhow::Ok(signed)
    }
    .await;
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// The API origin a shortcut link's `api_url` (`…/api/downloads`) points at.
pub fn base_of(api_url: &str) -> Option<String> {
    let u = url::Url::parse(api_url).ok()?;
    if u.scheme() != "https" && u.host_str() != Some("127.0.0.1") {
        return None;
    }
    let mut origin = u.origin().ascii_serialization();
    if origin == "null" {
        return None;
    }
    origin.truncate(origin.trim_end_matches('/').len());
    Some(origin)
}

// ---------- plist helpers ----------

fn s(v: &str) -> Value {
    Value::String(v.to_string())
}

fn dict<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut d = Dictionary::new();
    for (k, v) in pairs {
        d.insert(k.to_string(), v);
    }
    Value::Dictionary(d)
}

fn action(identifier: &str, parameters: Value) -> Value {
    dict([
        ("WFWorkflowActionIdentifier", s(identifier)),
        ("WFWorkflowActionParameters", parameters),
    ])
}

/// A variable: another action's output.
fn output(uuid: &str, name: &str) -> Value {
    dict([
        ("Type", s("ActionOutput")),
        ("OutputUUID", s(uuid)),
        ("OutputName", s(name)),
    ])
}

/// A variable: what the Share sheet passed in ("Shortcut Input").
fn extension_input() -> Value {
    dict([("Type", s("ExtensionInput"))])
}

/// A parameter that is exactly one variable.
fn attachment(variable: Value) -> Value {
    dict([
        ("Value", variable),
        ("WFSerializationType", s("WFTextTokenAttachment")),
    ])
}

/// Text that is one variable (the object-replacement char stands for it).
fn token_string(variable: Value) -> Value {
    let mut ranges = Dictionary::new();
    ranges.insert("{0, 1}".to_string(), variable);
    dict([
        (
            "Value",
            dict([
                ("string", s("\u{fffc}")),
                ("attachmentsByRange", Value::Dictionary(ranges)),
            ]),
        ),
        ("WFSerializationType", s("WFTextTokenString")),
    ])
}

/// Plain text.
fn text(v: &str) -> Value {
    dict([
        ("Value", dict([("string", s(v))])),
        ("WFSerializationType", s("WFTextTokenString")),
    ])
}

/// A dictionary parameter (headers, JSON body) of text fields.
fn field_dict(items: Vec<(&str, Value)>) -> Value {
    let items = items
        .into_iter()
        .map(|(key, value)| {
            dict([
                ("WFItemType", Value::Integer(0.into())),
                ("WFKey", text(key)),
                ("WFValue", value),
            ])
        })
        .collect();
    dict([
        (
            "Value",
            dict([("WFDictionaryFieldValueItems", Value::Array(items))]),
        ),
        ("WFSerializationType", s("WFDictionaryFieldValue")),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://djsync.jeffrey.build";
    const TOKEN: &str = "u2dDy37bIx227JDdDMLBoA.secretSECRETsecret_0123456789-abcdefghij";

    fn actions(v: &Value) -> &Vec<Value> {
        v.as_dictionary().unwrap()["WFWorkflowActions"]
            .as_array()
            .unwrap()
    }

    fn params(a: &Value) -> &Dictionary {
        a.as_dictionary().unwrap()["WFWorkflowActionParameters"]
            .as_dictionary()
            .unwrap()
    }

    fn id(a: &Value) -> &str {
        a.as_dictionary().unwrap()["WFWorkflowActionIdentifier"]
            .as_string()
            .unwrap()
    }

    /// Every plain string in the plist, depth first.
    fn strings(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::String(s) => out.push(s.clone()),
            Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
            Value::Dictionary(d) => d.values().for_each(|x| strings(x, out)),
            _ => {}
        }
    }

    #[test]
    fn six_actions_from_the_share_sheet() {
        let v = build(BASE, TOKEN);
        let top = v.as_dictionary().unwrap();
        assert_eq!(
            top["WFWorkflowTypes"],
            Value::Array(vec![s("ActionExtension")])
        );
        assert_eq!(
            top["WFWorkflowInputContentItemClasses"],
            Value::Array(vec![s("WFURLContentItem"), s("WFStringContentItem")])
        );
        let ids: Vec<&str> = actions(&v).iter().map(id).collect();
        assert_eq!(
            ids,
            [
                "is.workflow.actions.downloadurl",
                "is.workflow.actions.getvalueforkey",
                "is.workflow.actions.choosefromlist",
                "is.workflow.actions.downloadurl",
                "is.workflow.actions.getvalueforkey",
                "is.workflow.actions.notification",
            ]
        );
        let uuids: std::collections::HashSet<&str> = actions(&v)
            .iter()
            .map(|a| params(a)["UUID"].as_string().unwrap())
            .collect();
        assert_eq!(uuids.len(), 6, "unique action UUIDs");
    }

    #[test]
    fn requests_go_to_the_api_with_the_key() {
        let v = build("https://djsync.jeffrey.build/", TOKEN);
        let a = actions(&v);
        assert_eq!(
            params(&a[0])["WFURL"],
            s("https://djsync.jeffrey.build/api/playlists")
        );
        assert_eq!(params(&a[0])["WFHTTPMethod"], s("GET"));
        assert_eq!(
            params(&a[3])["WFURL"],
            s("https://djsync.jeffrey.build/api/downloads")
        );
        assert_eq!(params(&a[3])["WFHTTPMethod"], s("POST"));
        assert_eq!(params(&a[3])["WFHTTPBodyType"], s("JSON"));
        for i in [0, 3] {
            let items = params(&a[i])["WFHTTPHeaders"].as_dictionary().unwrap()["Value"]
                .as_dictionary()
                .unwrap()["WFDictionaryFieldValueItems"]
                .as_array()
                .unwrap();
            assert_eq!(items.len(), 1);
            let item = items[0].as_dictionary().unwrap();
            assert_eq!(item["WFKey"], text("Authorization"));
            assert_eq!(item["WFValue"], text(&format!("Bearer {TOKEN}")));
        }
        // The key appears in the two Authorization headers and nowhere else.
        let mut all = Vec::new();
        strings(&v, &mut all);
        assert_eq!(all.iter().filter(|x| x.contains(TOKEN)).count(), 2);
        assert!(all
            .iter()
            .filter(|x| x.contains(TOKEN))
            .all(|x| x == &format!("Bearer {TOKEN}")));
    }

    #[test]
    fn variables_are_wired_action_to_action() {
        let v = build(BASE, TOKEN);
        let a = actions(&v);
        let input_of =
            |i: usize| params(&a[i])["WFInput"].as_dictionary().unwrap()["Value"].clone();
        assert_eq!(input_of(1), output(GET_PLAYLISTS, "Contents of URL"));
        assert_eq!(params(&a[1])["WFDictionaryKey"], s("names"));
        assert_eq!(input_of(2), output(NAMES, "Dictionary Value"));
        assert_eq!(input_of(4), output(SEND, "Contents of URL"));
        assert_eq!(params(&a[4])["WFDictionaryKey"], s("message"));

        let body = params(&a[3])["WFJSONValues"].as_dictionary().unwrap()["Value"]
            .as_dictionary()
            .unwrap()["WFDictionaryFieldValueItems"]
            .as_array()
            .unwrap();
        let field = |k: &str| {
            body.iter()
                .map(|x| x.as_dictionary().unwrap())
                .find(|x| x["WFKey"] == text(k))
                .unwrap()["WFValue"]
                .clone()
        };
        assert_eq!(field("text"), token_string(extension_input()));
        assert_eq!(
            field("playlist_name"),
            token_string(output(CHOOSE, "Chosen Item"))
        );
        assert_eq!(
            params(&a[5])["WFNotificationActionBody"],
            token_string(output(MESSAGE, "Dictionary Value"))
        );
        // The token string is one placeholder char with the variable at {0, 1}.
        let ts = token_string(extension_input());
        let inner = ts.as_dictionary().unwrap()["Value"]
            .as_dictionary()
            .unwrap();
        assert_eq!(inner["string"], s("\u{fffc}"));
        assert!(inner["attachmentsByRange"]
            .as_dictionary()
            .unwrap()
            .contains_key("{0, 1}"));
    }

    #[test]
    fn encodes_as_a_binary_plist() {
        let bytes = unsigned_bytes(BASE, TOKEN).unwrap();
        assert!(bytes.starts_with(b"bplist00"));
        let back: Value = plist::from_bytes(&bytes).unwrap();
        assert_eq!(back, build(BASE, TOKEN));
    }

    #[test]
    fn api_origin_comes_from_the_link() {
        assert_eq!(
            base_of("https://djsync.jeffrey.build/api/downloads").as_deref(),
            Some("https://djsync.jeffrey.build")
        );
        assert_eq!(
            base_of("https://mcp.triplejmusic.art/api/downloads").as_deref(),
            Some("https://mcp.triplejmusic.art")
        );
        assert_eq!(base_of("http://evil.example/api/downloads"), None);
        assert_eq!(base_of("not a url"), None);
    }

    #[tokio::test]
    async fn a_failing_signer_is_an_error_and_cleans_up() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = tmp.path().join("shortcuts");
        std::fs::write(
            &fake,
            "#!/bin/sh\necho 'You must be signed in to iCloud' >&2\nexit 1\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = sign_with(&fake, b"bplist00").await.unwrap_err();
        assert!(
            format!("{err:#}").contains("signed in to iCloud"),
            "{err:#}"
        );
    }

    #[tokio::test]
    async fn a_signer_must_produce_a_signed_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = tmp.path().join("shortcuts");
        // Copies input to output: "signed" but not an AEA archive.
        std::fs::write(&fake, "#!/bin/sh\ncp \"$5\" \"$7\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(sign_with(&fake, b"bplist00").await.is_err());
        std::fs::write(&fake, "#!/bin/sh\nprintf 'AEA1signed' > \"$7\"\n").unwrap();
        assert_eq!(sign_with(&fake, b"bplist00").await.unwrap(), b"AEA1signed");
    }

    /// `SHORTCUT_OUT=<dir> cargo test real_sign -- --ignored` — signs a real
    /// build with this Mac's Apple ID (needs iCloud).
    #[tokio::test]
    #[ignore = "uses this Mac's iCloud identity"]
    async fn real_sign() {
        let dir = std::path::PathBuf::from(std::env::var("SHORTCUT_OUT").expect("SHORTCUT_OUT"));
        let unsigned = unsigned_bytes(BASE, "TEST.not-a-real-key").unwrap();
        std::fs::write(dir.join("unsigned.shortcut"), &unsigned).unwrap();
        let signed = sign(&unsigned).await.unwrap();
        std::fs::write(dir.join("signed.shortcut"), &signed).unwrap();
        assert!(signed.starts_with(b"AEA1"));
    }
}
