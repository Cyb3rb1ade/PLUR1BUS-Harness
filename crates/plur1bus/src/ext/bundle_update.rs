//! Preserve a previously approved composition's activation while code updates in the shared bundle transaction.
use super::commit::{self, Agents, ModuleHost, Rollback};
use super::index::{self, SkillIndex};
use super::lifecycle;
use super::paths::ExtPaths;
use super::record::{self, state_invalid};
use super::state::{self, ExtState, ItemRecord};
use super::ExtError;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub(crate) struct Preservation<'a> {
    pub previous_state: &'a ExtState,
    pub previous_config: &'a Value,
    pub previous_index: &'a SkillIndex,
    pub new_parent: &'a ItemRecord,
    pub new_children: &'a [ItemRecord],
    pub approved: bool,
}
struct Activation<'a> {
    record: &'a ItemRecord,
    enabled: bool,
    agents: Agents,
    existing: bool,
}
fn conflict() -> ExtError {
    ExtError::new(
        "E_CONFLICT",
        "composition-conflict",
        "the previous bundle activation no longer has one consistent required-member scope",
    )
}
fn enabled(record: &ItemRecord, p: &Preservation<'_>) -> bool {
    match record.kind.as_str() {
        "skill" => p
            .previous_index
            .entry(&record.name)
            .is_none_or(|entry| entry["enabled"] == true),
        "mcp-server" => p.previous_config["mcp"]["servers"][&record.name]["enabled"] == true,
        _ => p.previous_config["modules"][&record.name]["enabled"] != false,
    }
}
fn agents(record: &ItemRecord, cfg: &Value) -> Agents {
    let selected = super::list::agents_of(cfg, &record.name, &record.kind, true);
    if selected == "all" {
        Agents::All
    } else {
        Agents::Some(record::strings(&selected))
    }
}
fn canonical(agents: &Agents, cfg: &Value) -> Vec<String> {
    let mut values = match agents {
        Agents::Some(values) => values.clone(),
        Agents::All => cfg["agents"]
            .as_object()
            .map(|agents| agents.keys().cloned().collect())
            .unwrap_or_default(),
    };
    values.sort();
    values.dedup();
    values
}
fn plan<'a>(p: &'a Preservation<'_>) -> Result<Vec<Activation<'a>>, ExtError> {
    let old = p
        .previous_state
        .items
        .get(&p.new_parent.name)
        .ok_or_else(conflict)?;
    let required: Vec<_> = old
        .members
        .iter()
        .filter(|member| !member.optional)
        .map(|member| {
            p.previous_state
                .items
                .get(&member.name)
                .ok_or_else(conflict)
        })
        .collect::<Result<_, _>>()?;
    let active = !required.is_empty() && required.iter().all(|record| enabled(record, p));
    let inherited = required
        .first()
        .map(|record| agents(record, p.previous_config))
        .unwrap_or(Agents::All);
    if active
        && required.iter().any(|record| {
            canonical(&agents(record, p.previous_config), p.previous_config)
                != canonical(&inherited, p.previous_config)
        })
    {
        return Err(conflict());
    }
    let mut result = Vec::new();
    for member in &p.new_parent.members {
        let new = p
            .new_children
            .iter()
            .find(|record| {
                record.name == member.name
                    && record.kind == member.kind
                    && record.version == member.version
                    && record.package_sha256 == member.sha256
            })
            .ok_or_else(conflict)?;
        let prior = old
            .members
            .iter()
            .find(|member| member.name == new.name)
            .map(|member| {
                p.previous_state
                    .items
                    .get(&member.name)
                    .ok_or_else(conflict)
            })
            .transpose()?;
        let (enabled, scope) = match prior {
            Some(prior) => (enabled(prior, p), agents(prior, p.previous_config)),
            None => (active && !member.optional, inherited.clone()),
        };
        if enabled && !p.approved {
            return Err(ExtError::new("E_CONFLICT","inspection-changed","inspect and approve the updated selected bundle composition before preserving active children"));
        }
        result.push(Activation {
            record: new,
            enabled,
            agents: scope,
            existing: prior.is_some(),
        });
    }
    Ok(result)
}

/// Called before code/config writes and runtime holds, using only verified staged child records and fresh names.
pub(crate) fn precheck_preservation(
    _layout: &Layout,
    host: &mut dyn ModuleHost,
    p: &Preservation<'_>,
) -> Result<(), ExtError> {
    for activation in plan(p)? {
        if activation.enabled {
            lifecycle::check_agents(
                &activation.record.name,
                &activation.record.kind,
                p.previous_config,
                &activation.agents,
            )?;
            if !activation.existing
                && !host
                    .missing_secrets(&activation.record.name, &activation.record.required_secrets)
                    .is_empty()
            {
                return Err(ExtError::new("E_NOT_AVAILABLE","needs-setup","a new required bundle member needs its declared secret slots before activation"));
            }
        }
    }
    Ok(())
}

/// Caller owns the ext/skills locks, code holds and shared rollback. No interpreter or secret value is acquired here.
pub(crate) fn preserve_activation_held<'a>(
    layout: &'a Layout,
    host: &mut dyn ModuleHost,
    p: &Preservation<'_>,
    rb: &mut Rollback<'a>,
) -> Result<(), ExtError> {
    precheck_preservation(layout, host, p)?;
    let paths = ExtPaths::of(layout);
    let mut state = state::read(&paths).map_err(state_invalid)?;
    let mut cfg = host.config();
    let mut changes = BTreeMap::new();
    let mut restore = BTreeMap::new();
    let mut idx = index::read_index(layout)?;
    let old_index = idx.clone();
    for activation in plan(p)? {
        let name = &activation.record.name;
        let (writes, undo) = match activation.record.kind.as_str() {
            "skill" => {
                let mut entry = idx.entry(name).cloned().ok_or_else(conflict)?;
                entry["enabled"] = json!(activation.enabled);
                idx.upsert(entry);
                if activation.existing || activation.enabled {
                    lifecycle::skill_enable_changes(&cfg, name, &activation.agents)
                } else {
                    (vec![], vec![])
                }
            }
            "mcp-server" => {
                let key = record::config_key(name, "mcp-server");
                let previous = record::config_section(&cfg, name, "mcp-server");
                let mut next = if previous.is_object() {
                    previous.clone()
                } else {
                    json!({})
                };
                next["enabled"] = json!(activation.enabled);
                next["agents"] = match &activation.agents {
                    Agents::All => json!("all"),
                    Agents::Some(ids) => json!(ids),
                };
                (vec![(key.clone(), next)], vec![(key, previous)])
            }
            _ => {
                if activation.enabled
                    && !host
                        .missing_secrets(name, &activation.record.required_secrets)
                        .is_empty()
                {
                    host.hold_for_setup(name);
                }
                let key = record::config_key(name, &activation.record.kind);
                (
                    vec![(format!("{key}.enabled"), json!(activation.enabled))],
                    vec![(
                        key,
                        record::config_section(&cfg, name, &activation.record.kind),
                    )],
                )
            }
        };
        for (key, value) in undo {
            restore.entry(key).or_insert(value);
        }
        cfg = commit::apply_changes(&cfg, &writes)?;
        changes.extend(writes);
        if activation.enabled && p.approved {
            let record = state.items.get_mut(name).ok_or_else(conflict)?;
            record.capabilities_ack = Some(commit::capabilities_hash(&record.capabilities));
        }
    }
    let parent = state
        .items
        .get(&p.new_parent.name)
        .ok_or_else(conflict)?
        .clone();
    let disclosures = super::bundle_members::member_inspections(layout, &parent)?;
    state
        .items
        .get_mut(&parent.name)
        .ok_or_else(conflict)?
        .capabilities_ack = p
        .approved
        .then(|| super::bundle_members::consent_sha256(&parent, &disclosures));
    let before = commit::read_bytes(&paths.state);
    state::write(&paths, &state)
        .map_err(|error| record::io_err("cannot write", &paths.state, error))?;
    rb.push(
        "bundle.preserved-state",
        commit::restore_file(paths.state.clone(), before),
    );
    if !changes.is_empty() {
        commit::config_change(
            host,
            "bundle.preserved-config",
            changes.into_iter().collect(),
            restore.into_iter().collect(),
            rb,
        )?;
    }
    if idx != old_index {
        let path = index::index_path(layout);
        let before = commit::read_bytes(&path);
        index::write_index(layout, &idx)
            .map_err(|error| record::io_err("cannot write", &path, error))?;
        rb.push("bundle.preserved-index", commit::restore_file(path, before));
    }
    Ok(())
}
