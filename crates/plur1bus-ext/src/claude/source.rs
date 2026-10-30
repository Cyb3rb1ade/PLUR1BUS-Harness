//! Bounded plugin directory/ZIP reads and metadata-only unsupported-component reports (M-A11).
use super::{invalid, ClaudeInput, SkippedComponent};
use crate::pack::{collect_dir, DirLimits, PayloadFile};
use crate::refusal::{reason, Refusal};
use crate::zipaudit::{audit_zip, read_entry, Limits};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const UNSUPPORTED: &[&str] = &[
    "commands",
    "agents",
    "hooks",
    "lspServers",
    "outputStyles",
    "workflows",
    "bin",
    "settings",
    "channels",
];

pub(super) struct SourceTree {
    pub files: BTreeMap<String, PayloadFile>,
    pub name_hint: String,
    pub skipped: Vec<SkippedComponent>,
}

fn skip(path: &str) -> Option<SkippedComponent> {
    let first = path.split('/').next().unwrap_or("");
    if UNSUPPORTED.contains(&first) || first == "experimental" || first.starts_with("experimental.")
    {
        return Some(SkippedComponent {
            name: if first == "bin" {
                "bin/".into()
            } else {
                first.into()
            },
            reason: "unsupported component; not copied or executed".into(),
        });
    }
    if crate::skill::is_excluded(path) {
        return Some(SkippedComponent {
            name: path.into(),
            reason: "credential or version-control file excluded".into(),
        });
    }
    None
}

pub(super) fn relative(path: &str) -> Result<String, Refusal> {
    let path = path.strip_prefix("./").unwrap_or(path);
    if path.is_empty()
        || path.starts_with('/')
        || path.contains(['\\', ':'])
        || path.chars().any(char::is_control)
        || path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err(Refusal::invalid(
            reason::UNSAFE_ENTRY,
            "plugin component path must stay within the source root",
        ));
    }
    Ok(path.into())
}

pub(super) fn read(input: &ClaudeInput, limits: &Limits) -> Result<SourceTree, Refusal> {
    let (files, name_hint, mut skipped) = match input {
        ClaudeInput::Dir(path) => {
            let metadata = std::fs::symlink_metadata(path).map_err(|e| Refusal::io(&e))?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(Refusal::invalid(
                    reason::UNSAFE_ENTRY,
                    "plugin source must be a regular directory, not a symlink",
                ));
            }
            let (files, skips) = collect_dir(
                path,
                &DirLimits {
                    max_bytes: limits.package_bytes,
                    max_files: limits.max_entries,
                },
                |p| Ok(skip(p).is_none()),
            )?;
            let skipped = skips.iter().filter_map(|p| skip(p)).collect();
            (
                files,
                path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("plugin")
                    .to_owned(),
                skipped,
            )
        }
        ClaudeInput::Zip(path) => {
            let metadata = std::fs::symlink_metadata(path).map_err(|e| Refusal::io(&e))?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(Refusal::invalid(
                    reason::UNSAFE_ENTRY,
                    "plugin ZIP source must be a regular file, not a symlink",
                ));
            }
            let mut input = std::fs::File::open(path).map_err(|e| Refusal::io(&e))?;
            let audited = audit_zip(&mut input, limits)?;
            let root = audited.entries.iter().any(|e| {
                e.name.starts_with(".claude-plugin/")
                    || e.name.starts_with("skills/")
                    || e.name == ".mcp.json"
            });
            let prefix = if root {
                String::new()
            } else {
                let top = audited
                    .entries
                    .first()
                    .and_then(|e| e.name.split_once('/'))
                    .map(|(top, _)| top)
                    .ok_or_else(|| invalid("plugin ZIP has no recognizable root"))?;
                if !audited
                    .entries
                    .iter()
                    .all(|e| e.name.starts_with(&format!("{top}/")))
                {
                    return Err(invalid("plugin ZIP must have one root"));
                }
                format!("{top}/")
            };
            let mut files = Vec::new();
            let mut skipped = Vec::new();
            for entry in &audited.entries {
                let rel = &entry.name[prefix.len()..];
                if let Some(component) = skip(rel) {
                    skipped.push(component);
                    continue;
                }
                files.push(PayloadFile {
                    rel: rel.into(),
                    bytes: read_entry(&mut input, entry, limits.entry_bytes)?,
                    exec: entry.exec,
                });
            }
            let name = if prefix.is_empty() {
                path.file_stem()
                    .and_then(|n| n.to_str())
                    .unwrap_or("plugin")
                    .into()
            } else {
                prefix.trim_end_matches('/').into()
            };
            (files, name, skipped)
        }
    };
    // Validate all retained names even when no supported component eventually references a file.
    for file in &files {
        relative(&file.rel)?;
    }
    skipped.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(SourceTree {
        files: files.into_iter().map(|f| (f.rel.clone(), f)).collect(),
        name_hint,
        skipped,
    })
}

pub(super) fn is_mcp_configuration(file: &PayloadFile) -> bool {
    if !file.rel.ends_with(".json") {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<Value>(&file.bytes) else {
        return false;
    };
    value.get("mcpServers").is_some()
        || value.as_object().is_some_and(|map| {
            map.values().any(|definition| {
                definition.is_object()
                    && (definition.get("command").is_some() || definition.get("url").is_some())
            })
        })
}

/// Unsupported components can use custom paths; exclude those trees before assembling any MCP payload.
pub(super) fn exclude_components(tree: &mut SourceTree, metadata: &Value) {
    fn paths(value: &Value, excluded: &mut std::collections::BTreeSet<String>) {
        match value {
            Value::String(path) if path.starts_with("./") => {
                if let Ok(path) = relative(path) {
                    excluded.insert(path);
                }
            }
            Value::Array(values) => {
                for value in values {
                    paths(value, excluded);
                }
            }
            Value::Object(values) => {
                for value in values.values() {
                    paths(value, excluded);
                }
            }
            _ => {}
        }
    }
    let mut excluded = std::collections::BTreeSet::new();
    if let Some(fields) = metadata.as_object() {
        for (name, value) in fields {
            if UNSUPPORTED.contains(&name.as_str())
                || name == "experimental"
                || name.starts_with("experimental.")
            {
                paths(value, &mut excluded);
            }
        }
    }
    tree.files.retain(|name, _| {
        !excluded.contains(name)
            && !name
                .match_indices('/')
                .any(|(index, _)| excluded.contains(&name[..index]))
    });
}

pub(super) fn json(bytes: &[u8], limits: &Limits) -> Result<Value, Refusal> {
    if bytes.len() as u64 > limits.manifest_bytes {
        return Err(Refusal::invalid(
            reason::TOO_LARGE,
            "plugin configuration exceeds the manifest byte limit",
        ));
    }
    serde_json::from_slice(bytes)
        .map_err(|_| invalid("plugin configuration is not valid UTF-8 JSON"))
}

pub(super) fn manifest(
    tree: &SourceTree,
    limits: &Limits,
    skipped: &mut Vec<SkippedComponent>,
) -> Result<Value, Refusal> {
    let Some(file) = tree.files.get(".claude-plugin/plugin.json") else {
        return Ok(json!({"name":tree.name_hint}));
    };
    let metadata = json(&file.bytes, limits)?;
    if !metadata.is_object() || metadata["name"].as_str().is_none_or(str::is_empty) {
        return Err(invalid("plugin.json requires a non-empty string name"));
    }
    for (key, value) in metadata.as_object().into_iter().flatten() {
        if key == "experimental" {
            if let Some(fields) = value.as_object() {
                for key in fields.keys() {
                    skipped.push(SkippedComponent {
                        name: format!("experimental.{key}"),
                        reason: "unsupported component; not copied or executed".into(),
                    });
                }
            } else {
                skipped.push(SkippedComponent {
                    name: key.clone(),
                    reason: "unsupported component; not copied or executed".into(),
                });
            }
        } else if UNSUPPORTED.contains(&key.as_str()) || key.starts_with("experimental.") {
            skipped.push(SkippedComponent {
                name: key.clone(),
                reason: "unsupported component; not copied or executed".into(),
            });
        } else if ![
            "name",
            "version",
            "description",
            "author",
            "license",
            "keywords",
            "homepage",
            "repository",
            "skills",
            "mcpServers",
            "userConfig",
        ]
        .contains(&key.as_str())
        {
            skipped.push(SkippedComponent {
                name: key.clone(),
                reason: "source metadata is not imported as configuration or trust".into(),
            });
        }
    }
    Ok(metadata)
}
