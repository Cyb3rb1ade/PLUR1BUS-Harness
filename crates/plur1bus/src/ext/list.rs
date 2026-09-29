//! `ext.list` and `ext.show` (spec §6.2, §10.2; X1-R12, X1-R17, X1-R26): `extensions/state.json`, `skills/index.json`,
//! the skill folders without an index entry, `modules::scan` and `config.json` joined into what a person sees.
//!
//! Supervisor-safe (X1-R2): what `ext.show` says about a package (its manifest, trust verdict and scripts) comes from
//! the cache's `<sha256>.json`, written at install from the worker's inspection; package bytes are never opened.
use super::commit::enabled_now;
use super::index::{self, SkillIndex};
use super::overlays::{load_revocations, overlays_of, rehash, Revocation};
use super::paths::ExtPaths;
use super::state::{self, ItemRecord};
use super::ExtError;
use crate::paths::Layout;
use plur1bus_ext::compat::HostFacts;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// `ext.list`'s filter: kinds, plain states (`installed`, `enabled`) and one agent (the items it effectively has).
#[derive(Clone, Debug, Default)]
pub struct ListFilter {
    pub kind: Option<Vec<String>>,
    pub state: Option<Vec<String>>,
    pub agent: Option<String>,
}

/// One listed item: its `ExtItem`, its package record when it has one, and where its code lives.
struct Entry {
    item: Value,
    record: Option<ItemRecord>,
    dir: PathBuf,
}

/// The importer's `SKILL_ID` (and the `ExtItem` name pattern): `^[a-z0-9][a-z0-9._-]{0,63}$`.
fn name_ok(n: &str) -> bool {
    let b = n.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..].iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

fn warn(msg: String) {
    eprintln!("plur1bus: warning: {msg}");
}

/// `{manifest, trust, scripts}` from `extensions/cache/<sha256>.json`, if the install wrote one.
fn cached_meta(paths: &ExtPaths, sha256: &str) -> Option<Value> {
    std::fs::read_to_string(paths.cached_meta(sha256))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
}

/// `name → (source, version)` of the install manifest's `skills[]` or `modules[]` (`<home>/manifest.json`, read as
/// plain JSON).
fn install_units(layout: &Layout, key: &str) -> BTreeMap<String, (String, String)> {
    let v: Value = std::fs::read_to_string(layout.install_manifest())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    v[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|u| {
            Some((
                u["name"].as_str()?.to_string(),
                (
                    u["source"].as_str().unwrap_or("").to_string(),
                    u["version"].as_str().unwrap_or("").to_string(),
                ),
            ))
        })
        .collect()
}

/// `"all"` or the agents a skill is effective for (X1-R11): none when it is disabled, else every configured agent that
/// does not block it, and `"all"` when none does. Modules and channels: `"all"`.
fn agents_of(cfg: &Value, name: &str, kind: &str, enabled: bool) -> Value {
    if kind != "skill" {
        return json!("all");
    }
    if !enabled {
        return json!([]);
    }
    let Some(map) = cfg["agents"].as_object() else {
        return json!("all");
    };
    let blocks = |a: &Value| {
        a["skills"]["blocked"]
            .as_array()
            .is_some_and(|l| l.iter().any(|x| x == name))
    };
    if !map.values().any(blocks) {
        return json!("all");
    }
    json!(map
        .iter()
        .filter(|(_, a)| !blocks(a))
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>())
}

#[allow(clippy::too_many_arguments)]
fn item_json(
    name: &str,
    id: Option<&str>,
    kind: &str,
    version: &str,
    source: &str,
    trust: &str,
    enabled: bool,
    overlays: Value,
    cfg: &Value,
) -> Value {
    json!({
        "name": name,
        "id": id,
        "kind": kind,
        "version": version,
        "source": source,
        "trust": trust,
        "state": if enabled { "enabled" } else { "installed" },
        "overlays": overlays,
        "enabled": enabled,
        "agents": agents_of(cfg, name, kind, enabled),
    })
}

/// The `ExtItem` of a package record.
fn record_item(
    layout: &Layout,
    paths: &ExtPaths,
    cfg: &Value,
    rec: &ItemRecord,
    host: &HostFacts,
    revs: &[Revocation],
) -> Value {
    let enabled = enabled_now(layout, cfg, &rec.name, &rec.kind);
    let meta = cached_meta(paths, &rec.package_sha256);
    let compat = meta
        .as_ref()
        .and_then(|m| m["manifest"].get("compat").cloned());
    let overlays = overlays_of(rec, host, revs, compat.as_ref());
    let mut item = item_json(
        &rec.name,
        Some(&rec.id),
        &rec.kind,
        &rec.version,
        &rec.source,
        &rec.trust,
        enabled,
        json!(overlays),
        cfg,
    );
    item["integrity"] = json!(match &rec.integrity {
        None => "unchecked",
        Some(i) if i.ok => "ok",
        Some(_) => "tampered",
    });
    item
}

fn code_dir(layout: &Layout, name: &str, kind: &str) -> PathBuf {
    if kind == "skill" {
        layout.skills().join(name)
    } else {
        layout.modules_dir().join(name)
    }
}

/// Every item, sorted by name (see the module documentation).
fn collect(layout: &Layout, cfg: &Value) -> Vec<Entry> {
    let paths = ExtPaths::of(layout);
    let st = state::read(&paths).unwrap_or_else(|e| {
        warn(e);
        state::ExtState::default()
    });
    let idx = index::read_index(layout).unwrap_or_else(|e| {
        warn(e.to_string());
        SkillIndex(json!({"version": 1, "skills": []}))
    });
    let host = super::host::host_facts();
    let revs = load_revocations(&paths);
    let mut out: BTreeMap<String, Entry> = BTreeMap::new();

    // Package records (a bundled item the person hid, X1-R18, is not listed).
    for rec in st.items.values() {
        if rec.removed_by_user || !matches!(rec.kind.as_str(), "skill" | "module" | "channel") {
            continue;
        }
        out.insert(
            rec.name.clone(),
            Entry {
                item: record_item(layout, &paths, cfg, rec, &host, &revs),
                record: Some(rec.clone()),
                dir: code_dir(layout, &rec.name, &rec.kind),
            },
        );
    }
    let hidden: BTreeSet<String> = st
        .items
        .values()
        .filter(|r| r.removed_by_user)
        .map(|r| r.name.clone())
        .collect();
    let bundled_skills = install_units(layout, "skills");
    // Index entries without a record: imported skills (or a bundled or local one an ext mutation indexed).
    for e in idx.0["skills"].as_array().into_iter().flatten() {
        let Some(name) = e["id"].as_str() else {
            continue;
        };
        if out.contains_key(name) || hidden.contains(name) {
            continue;
        }
        let source = e["source"].as_str().unwrap_or("imported");
        let trust = match source {
            "bundled" => "release",
            "local" => "dev",
            "file" => "unsigned",
            _ => "imported",
        };
        let version = e["package"]["version"]
            .as_str()
            .map(str::to_string)
            .or_else(|| bundled_skills.get(name).map(|(_, v)| v.clone()))
            .unwrap_or_default();
        let enabled = e["enabled"] == true;
        out.insert(
            name.to_string(),
            Entry {
                item: item_json(
                    name,
                    e["package"]["id"].as_str(),
                    "skill",
                    &version,
                    source,
                    trust,
                    enabled,
                    json!([]),
                    cfg,
                ),
                record: None,
                dir: layout.skills().join(name),
            },
        );
    }
    // Skill folders without an index entry: enabled, bundled or local (X1-R12).
    if let Ok(entries) = std::fs::read_dir(layout.skills()) {
        for e in entries.flatten() {
            let Ok(name) = e.file_name().into_string() else {
                continue;
            };
            let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
            if !is_dir || !name_ok(&name) || name.contains(".tmp-") || out.contains_key(&name) {
                continue;
            }
            if hidden.contains(&name) {
                continue;
            }
            let (source, trust, version) = match bundled_skills.get(&name) {
                Some((s, v)) if s == "bundled" => ("bundled", "release", v.clone()),
                _ => ("local", "dev", String::new()),
            };
            out.insert(
                name.clone(),
                Entry {
                    item: item_json(
                        &name,
                        None,
                        "skill",
                        &version,
                        source,
                        trust,
                        true,
                        json!([]),
                        cfg,
                    ),
                    record: None,
                    dir: e.path(),
                },
            );
        }
    }
    // Module directories without a record: bundled (release) or local (dev).
    let bundled_modules = install_units(layout, "modules");
    for m in crate::modules::manifest::scan(layout) {
        if out.contains_key(&m.name) || hidden.contains(&m.name) || !name_ok(&m.name) {
            continue;
        }
        let (kind, version, overlays) = match &m.manifest {
            Ok(x) => (
                x.kind.clone().unwrap_or_else(|| "module".into()),
                x.version.clone(),
                json!([]),
            ),
            Err(_) => ("module".into(), String::new(), json!(["error"])),
        };
        if !matches!(kind.as_str(), "module" | "channel") {
            continue;
        }
        let (source, trust) = match bundled_modules.get(&m.name) {
            Some((s, _)) if s == "bundled" => ("bundled", "release"),
            _ => ("local", "dev"),
        };
        let enabled = cfg["modules"][&m.name]["enabled"] != false;
        out.insert(
            m.name.clone(),
            Entry {
                item: item_json(
                    &m.name, None, &kind, &version, source, trust, enabled, overlays, cfg,
                ),
                record: None,
                dir: m.dir.clone(),
            },
        );
    }
    out.into_values().collect()
}

fn keep(item: &Value, f: &ListFilter) -> bool {
    let has = |list: &Option<Vec<String>>, key: &str| {
        list.as_ref()
            .is_none_or(|l| l.iter().any(|x| item[key] == x.as_str()))
    };
    let for_agent = f.agent.as_ref().is_none_or(|a| {
        item["enabled"] == true
            && (item["agents"] == "all"
                || item["agents"]
                    .as_array()
                    .is_some_and(|l| l.iter().any(|x| x == a.as_str())))
    });
    has(&f.kind, "kind") && has(&f.state, "state") && for_agent
}

/// `ext.list`: `{items: ExtItem[]}`, sorted by name.
pub fn list_items(layout: &Layout, cfg: &Value, filter: &ListFilter) -> Value {
    let items: Vec<Value> = collect(layout, cfg)
        .into_iter()
        .map(|e| e.item)
        .filter(|i| keep(i, filter))
        .collect();
    json!({ "items": items })
}

/// Regular files under `dir` and their total size (for an item without a record).
fn count_files(dir: &Path) -> (u64, u64) {
    let mut n = 0;
    let mut bytes = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            let Ok(m) = std::fs::symlink_metadata(e.path()) else {
                continue;
            };
            if m.is_dir() {
                stack.push(e.path());
            } else if m.is_file() {
                n += 1;
                bytes += m.len();
            }
        }
    }
    (n, bytes)
}

/// The installed modules whose `needs` reach `name`, directly or through other modules, sorted.
fn dependents(layout: &Layout, name: &str) -> Vec<String> {
    let needs: BTreeMap<String, Vec<String>> = crate::modules::manifest::scan(layout)
        .into_iter()
        .filter_map(|m| m.manifest.ok().map(|x| (m.name, x.needs)))
        .collect();
    let mut found: BTreeSet<String> = BTreeSet::new();
    let mut frontier = vec![name.to_string()];
    while let Some(target) = frontier.pop() {
        for (m, n) in &needs {
            if m != name && n.contains(&target) && found.insert(m.clone()) {
                frontier.push(m.clone());
            }
        }
    }
    found.into_iter().collect()
}

/// The trash entries of `name` (X1-R19): `extensions/trash/<name>-<version>-<stamp>/record.json`, newest first.
fn trash_of(paths: &ExtPaths, name: &str) -> Vec<Value> {
    let mut out: Vec<(String, Value)> = Vec::new();
    let Ok(entries) = std::fs::read_dir(&paths.trash) else {
        return vec![];
    };
    for e in entries.flatten() {
        let Ok(tid) = e.file_name().into_string() else {
            continue;
        };
        let Some(rj) = std::fs::read_to_string(e.path().join("record.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        else {
            continue;
        };
        let rec_name = rj["record"]["name"]
            .as_str()
            .or_else(|| rj["index"]["id"].as_str());
        if rec_name != Some(name) {
            continue;
        }
        let removed = rj["removedAt"].as_str().unwrap_or("").to_string();
        out.push((
            removed.clone(),
            json!({
                "trashId": tid,
                "version": rj["record"]["version"].as_str().unwrap_or(""),
                "removedAt": removed,
            }),
        ));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|(_, v)| v).collect()
}

/// Stores a fresh integrity result in `state.json` (X1-R17), when no ext mutation runs and the record is still the
/// same package. Best effort: `ext.show` answers either way.
fn store_integrity(paths: &ExtPaths, rec: &ItemRecord) {
    let Ok(_guard) = super::try_mutation() else {
        return;
    };
    let Ok(mut st) = state::read(paths) else {
        return;
    };
    if let Some(r) = st.items.get_mut(&rec.name) {
        if r.package_sha256 == rec.package_sha256 && r.integrity != rec.integrity {
            r.integrity = rec.integrity.clone();
            if let Err(e) = state::write(paths, &st) {
                warn(format!(
                    "cannot record the integrity check in {}: {e}",
                    paths.state.display()
                ));
            }
        }
    }
}

/// `ext.show`: the `ExtDetail` of one item. A packaged item's files are re-hashed first (X1-R17) and the result is
/// stored in its record and reflected in `integrity` and `overlays`. Unknown → `E_NOT_FOUND extension-unknown`.
pub fn show_item(layout: &Layout, cfg: &Value, name: &str) -> Result<Value, ExtError> {
    let paths = ExtPaths::of(layout);
    let entry = collect(layout, cfg)
        .into_iter()
        .find(|e| e.item["name"] == name)
        .ok_or_else(|| {
            ExtError::new(
                "E_NOT_FOUND",
                "extension-unknown",
                format!("no extension named {name} is installed"),
            )
        })?;
    let Some(mut rec) = entry.record else {
        let (count, bytes) = count_files(&entry.dir);
        return Ok(json!({
            "item": entry.item,
            "manifest": null,
            "capabilities": {},
            "scripts": [],
            "trust": { "tier": entry.item["trust"] },
            "files": { "count": count, "bytes": bytes },
            "dependents": dependents(layout, name),
            "trash": trash_of(&paths, name),
        }));
    };
    rec.integrity = Some(rehash(layout, &rec));
    store_integrity(&paths, &rec);
    let host = super::host::host_facts();
    let revs = load_revocations(&paths);
    let item = record_item(layout, &paths, cfg, &rec, &host, &revs);
    let meta = cached_meta(&paths, &rec.package_sha256);
    let manifest = meta
        .as_ref()
        .map(|m| m["manifest"].clone())
        .filter(Value::is_object)
        .unwrap_or(Value::Null);
    let mut trust = meta
        .as_ref()
        .map(|m| m["trust"].clone())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    trust["tier"] = json!(rec.trust);
    if let Some(k) = &rec.key_id {
        trust["keyId"] = json!(k);
    }
    let scripts: Vec<Value> = match meta.as_ref().and_then(|m| m["scripts"].as_array().cloned()) {
        Some(list) => list
            .into_iter()
            .map(|mut s| {
                if let Some(p) = s["path"].as_str() {
                    s["path"] = json!(p.strip_prefix("payload/").unwrap_or(p));
                }
                s
            })
            .collect(),
        None => rec
            .scripts
            .iter()
            .map(|p| json!({ "path": p, "size": rec.files.get(p).map_or(0, |f| f.size) }))
            .collect(),
    };
    let capabilities = if rec.capabilities.is_object() {
        rec.capabilities.clone()
    } else {
        json!({})
    };
    Ok(json!({
        "item": item,
        "manifest": manifest,
        "capabilities": capabilities,
        "scripts": scripts,
        "trust": trust,
        "files": { "count": rec.files.len(), "bytes": rec.files.values().map(|f| f.size).sum::<u64>() },
        "dependents": if rec.kind == "skill" { vec![] } else { dependents(layout, name) },
        "trash": trash_of(&paths, name),
    }))
}
