//! Secret VALUES that `config.json` itself holds.
//!
//! The configuration names its secrets (`tokenSecret`, `passwordSecret`, `apiKeyRef`, ...) and keeps the values in the secret
//! store, which a backup never reads (R4). One property is the exception: `channels.telegram.webhook.secret` is the token
//! Telegram echoes in the `X-Telegram-Bot-Api-Secret-Token` header, and it is kept in `config.json` as a plain string. A
//! verbatim copy would put it in the archive in clear, whoever opens the archive could then pass as Telegram to the webhook,
//! and the manifest says no secrets are part of it.
//!
//! `create` therefore replaces such a value by [`PLACEHOLDER`] in its private staged copy of `config.json` (the live file is
//! never touched, and the manifest's digest describes the redacted bytes). The placeholder is not a secret and it satisfies the
//! schema's pattern for the property, so the restored configuration still validates. `restore` replaces the placeholder in its
//! staging tree by a fresh random value before the file is put in place, so that the restored installation never accepts the
//! publicly known placeholder as a webhook secret; the Telegram channel registers whatever value is configured with
//! `setWebhook` each time it starts. A config without such a value is archived and restored byte for byte.
use super::BackupError;
use serde_json::Value;
use std::fs;
use std::io;
use std::path::Path;

/// Stands where a redacted value was. It matches `^[A-Za-z0-9_-]{1,256}$` (the schema's pattern for the webhook secret).
pub const PLACEHOLDER: &str = "backup-redacted-replaced-on-restore";

/// The `config.json` properties that hold a secret VALUE, as key paths. The test `every_credential_named_string_property...`
/// reads `config.schema.json` and fails when a new property with a credential-like name that is not a by-name reference is not
/// listed here.
pub const SECRET_VALUE_PATHS: &[&[&str]] = &[&["channels", "telegram", "webhook", "secret"]];

fn slot<'a>(config: &'a mut Value, path: &[&str]) -> Option<&'a mut Value> {
    let mut cur = config;
    for key in path {
        cur = cur.get_mut(*key)?;
    }
    Some(cur)
}

/// Whether a configuration value is a real secret (not absent, not empty, not already the placeholder).
fn holds_value(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::String(s) => !s.is_empty() && s.as_str() != PLACEHOLDER,
        _ => true,
    }
}

/// The configuration text with every secret value replaced, or `None` when it held none (nothing is to be rewritten then).
fn redact(text: &[u8]) -> Result<Option<String>, serde_json::Error> {
    let mut config: Value = serde_json::from_slice(text)?;
    let mut changed = false;
    for path in SECRET_VALUE_PATHS {
        if let Some(value) = slot(&mut config, path) {
            if holds_value(value) {
                *value = Value::String(PLACEHOLDER.to_string());
                changed = true;
            }
        }
    }
    Ok(changed.then(|| plur1bus_config::serialize(&config)))
}

/// Lets the owner write the file again (a staged copy of a read-only source is read-only).
#[cfg(unix)]
fn owner_writable(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}
#[cfg(not(unix))]
fn owner_writable(path: &Path) -> io::Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    fs::set_permissions(path, permissions)
}

/// Replaces the file's content, keeping the permission bits it had (`create_private` would reset them to 0600).
fn rewrite(path: &Path, text: &str) -> io::Result<()> {
    use std::io::Write;
    let permissions = fs::metadata(path)?.permissions();
    owner_writable(path)?;
    let mut w = crate::audit::create_private(path, true)?;
    w.write_all(text.as_bytes())?;
    w.sync_all()?;
    drop(w);
    fs::set_permissions(path, permissions)
}

/// Redacts the staged copy of `config.json` in place; `Ok(true)` when a value was replaced. A file that is not JSON cannot be
/// searched for secret values, so the backup fails closed instead of archiving it unchecked.
pub fn redact_staged_config(staged: &Path) -> Result<bool, BackupError> {
    let bytes = fs::read(staged)?;
    let redacted = redact(&bytes).map_err(|e| {
        BackupError::new(
            "config-unreadable",
            format!(
                "config.json is not valid JSON ({e}), so it cannot be checked for secret values; repair it first (plur1bus 1staid repair)"
            ),
        )
    })?;
    match redacted {
        Some(text) => {
            rewrite(staged, &text)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// 32 random bytes as 64 lower-case hex characters: matches the webhook secret's pattern.
fn fresh_secret() -> io::Result<String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// `restore`: replaces a [`PLACEHOLDER`] in the staged `<staging>/config.json` by a fresh random value. Nothing happens when
/// there is no such file, no placeholder in it, or it is not JSON (the swap then puts it in place unchanged, as before).
pub fn refill_staged_config(staging: &Path) -> io::Result<bool> {
    let path = staging.join("config.json");
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    let marker = PLACEHOLDER.as_bytes();
    if !bytes.windows(marker.len()).any(|w| w == marker) {
        return Ok(false);
    }
    let Ok(mut config) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(false);
    };
    let mut changed = false;
    for path_keys in SECRET_VALUE_PATHS {
        if let Some(value) = slot(&mut config, path_keys) {
            if value.as_str() == Some(PLACEHOLDER) {
                *value = Value::String(fresh_secret()?);
                changed = true;
            }
        }
    }
    if changed {
        rewrite(&path, &plur1bus_config::serialize(&config))?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MARKER: &str = "redact-probe-unit-secret";

    fn pattern_ok(s: &str) -> bool {
        (1..=256).contains(&s.len())
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    }

    fn webhook_config(secret: &str) -> String {
        json!({
            "schemaVersion": 1,
            "channels": { "telegram": {
                "enabled": true, "tokenSecret": "telegram.bot", "mode": "webhook",
                "webhook": { "url": "https://example.test/hook", "secret": secret, "maxBodyBytes": 2048 }
            } },
            "privacy": { "localOnly": false }
        })
        .to_string()
    }

    fn secret_of(text: &str) -> String {
        let v: Value = serde_json::from_str(text).unwrap();
        v["channels"]["telegram"]["webhook"]["secret"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn the_placeholder_satisfies_the_webhook_secret_pattern() {
        assert!(pattern_ok(PLACEHOLDER), "{PLACEHOLDER}");
        assert!(pattern_ok(&fresh_secret().unwrap()));
    }

    #[test]
    fn a_webhook_secret_is_replaced_and_everything_else_in_the_config_stays() {
        let out = redact(webhook_config(MARKER).as_bytes())
            .unwrap()
            .expect("a value was redacted");
        assert!(!out.contains(MARKER), "{out}");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(secret_of(&out), PLACEHOLDER);
        assert_eq!(v["schemaVersion"], 1);
        assert_eq!(v["channels"]["telegram"]["tokenSecret"], "telegram.bot");
        assert_eq!(v["channels"]["telegram"]["mode"], "webhook");
        assert_eq!(
            v["channels"]["telegram"]["webhook"]["url"],
            "https://example.test/hook"
        );
        assert_eq!(v["channels"]["telegram"]["webhook"]["maxBodyBytes"], 2048);
        assert_eq!(v["privacy"], json!({ "localOnly": false }));
        // The redacted configuration is still one the schema accepts: a restore does not break the webhook configuration.
        plur1bus_config::parse(&out).expect("the redacted config validates");
    }

    #[test]
    fn a_config_without_a_secret_value_is_left_alone() {
        for text in [
            "{\"schemaVersion\":1}\n".to_string(),
            "{\"restored\":true}".to_string(),
            json!({ "channels": { "telegram": { "tokenSecret": "telegram.bot", "mode": "polling" } } })
                .to_string(),
            // nothing there to hide: absent, null, empty and already redacted
            json!({ "channels": { "telegram": { "webhook": { "secret": null } } } }).to_string(),
            json!({ "channels": { "telegram": { "webhook": { "secret": "" } } } }).to_string(),
            webhook_config(PLACEHOLDER),
        ] {
            assert_eq!(redact(text.as_bytes()).unwrap(), None, "{text}");
        }
    }

    #[test]
    fn a_secret_that_is_not_a_string_is_replaced_too() {
        let text = json!({ "channels": { "telegram": { "webhook": { "secret": { "nested": MARKER } } } } })
            .to_string();
        let out = redact(text.as_bytes()).unwrap().unwrap();
        assert!(!out.contains(MARKER), "{out}");
        assert_eq!(secret_of(&out), PLACEHOLDER);
    }

    #[test]
    fn the_staged_copy_is_rewritten_in_place_and_keeps_its_mode() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("config.json");
        fs::write(&p, webhook_config(MARKER)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(0o640)).unwrap();
        }
        assert!(redact_staged_config(&p).unwrap());
        let text = fs::read_to_string(&p).unwrap();
        assert!(!text.contains(MARKER) && text.ends_with('\n'), "{text}");
        assert_eq!(secret_of(&text), PLACEHOLDER);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&p).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
        // Run again: nothing left to redact, and the file does not change.
        assert!(!redact_staged_config(&p).unwrap());
        assert_eq!(fs::read_to_string(&p).unwrap(), text);
    }

    #[test]
    fn a_staged_config_without_a_secret_is_not_rewritten() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("config.json");
        let original = b"{ \"schemaVersion\": 1,   \"restored\": true }";
        fs::write(&p, original).unwrap();
        assert!(!redact_staged_config(&p).unwrap());
        assert_eq!(fs::read(&p).unwrap(), original, "byte for byte");
    }

    #[test]
    fn a_config_that_is_not_json_fails_the_backup_closed() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("config.json");
        fs::write(&p, format!("not json, but it names {MARKER}")).unwrap();
        let e = redact_staged_config(&p).unwrap_err();
        assert_eq!(e.reason, "config-unreadable");
        assert!(!e.detail.contains(MARKER), "{}", e.detail);
    }

    #[test]
    fn a_restore_replaces_the_placeholder_by_a_fresh_secret_each_time() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("config.json");
        let mut seen = std::collections::HashSet::new();
        for _ in 0..3 {
            fs::write(&p, webhook_config(PLACEHOLDER)).unwrap();
            assert!(refill_staged_config(d.path()).unwrap());
            let text = fs::read_to_string(&p).unwrap();
            let secret = secret_of(&text);
            assert_ne!(secret, PLACEHOLDER);
            assert!(pattern_ok(&secret), "{secret}");
            assert!(seen.insert(secret), "a secret was used twice");
            plur1bus_config::parse(&text).expect("the refilled config validates");
        }
    }

    #[test]
    fn a_restore_leaves_every_other_config_alone() {
        let d = tempfile::tempdir().unwrap();
        // no file at all
        assert!(!refill_staged_config(d.path()).unwrap());
        let p = d.path().join("config.json");
        for original in [
            "{\"restored\":true}".to_string(),
            "{ \"schemaVersion\": 1 }".to_string(),
            // a real value is never touched, only the placeholder
            webhook_config(MARKER),
            // not JSON, with the placeholder in it: put in place as it is
            format!("not json {PLACEHOLDER}"),
            // the placeholder somewhere that is not a secret slot
            json!({ "note": PLACEHOLDER }).to_string(),
        ] {
            fs::write(&p, &original).unwrap();
            assert!(!refill_staged_config(d.path()).unwrap(), "{original}");
            assert_eq!(fs::read_to_string(&p).unwrap(), original);
        }
    }

    /// Every property of `config.schema.json` (dotted path, node), through `properties` and the keywords that nest them.
    fn schema_properties() -> Vec<(String, Value)> {
        fn walk(node: &Value, path: &str, out: &mut Vec<(String, Value)>) {
            if let Some(props) = node.get("properties").and_then(Value::as_object) {
                for (k, v) in props {
                    let p = if path.is_empty() {
                        k.clone()
                    } else {
                        format!("{path}.{k}")
                    };
                    out.push((p.clone(), v.clone()));
                    walk(v, &p, out);
                }
            }
            for key in ["additionalProperties", "items", "then"] {
                if node[key].is_object() {
                    walk(&node[key], &format!("{path}.*"), out);
                }
            }
            for key in ["allOf", "anyOf", "oneOf"] {
                for sub in node[key].as_array().into_iter().flatten() {
                    walk(sub, path, out);
                }
            }
        }
        let schema: Value = serde_json::from_str(plur1bus_config::SCHEMA_JSON).unwrap();
        let mut out = Vec::new();
        walk(&schema, "", &mut out);
        out
    }

    #[test]
    fn every_credential_named_string_property_is_a_reference_or_is_redacted() {
        let props = schema_properties();
        assert!(props.len() > 100, "{} schema properties", props.len());
        let mut references = 0;
        for (path, node) in &props {
            let key = path.rsplit('.').next().unwrap();
            let lower = key.to_ascii_lowercase();
            let credential_named = ["secret", "token", "password", "apikey", "privatekey"]
                .iter()
                .any(|w| lower.contains(w));
            if !credential_named || node["type"] != json!("string") {
                continue;
            }
            // `tokenSecret`, `botTokenSecret`, `passwordSecret`, `apiKeyRef`, ...: the NAME of a secret in the store.
            if key.ends_with("Secret") || key.ends_with("Ref") {
                references += 1;
                continue;
            }
            let listed = SECRET_VALUE_PATHS.iter().any(|p| p.join(".") == *path);
            assert!(
                listed,
                "{path} looks like a credential kept in config.json: add it to SECRET_VALUE_PATHS (or name it like a reference)"
            );
        }
        assert!(references >= 8, "{references} reference properties found");
        // And every listed path exists in the schema.
        for p in SECRET_VALUE_PATHS {
            let dotted = p.join(".");
            assert!(
                props.iter().any(|(path, _)| *path == dotted),
                "{dotted} is not a config property"
            );
        }
    }
}
