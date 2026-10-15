//! Config annotations apply to the resulting tree, including parent replacements. No duplicated per-key role list.
use crate::paths::Layout;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io::{self, Write};

pub fn schema() -> &'static Value {
    static SCHEMA: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(plur1bus_config::SCHEMA_JSON).expect("embedded config schema")
    })
}
fn secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "credential",
        "authorization",
        "passphrase",
        "api-key",
        "apikey",
        "api_key",
    ]
    .iter()
    .any(|s| key.contains(s))
}
fn redacted(schema: &Value, value: &Value) -> Value {
    if schema["x-sensitive"] == true {
        return json!("[REDACTED]");
    }
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| {
                    let child = &schema["properties"][key];
                    (
                        key.clone(),
                        if secret_key(key) {
                            json!("[REDACTED]")
                        } else {
                            redacted(child, value)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| redacted(&schema["items"], v))
                .collect(),
        ),
        Value::String(text) => match reqwest::Url::parse(text) {
            Ok(url)
                if !url.username().is_empty()
                    || url.password().is_some()
                    || url.scheme() == "data"
                    || url.query_pairs().any(|(key, _)| {
                        secret_key(&key)
                            || matches!(key.as_ref(), "key" | "auth" | "code" | "sig" | "signature")
                    }) =>
            {
                json!("[REDACTED]")
            }
            _ => value.clone(),
        },
        _ => value.clone(),
    }
}
#[derive(Debug, PartialEq)]
pub struct AuditChange {
    pub key: String,
    pub old: Value,
    pub new: Value,
}

pub fn changes(
    schema: &Value,
    before: &Value,
    after: &Value,
    role: &str,
) -> Result<Vec<AuditChange>, &'static str> {
    fn walk(
        s: &Value,
        old: &Value,
        new: &Value,
        path: &str,
        role: &str,
        inherited_sensitive: bool,
        out: &mut Vec<AuditChange>,
    ) -> Result<(), &'static str> {
        if old == new {
            return Ok(());
        }
        if let Some(roles) = s["x-write-roles"].as_array() {
            if !roles.iter().any(|r| r.as_str() == Some(role)) {
                return Err("config-write-role");
            }
        }
        let sensitive = inherited_sensitive || s["x-sensitive"] == true;
        if s["x-audit"] == true {
            out.push(AuditChange {
                key: path.to_string(),
                old: if sensitive {
                    json!("[REDACTED]")
                } else {
                    redacted(s, old)
                },
                new: if sensitive {
                    json!("[REDACTED]")
                } else {
                    redacted(s, new)
                },
            });
        }
        if let Some(props) = s["properties"].as_object() {
            for (key, child) in props {
                let next = if path.is_empty() {
                    key.to_string()
                } else {
                    format!("{path}.{key}")
                };
                walk(child, &old[key], &new[key], &next, role, sensitive, out)?;
            }
        }
        // Dynamic namespaces (provider/module names) inherit their parent restrictions and sensitivity.
        let dynamic = s["additionalProperties"]
            .as_object()
            .map(|_| &s["additionalProperties"])
            .or_else(|| {
                s["patternProperties"]
                    .as_object()
                    .and_then(|p| p.values().next())
            });
        if let Some(child) = dynamic {
            let keys: BTreeSet<_> = old
                .as_object()
                .into_iter()
                .flat_map(|m| m.keys())
                .chain(new.as_object().into_iter().flat_map(|m| m.keys()))
                .collect();
            for key in keys {
                if s["properties"].get(key).is_some() {
                    continue;
                }
                let next = if path.is_empty() {
                    key.to_string()
                } else {
                    format!("{path}.{key}")
                };
                walk(
                    child,
                    &old[key],
                    &new[key],
                    &next,
                    role,
                    sensitive || secret_key(key),
                    out,
                )?;
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(schema, before, after, "", role, false, &mut out)?;
    Ok(out)
}

fn put(root: &mut Value, key: &str, value: Value, remove_null: bool) -> Result<(), &'static str> {
    let parts: Vec<_> = key.split('.').collect();
    if parts.iter().any(|p| p.is_empty()) {
        return Err("invalid-key");
    }
    let mut target = root;
    for part in &parts[..parts.len() - 1] {
        let map = target.as_object_mut().ok_or("invalid-path")?;
        target = map.entry((*part).to_string()).or_insert_with(|| json!({}));
    }
    let map = target.as_object_mut().ok_or("invalid-path")?;
    let leaf = parts.last().ok_or("invalid-key")?;
    if remove_null && value.is_null() {
        map.remove(*leaf);
    } else {
        map.insert((*leaf).to_string(), value);
    }
    Ok(())
}

/// Remove old acknowledgments when an enclosing provider/endpoint changes. A newly supplied acknowledgment may be
/// kept, but its writer is replaced with the authenticated person. Provider definition changes invalidate old acks too.
pub fn prepare(
    before: &Value,
    given: &[(String, Value)],
    remove_null: bool,
    person: &str,
) -> Result<Vec<(String, Value)>, &'static str> {
    fn invalidate(old: &Value, new: &mut Value, provider_defs_changed: bool, person: &str) {
        if let Some(map) = new.as_object_mut() {
            let selection_changed = ["provider", "endpoint", "base_url"]
                .iter()
                .any(|k| old.get(k) != map.get(*k));
            let ack_changed = map.get("privacyAck").is_some_and(|ack| {
                ["provider", "endpoint", "acknowledgedAt"]
                    .iter()
                    .any(|key| old["privacyAck"].get(*key) != ack.get(*key))
            });
            if (selection_changed || provider_defs_changed) && !ack_changed {
                map.remove("privacyAck");
            }
            if map
                .get("privacyAck")
                .is_some_and(|ack| old.get("privacyAck") != Some(ack))
            {
                if let Some(ack) = map.get_mut("privacyAck").and_then(Value::as_object_mut) {
                    ack.insert("by".into(), json!(person));
                }
            }
            for (key, value) in map {
                invalidate(&old[key], value, provider_defs_changed, person);
            }
        }
    }
    let mut after = before.clone();
    for (key, value) in given {
        put(&mut after, key, value.clone(), remove_null)?;
    }
    let definitions_changed = before.get("providers") != after.get("providers");
    invalidate(before, &mut after, definitions_changed, person);
    // Parent replacement preserves removals while the existing config crate performs the complete schema validation.
    let new = after.as_object().ok_or("invalid-config")?;
    let keys: BTreeSet<_> = before
        .as_object()
        .into_iter()
        .flat_map(|m| m.keys())
        .chain(new.keys())
        .collect();
    Ok(keys
        .into_iter()
        .filter(|key| before.get(*key) != new.get(*key))
        .map(|key| (key.clone(), new.get(key).cloned().unwrap_or(Value::Null)))
        .collect())
}

/// A durable pre-write audit record. Its target revision distinguishes an intended write from a later I/O failure.
/// Failure refuses the config write; dry runs never append. No credentials or sensitive old/new values are written.
pub fn audit(
    layout: &Layout,
    person: &str,
    entries: &[AuditChange],
    revision: &str,
) -> io::Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(layout.logs())?;
    let path = layout.audit_log();
    drop(crate::audit::create_private(&path, false)?);
    let mut f = std::fs::OpenOptions::new().append(true).open(path)?;
    for entry in entries {
        let line = json!({ "at": super::now_ms(), "actor": { "user": person, "host": "supervisor" }, "action": "audit.config.set", "target": entry.key, "detail": { "personId": person, "oldValue": entry.old, "newValue": entry.new, "targetRevision": revision, "phase": "prepare" } });
        let mut bytes = serde_json::to_vec(&line).map_err(io::Error::other)?;
        bytes.push(b'\n');
        f.write_all(&bytes)?;
    }
    f.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parent_replacement_cannot_bypass_roles_and_sensitive_values_are_redacted() {
        let schema = json!({"properties":{"security":{"properties":{"max":{"x-write-roles":["owner","admin"],"x-audit":true},"secret":{"x-sensitive":true,"properties":{"value":{"x-audit":true}}}}}}});
        let old = json!({"security":{"max":90,"secret":{"value":"old-marker"}}});
        let new = json!({"security":{"max":5,"secret":{"value":"new-marker"}}});
        for role in ["operator", "member", "viewer"] {
            assert_eq!(changes(&schema, &old, &new, role), Err("config-write-role"));
        }
        for role in ["owner", "admin"] {
            let rows = changes(&schema, &old, &new, role).unwrap();
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[1].old, "[REDACTED]");
            assert_eq!(rows[1].new, "[REDACTED]");
        }
    }
    #[test]
    fn actual_schema_annotations_enforce_all_five_roles() {
        let paths = [
            "approvals.maxGrantDays",
            "approvals.requireOsConfirmation",
            "breakglass.reasonMinChars",
            "breakglass.reasonMaxChars",
            "breakglass.maxWindowMinutes",
            "memory.embedding.privacyAck",
            "memory.mediaEmbedding.privacyAck",
            "memory.mediaEmbedding.caption.privacyAck",
            "agents.main.memory.mediaEmbedding.privacyAck",
            "agents.main.memory.mediaEmbedding.caption.privacyAck",
        ];
        for path in paths {
            let before = json!({});
            let mut after = before.clone();
            put(&mut after, path, json!("changed"), false).unwrap();
            for role in ["owner", "admin", "operator", "member", "viewer"] {
                let result = changes(schema(), &before, &after, role);
                if matches!(role, "owner" | "admin") {
                    let entries = result.unwrap();
                    assert!(
                        entries.iter().any(|e| e.key == path),
                        "{path} has audit metadata"
                    );
                } else {
                    assert_eq!(result, Err("config-write-role"), "{path}: {role}");
                }
            }
        }
    }
    #[test]
    fn changing_only_ack_writer_cannot_renew_consent_after_endpoint_switch() {
        let before = json!({"memory":{"caption":{"endpoint":"https://old.invalid", "privacyAck":{"provider":"cloud", "endpoint":"https://old.invalid", "acknowledgedAt":"2026-10-14T00:00:00Z", "by":"alice"}}}});
        let prepared = prepare(
            &before,
            &[
                (
                    "memory.caption.endpoint".into(),
                    json!("https://new.invalid"),
                ),
                ("memory.caption.privacyAck.by".into(), json!("spoofed")),
            ],
            false,
            "real-person",
        )
        .unwrap();
        assert!(prepared[0].1["caption"].get("privacyAck").is_none());
    }
    #[test]
    fn audit_redacts_embedded_url_credentials_and_sensitive_query_parameters() {
        let schema = json!({"x-audit":true});
        for endpoint in [
            "https://account:password-marker@service.invalid/v1",
            "https://service.invalid/v1?access_token=secret-marker",
            "https://service.invalid/v1?%61pi_key=secret-marker",
        ] {
            let rows =
                changes(&schema, &json!({"endpoint":endpoint}), &json!({}), "owner").unwrap();
            assert_eq!(rows[0].old["endpoint"], "[REDACTED]");
        }
    }
    #[test]
    fn audit_records_person_and_redacted_values_and_fails_closed_on_io() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout {
            home: dir.path().to_path_buf(),
        };
        let changes = vec![AuditChange {
            key: "security.value".into(),
            old: json!("[REDACTED]"),
            new: json!("[REDACTED]"),
        }];
        audit(&layout, "trusted-person", &changes, "revision-after").unwrap();
        let line: Value =
            serde_json::from_str(std::fs::read_to_string(layout.audit_log()).unwrap().trim())
                .unwrap();
        assert_eq!(line["action"], "audit.config.set");
        assert_eq!(line["actor"]["user"], "trusted-person");
        assert_eq!(line["detail"]["personId"], "trusted-person");
        assert_eq!(line["detail"]["newValue"], "[REDACTED]");
        std::fs::remove_file(layout.audit_log()).unwrap();
        std::fs::create_dir(layout.audit_log()).unwrap();
        assert!(audit(&layout, "trusted-person", &changes, "revision-after").is_err());
    }
    #[test]
    fn removal_of_a_root_is_retained_and_writer_only_changes_are_authenticated() {
        let before = json!({"providers":{"demo":{}}, "memory":{"caption":{"privacyAck":{"provider":"local", "by":"alice"}}}});
        let prepared = prepare(
            &before,
            &[("providers".into(), Value::Null)],
            true,
            "real-person",
        )
        .unwrap();
        assert!(prepared
            .iter()
            .any(|(key, value)| key == "providers" && value.is_null()));
        let prepared = prepare(
            &before,
            &[("memory.caption.privacyAck.by".into(), json!("spoofed"))],
            false,
            "real-person",
        )
        .unwrap();
        assert_eq!(prepared[0].1["caption"]["privacyAck"]["by"], "real-person");
    }
    #[test]
    fn provider_switch_removes_old_ack_and_new_ack_records_real_writer() {
        let before = json!({"memory":{"caption":{"provider":"local","privacyAck":{"provider":"local","by":"alice"}}}});
        let prepared = prepare(
            &before,
            &[("memory.caption.provider".into(), json!("off"))],
            false,
            "real-person",
        )
        .unwrap();
        assert!(prepared[0].1["caption"].get("privacyAck").is_none());
        let prepared = prepare(
            &before,
            &[(
                "memory.caption".into(),
                json!({"provider":"cloud","privacyAck":{"provider":"cloud","by":"spoofed"}}),
            )],
            false,
            "real-person",
        )
        .unwrap();
        assert_eq!(prepared[0].1["caption"]["privacyAck"]["by"], "real-person");
    }
}
