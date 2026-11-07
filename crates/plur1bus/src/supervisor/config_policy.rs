//! Config annotations apply to the resulting tree, including parent replacements. No duplicated per-key role list.
use crate::paths::Layout;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io;

pub fn schema() -> &'static Value {
    static SCHEMA: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(plur1bus_config::SCHEMA_JSON).expect("embedded config schema")
    })
}
#[derive(Debug, PartialEq)]
pub struct AuditChange {
    pub key: String,
    pub old: Value,
    pub new: Value,
    old_references: Vec<String>,
    new_references: Vec<String>,
}

pub fn changes(
    schema: &Value,
    before: &Value,
    after: &Value,
    role: &str,
) -> Result<Vec<AuditChange>, &'static str> {
    #[derive(Clone, Copy)]
    struct Snapshot<'a> {
        raw: &'a Value,
        public: &'a Value,
        references: &'a [String],
        pointer: &'a str,
    }
    impl Snapshot<'_> {
        fn reference_paths(self) -> Vec<String> {
            self.references
                .iter()
                .filter_map(|reference| {
                    if reference == self.pointer
                        || self.pointer.starts_with(&format!("{reference}/"))
                    {
                        Some(String::new())
                    } else {
                        reference
                            .strip_prefix(&format!("{}/", self.pointer))
                            .map(|path| format!("/{path}"))
                    }
                })
                .collect()
        }
    }
    fn walk(
        s: &Value,
        old: Snapshot<'_>,
        new: Snapshot<'_>,
        path: &str,
        role: &str,
        out: &mut Vec<AuditChange>,
    ) -> Result<(), &'static str> {
        if old.raw == new.raw {
            return Ok(());
        }
        if let Some(roles) = s["x-write-roles"].as_array() {
            if !roles.iter().any(|r| r.as_str() == Some(role)) {
                return Err("config-write-role");
            }
        }
        if s["x-audit"] == true {
            out.push(AuditChange {
                key: path.to_string(),
                old: old.public.clone(),
                new: new.public.clone(),
                old_references: old.reference_paths(),
                new_references: new.reference_paths(),
            });
        }
        if let Some(props) = s["properties"].as_object() {
            for (key, child) in props {
                let next = if path.is_empty() {
                    key.to_string()
                } else {
                    format!("{path}.{key}")
                };
                let pointer = format!(
                    "{}/{}",
                    old.pointer,
                    key.replace('~', "~0").replace('/', "~1")
                );
                walk(
                    child,
                    Snapshot {
                        raw: &old.raw[key],
                        public: &old.public[key],
                        references: old.references,
                        pointer: &pointer,
                    },
                    Snapshot {
                        raw: &new.raw[key],
                        public: &new.public[key],
                        references: new.references,
                        pointer: &pointer,
                    },
                    &next,
                    role,
                    out,
                )?;
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
                .raw
                .as_object()
                .into_iter()
                .flat_map(|m| m.keys())
                .chain(new.raw.as_object().into_iter().flat_map(|m| m.keys()))
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
                let pointer = format!(
                    "{}/{}",
                    old.pointer,
                    key.replace('~', "~0").replace('/', "~1")
                );
                walk(
                    child,
                    Snapshot {
                        raw: &old.raw[key],
                        public: &old.public[key],
                        references: old.references,
                        pointer: &pointer,
                    },
                    Snapshot {
                        raw: &new.raw[key],
                        public: &new.public[key],
                        references: new.references,
                        pointer: &pointer,
                    },
                    &next,
                    role,
                    out,
                )?;
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    let public_before = plur1bus_config::redact_with_schema(before, schema);
    let public_after = plur1bus_config::redact_with_schema(after, schema);
    let references_before = plur1bus_config::reference_paths_with_schema(before, schema);
    let references_after = plur1bus_config::reference_paths_with_schema(after, schema);
    walk(
        schema,
        Snapshot {
            raw: before,
            public: &public_before,
            references: &references_before,
            pointer: "",
        },
        Snapshot {
            raw: after,
            public: &public_after,
            references: &references_after,
            pointer: "",
        },
        "",
        role,
        &mut out,
    )?;
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
/// No credentials or sensitive old/new values are written: `entries` arrive already redacted by field (`changes`),
/// and every row goes through the one writer of `audit.log` (`crate::audit`), so it joins the hash chain with the same
/// line and the central detail redaction applies. Dry runs never append.
///
/// Failure handling (owner decision 20.10.: a person must always be able to save the configuration safely; the chain must
/// not block it). `config.set` is a user action; the other callers of `audit::append` record machine events and stay
/// fail-closed.
/// * `audit.log` cannot be written (I/O, disk full): `Err`, the config write is refused, as it always was.
/// * Only the chain refuses (anchor missing or invalid, tail does not match the anchor, lock timeout): the rows still go
///   to `audit.log` (`chain: "refused"`, `chainReason`) and into the pending journal, which joins the chain once it
///   accepts appends again (`audit::drain_pending`). The result is `Ok(Some(refusal))` and the caller reports the
///   `audit-chain-unavailable` warning.
pub fn audit(
    layout: &Layout,
    person: &str,
    entries: &[AuditChange],
    revision: &str,
) -> io::Result<Option<crate::audit::ChainRefusal>> {
    let mut refusal: Option<crate::audit::ChainRefusal> = None;
    for entry in entries {
        let detail = json!({ "personId": person, "oldValue": entry.old, "newValue": entry.new, "targetRevision": revision, "phase": "prepare" });
        let references: Vec<String> = entry
            .old_references
            .iter()
            .map(|path| format!("/oldValue{path}"))
            .chain(
                entry
                    .new_references
                    .iter()
                    .map(|path| format!("/newValue{path}")),
            )
            .collect();
        let row = crate::audit::append_config_as_degrading(
            layout,
            (person, "supervisor"),
            &entry.key,
            detail,
            &references,
        )?;
        if let Some(row) = row {
            refusal = Some(match refusal {
                None => row,
                Some(first) => crate::audit::ChainRefusal {
                    reason: first.reason,
                    queued: first.queued && row.queued,
                    dropped: first.dropped + row.dropped,
                },
            });
        }
    }
    Ok(refusal)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn audit_parent_preserves_safe_references_and_masks_literals_with_full_schema_context() {
        let old_literal = uuid::Uuid::new_v4().to_string();
        let new_literal = uuid::Uuid::new_v4().to_string();
        let schema = json!({"$defs":{
            "name":{"type":"string"},
            "engine":{"type":"object","required":["source","provider","id"],"additionalProperties":false,
                "x-secret-reference":true,"x-secret-reference-kind":"engine-input",
                "properties":{"source":{"enum":["store","file"]},"provider":{"type":"string"},"id":{"type":"string"}}}
        },"properties":{"security":{"x-audit":true,"x-write-roles":["owner"],"properties":{
            "handle":{"type":"string","x-sensitive":true,"x-secret-reference":{"$ref":"#/$defs/name"}},
            "tokenSecret":{"type":"string","x-sensitive":true,"x-secret-reference":{"$ref":"#/$defs/name"}},
            "file":{"x-sensitive":true,"x-secret-reference":{"$ref":"#/$defs/engine"}},
            "ordinary":{"type":"string","x-sensitive":true},
            "structured":{"type":"object","x-sensitive":true,"x-secret-reference":{"$ref":"#/$defs/engine"},
                "properties":{"id":{"type":"string","x-audit":true}}}
        }}}});
        let before = json!({"security":{"handle":"service.old","tokenSecret":"service.old","ordinary":old_literal,
            "file":{"source":"file","provider":"fixture","id":"/home/fixture/.ssh/reference.old"},
            "structured":{"source":"store","provider":"fixture","id":"service.old"}}});
        let after = json!({"security":{"handle":"service.new","tokenSecret":"service.new","ordinary":new_literal,
            "file":{"source":"file","provider":"fixture","id":"/home/fixture/.ssh/reference.new"},
            "structured":{"source":"store","provider":"fixture","id":"service.new"}}});
        assert_eq!(
            changes(&schema, &before, &after, "admin"),
            Err("config-write-role")
        );
        let rows = changes(&schema, &before, &after, "owner").unwrap();
        let parent = rows.iter().find(|row| row.key == "security").unwrap();
        assert_eq!(parent.old["handle"], "service.old");
        assert_eq!(parent.new["handle"], "service.new");
        assert_eq!(parent.old["ordinary"], "••••");
        assert_eq!(parent.new["ordinary"], "••••");
        let child = rows
            .iter()
            .find(|row| row.key == "security.structured.id")
            .unwrap();
        assert_eq!(child.old, "service.old");
        assert_eq!(child.new, "service.new");
        let text = format!("{rows:?}");
        assert!(!text.contains(&old_literal) && !text.contains(&new_literal));
        let directory = tempfile::tempdir().unwrap();
        let layout = Layout::new(directory.path().to_path_buf());
        audit(&layout, "trusted-person", &rows, "reference-revision").unwrap();
        let chain = verified_chain(&layout);
        let parent = row(&chain, "security");
        assert_eq!(parent["detail"]["oldValue"]["tokenSecret"], "service.old");
        assert_eq!(parent["detail"]["newValue"]["tokenSecret"], "service.new");
        assert_eq!(
            parent["detail"]["oldValue"]["file"]["id"],
            "/home/fixture/.ssh/reference.old"
        );
        assert_eq!(
            parent["detail"]["newValue"]["file"]["id"],
            "/home/fixture/.ssh/reference.new"
        );
        for name in ["audit.log", "audit-chain.jsonl"] {
            let contents = std::fs::read_to_string(layout.logs().join(name)).unwrap();
            assert!(!contents.contains(&old_literal) && !contents.contains(&new_literal));
        }
    }

    #[test]
    fn ssh_setup_and_trust_are_owner_only_through_generic_config_changes() {
        let configured = json!({"import":{"ssh":{"connections":{"source":{
            "host":"source.invalid","port":22,"user":"reader","roots":["/home/reader"],
            "allowPrivate":false,"hostKey":{"sha256":format!("SHA256:{}", "A".repeat(43))}
        }}}}});
        for (before, after) in [
            (json!({}), configured.clone()),
            (configured.clone(), json!({})),
            (
                configured.clone(),
                json!({"import":{"ssh":{"connections":{}}}}),
            ),
        ] {
            for role in ["admin", "operator", "member", "viewer"] {
                assert_eq!(
                    changes(schema(), &before, &after, role),
                    Err("config-write-role")
                );
            }
            assert!(!changes(schema(), &before, &after, "owner")
                .unwrap()
                .is_empty());
        }
    }
    #[test]
    fn learning_configuration_is_owner_only_including_parent_replacements() {
        let before = json!({});
        let after =
            json!({"dreams":{"learn":{"agents":{"agent":{"owner":"person","enabled":true}}}}});
        for role in ["admin", "operator", "member", "viewer"] {
            assert_eq!(
                changes(schema(), &before, &after, role),
                Err("config-write-role")
            );
            assert_eq!(
                changes(schema(), &after, &before, role),
                Err("config-write-role")
            );
        }
        assert!(!changes(schema(), &before, &after, "owner")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn sandbox_task_cap_is_owner_only() {
        let before = json!({"tools":{"sandbox":{"maxTasks":512}}});
        let after = json!({"tools":{"sandbox":{"maxTasks":0}}});
        for role in ["admin", "operator", "member", "viewer"] {
            assert_eq!(
                changes(schema(), &before, &after, role),
                Err("config-write-role")
            );
        }
        assert!(changes(schema(), &before, &after, "owner")
            .unwrap()
            .iter()
            .any(|r| r.key == "tools.sandbox.maxTasks"));
    }

    #[test]
    fn sandbox_bypass_is_owner_only_even_for_parent_replacements() {
        let before = json!({"tools":{"sandbox":{"required":true}}});
        let after = json!({"tools":{"sandbox":{"required":false}}});
        for role in ["admin", "operator", "member", "viewer"] {
            assert_eq!(
                changes(schema(), &before, &after, role),
                Err("config-write-role")
            );
        }
        let rows = changes(schema(), &before, &after, "owner").unwrap();
        assert!(rows
            .iter()
            .any(|r| r.key == "tools.sandbox.required" && r.new == false));
    }

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
            assert_eq!(rows[1].old, "••••");
            assert_eq!(rows[1].new, "••••");
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
            "session.rewind.fileProjects",
            "session.rewind.checkpointRetentionTurns",
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
        let schema = json!({"x-audit":true,"properties":{"endpoint":{"x-url-credentials":true}}});
        let secret = uuid::Uuid::new_v4().to_string();
        for (endpoint, expected) in [
            (
                format!("https://{secret}:{secret}@service.invalid/v1"),
                "https://••••@service.invalid/v1",
            ),
            (
                format!("https://service.invalid/v1?access_token={secret}"),
                "https://service.invalid/v1?access_token=••••",
            ),
            (
                format!("https://service.invalid/v1?ordinary={secret}"),
                "https://service.invalid/v1?ordinary=••••",
            ),
        ] {
            let rows =
                changes(&schema, &json!({"endpoint":endpoint}), &json!({}), "owner").unwrap();
            assert_eq!(rows[0].old["endpoint"], expected);
        }
    }
    #[test]
    fn audit_uses_declared_metadata_for_ordinary_names_and_keeps_public_controls() {
        let secret = uuid::Uuid::new_v4().to_string();
        let schema = json!({"x-audit":true,"properties":{
            "opaque":{"x-value-schema":{"properties":{"ordinary":{"x-sensitive":true}}}},
            "maxTokens":{"type":"integer"},"password":{"type":"string"}
        }});
        let old = json!({"opaque":{"ordinary":secret},"maxTokens":4096,"password":"public-label"});
        let rows = changes(&schema, &old, &json!({}), "owner").unwrap();
        assert_eq!(
            rows[0].old,
            json!({"opaque":{"ordinary":"••••"},"maxTokens":4096,"password":"public-label"})
        );
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
            old_references: Vec::new(),
            new_references: Vec::new(),
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
    /// The chain's lines checked the way `audit verify` does: `seq` counts up from 1, every `prev` is the SHA-256 of the
    /// line before it (the genesis hash for the first) and the anchor pins the newest (seq, hash). Returns each chain
    /// line as written, with its parsed `rec`.
    fn verified_chain(layout: &Layout) -> Vec<(String, Value)> {
        use sha2::{Digest, Sha256};
        let hash = |line: &str| format!("{:x}", Sha256::digest(line.as_bytes()));
        let text = std::fs::read_to_string(layout.logs().join("audit-chain.jsonl"))
            .expect("a config audit must join the shared chain");
        let mut prev = "0".repeat(64);
        let mut rows = Vec::new();
        for (i, raw) in text.lines().enumerate() {
            let line: Value = serde_json::from_str(raw).unwrap();
            assert_eq!(line["seq"], i as u64 + 1);
            assert_eq!(line["prev"], prev.as_str());
            prev = hash(raw);
            rows.push((raw.to_string(), line["rec"].clone()));
        }
        let anchor: Value = serde_json::from_str(
            std::fs::read_to_string(layout.logs().join("audit-chain.anchor"))
                .unwrap()
                .trim(),
        )
        .unwrap();
        assert_eq!(anchor["seq"], rows.len() as u64);
        assert_eq!(anchor["hash"], prev.as_str());
        rows
    }

    fn log_lines(layout: &Layout) -> Vec<String> {
        std::fs::read_to_string(layout.audit_log())
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// A config change as `config.set` sees it: the schema marks what is audited and what is sensitive, `changes`
    /// redacts by field, `audit` writes.
    fn changed_config_rows() -> Vec<AuditChange> {
        let schema = json!({"properties":{
            "security":{"properties":{
                "max":{"x-audit":true},
                "secret":{"x-sensitive":true,"properties":{"value":{"x-audit":true}}}}},
            "endpoint":{"x-audit":true},
            "login":{"x-audit":true,"properties":{"api_key":{"x-sensitive":true}}}}});
        let before = json!({
            "security":{"max":90,"secret":{"value":"old-marker"}},
            "endpoint":"https://service.invalid/v1",
            "login":{"user":"alice","api_key":"old-marker"}});
        let after = json!({
            "security":{"max":5,"secret":{"value":"new-marker"}},
            "endpoint":"https://service.invalid/v2",
            "login":{"user":"bob","api_key":"new-marker"}});
        let rows = changes(&schema, &before, &after, "owner").unwrap();
        assert_eq!(rows.len(), 4);
        rows
    }

    fn row<'a>(rows: &'a [(String, Value)], target: &str) -> &'a Value {
        &rows
            .iter()
            .find(|(_, rec)| rec["target"] == target)
            .unwrap_or_else(|| panic!("no audit row for {target}"))
            .1
    }

    #[test]
    fn config_audit_rows_join_the_hash_chain_and_audit_log_holds_the_same_lines() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        audit(&layout, "trusted-person", &changed_config_rows(), "rev-1").unwrap();
        // A second config set continues the same chain: seq and prev carry on from the first.
        audit(&layout, "trusted-person", &changed_config_rows(), "rev-2").unwrap();
        let chain = verified_chain(&layout);
        let log = log_lines(&layout);
        assert_eq!(chain.len(), 8);
        assert_eq!(log.len(), 8, "one audit.log line per chain line");
        for ((raw_chain, rec), raw_log) in chain.iter().zip(&log) {
            assert_eq!(rec, &serde_json::from_str::<Value>(raw_log).unwrap());
            assert!(
                raw_chain.ends_with(&format!("\"rec\":{raw_log}}}")),
                "the chain line carries the audit.log line byte for byte"
            );
            assert_eq!(rec["action"], "audit.config.set");
            assert_eq!(rec["actor"]["user"], "trusted-person");
            assert_eq!(rec["actor"]["host"], "supervisor");
            assert_eq!(rec["detail"]["personId"], "trusted-person");
            assert_eq!(rec["detail"]["phase"], "prepare");
            assert_eq!(rec.as_object().unwrap().len(), 5);
        }
        assert_eq!(chain[0].1["detail"]["targetRevision"], "rev-1");
        assert_eq!(chain[7].1["detail"]["targetRevision"], "rev-2");
    }

    #[test]
    fn secret_config_fields_stay_redacted_in_the_chain_and_the_audit_log() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        audit(&layout, "trusted-person", &changed_config_rows(), "rev-1").unwrap();
        let chain_text = std::fs::read_to_string(layout.logs().join("audit-chain.jsonl")).unwrap();
        let log_text = std::fs::read_to_string(layout.audit_log()).unwrap();
        for text in [&chain_text, &log_text] {
            assert!(!text.contains("old-marker"), "{text}");
            assert!(!text.contains("new-marker"), "{text}");
        }
        let chain = verified_chain(&layout);
        let secret = row(&chain, "security.secret.value");
        assert_eq!(secret["detail"]["oldValue"], "••••");
        assert_eq!(secret["detail"]["newValue"], "••••");
        // A credential-named field: masked here by field name, and the central key rule may re-mask the mask with its own
        // tag (`[REDACTED:key]`), so only the marker's prefix is fixed.
        let login = row(&chain, "login");
        for side in ["oldValue", "newValue"] {
            let masked = login["detail"][side]["api_key"].as_str().unwrap();
            assert!(masked.starts_with("[REDACTED"), "{masked}");
        }
    }

    #[test]
    fn numeric_config_values_stay_public_while_unclassified_strings_are_private() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        audit(&layout, "trusted-person", &changed_config_rows(), "rev-1").unwrap();
        let chain = verified_chain(&layout);
        let max = row(&chain, "security.max");
        assert_eq!(max["detail"]["oldValue"], 90);
        assert_eq!(max["detail"]["newValue"], 5);
        let endpoint = row(&chain, "endpoint");
        assert_eq!(endpoint["detail"]["oldValue"], "••••");
        assert_eq!(endpoint["detail"]["newValue"], "••••");
        let login = row(&chain, "login");
        assert_eq!(login["detail"]["oldValue"]["user"], "••••");
        assert_eq!(login["detail"]["newValue"]["user"], "••••");
        let logged: Vec<Value> = log_lines(&layout)
            .iter()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert!(logged
            .iter()
            .any(|l| l["target"] == "security.max" && l["detail"]["newValue"] == 5));
    }

    /// Owner decision 20.10. (replaces the earlier "a chain that refuses the append fails the config audit, so `config.set`
    /// stops"): a person must always be able to save the configuration, so a chain that refuses the rows (here: its
    /// anchor is gone) no longer blocks it. The rows still reach `audit.log`, flagged `chain: "refused"` with a short
    /// reason, and wait byte for byte in the pending journal; the chain itself is not touched.
    #[test]
    fn a_chain_that_refuses_the_append_does_not_block_the_config_audit() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        assert_eq!(
            audit(&layout, "trusted-person", &changed_config_rows(), "rev-1").unwrap(),
            None
        );
        std::fs::remove_file(layout.logs().join("audit-chain.anchor")).unwrap();
        let log_before = log_lines(&layout);
        let chain_before = std::fs::read(layout.logs().join("audit-chain.jsonl")).unwrap();
        let refusal = audit(&layout, "trusted-person", &changed_config_rows(), "rev-2")
            .unwrap()
            .expect("the chain refused");
        assert_eq!(refusal.reason, "anchor-missing");
        assert!(refusal.queued);
        assert_eq!(
            std::fs::read(layout.logs().join("audit-chain.jsonl")).unwrap(),
            chain_before,
            "a refusing chain is never written to"
        );
        let log = log_lines(&layout);
        assert_eq!(log.len(), log_before.len() + 4);
        assert_eq!(&log[..log_before.len()], &log_before[..]);
        let refused = &log[log_before.len()..];
        for raw in refused {
            let line: Value = serde_json::from_str(raw).unwrap();
            assert_eq!(line["action"], "audit.config.set");
            assert_eq!(line["actor"]["user"], "trusted-person");
            assert_eq!(line["detail"]["targetRevision"], "rev-2");
            assert_eq!(line["chain"], "refused");
            assert_eq!(line["chainReason"], "anchor-missing");
            assert!(
                !raw.contains("old-marker") && !raw.contains("new-marker"),
                "{raw}"
            );
        }
        let pending =
            std::fs::read_to_string(layout.logs().join("audit-chain.pending.jsonl")).unwrap();
        let pending: Vec<String> = pending.lines().map(str::to_string).collect();
        assert_eq!(pending, refused, "the journal holds the audit.log lines");
    }

    /// `audit.log` is still the fail-closed part: a row it cannot hold refuses the config write, whether or not the
    /// chain refuses too, and nothing is queued for it.
    #[test]
    fn an_unwritable_audit_log_still_fails_the_config_audit_when_the_chain_refuses_too() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        audit(&layout, "trusted-person", &changed_config_rows(), "rev-1").unwrap();
        std::fs::remove_file(layout.logs().join("audit-chain.anchor")).unwrap();
        std::fs::remove_file(layout.audit_log()).unwrap();
        std::fs::create_dir(layout.audit_log()).unwrap();
        assert!(audit(&layout, "trusted-person", &changed_config_rows(), "rev-2").is_err());
        assert!(!layout.logs().join("audit-chain.pending.jsonl").exists());
    }

    /// The repair side: with the anchor back, the next config audit joins the chain and takes the waiting rows along, in
    /// their original order, and the chain verifies.
    #[test]
    fn after_the_anchor_is_restored_the_waiting_config_rows_join_the_chain_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        audit(&layout, "trusted-person", &changed_config_rows(), "rev-1").unwrap();
        std::fs::remove_file(layout.logs().join("audit-chain.anchor")).unwrap();
        audit(&layout, "trusted-person", &changed_config_rows(), "rev-2").unwrap();
        let waiting: Vec<Value> = log_lines(&layout)[4..8]
            .iter()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        // What a repair does: the anchor is written again from the chain's newest line.
        {
            use sha2::{Digest, Sha256};
            let text = std::fs::read_to_string(layout.logs().join("audit-chain.jsonl")).unwrap();
            let last = text.lines().last().unwrap();
            let seq = serde_json::from_str::<Value>(last).unwrap()["seq"]
                .as_u64()
                .unwrap();
            std::fs::write(
                layout.logs().join("audit-chain.anchor"),
                json!({"v": 1, "seq": seq, "hash": format!("{:x}", Sha256::digest(last.as_bytes()))})
                    .to_string(),
            )
            .unwrap();
        }
        assert_eq!(
            audit(&layout, "trusted-person", &changed_config_rows(), "rev-3").unwrap(),
            None
        );
        let chain = verified_chain(&layout);
        let in_rev_2: Vec<&Value> = chain
            .iter()
            .map(|(_, rec)| rec)
            .filter(|rec| rec["detail"]["targetRevision"] == "rev-2")
            .collect();
        assert_eq!(in_rev_2.len(), 4);
        for (rec, original) in in_rev_2.iter().zip(&waiting) {
            assert_eq!(*rec, original, "original order, time and flag");
        }
        assert_eq!(
            chain
                .iter()
                .filter(|(_, rec)| rec["detail"]["targetRevision"] == "rev-3")
                .count(),
            4
        );
        let drained: Vec<&Value> = chain
            .iter()
            .map(|(_, rec)| rec)
            .filter(|rec| rec["action"] == "audit.chain.pending_drained")
            .collect();
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0]["detail"]["count"], 4);
        assert!(!layout.logs().join("audit-chain.pending.jsonl").exists());
    }

    #[test]
    fn no_changes_write_no_audit_rows() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        audit(&layout, "trusted-person", &[], "rev-1").unwrap();
        assert!(!layout.audit_log().exists());
        assert!(!layout.logs().join("audit-chain.jsonl").exists());
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
