//! Selected bundle children share one rollback boundary; the wrapper never acquires their operational authority.
use super::commit::{self, Agents, ModuleHost, Rollback};
use super::index;
use super::lifecycle::{self, Target, ToggleOpts};
use super::overlays::{self, Overlay};
use super::paths::ExtPaths;
use super::record::{self, state_invalid};
use super::state::{self, ExtState, ItemRecord};
use super::ExtError;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub(crate) fn require_settled(layout: &Layout) -> Result<(), ExtError> {
    if super::bundle_transaction::pending(layout) {
        return Err(ExtError::new(
            "E_NOT_AVAILABLE",
            "state-invalid",
            "the previous bundle transaction requires recovery before another mutation",
        ));
    }
    Ok(())
}

fn member_error(parent: &str) -> ExtError {
    ExtError::new("E_CONFLICT", "bundle-member", format!("this child belongs to bundle {parent}; manage the bundle with its complete member disclosure"))
}
fn owner<'a>(state: &'a ExtState, name: &str, required_only: bool) -> Option<&'a ItemRecord> {
    state.items.values().find(|parent| {
        parent.kind == "bundle"
            && parent
                .members
                .iter()
                .any(|member| member.name == name && (!required_only || !member.optional))
    })
}
pub(crate) fn check_independent_update(layout: &Layout, name: &str) -> Result<(), ExtError> {
    let state = state::read(&ExtPaths::of(layout)).map_err(state_invalid)?;
    if let Some(parent) = owner(&state, name, false) {
        return Err(member_error(&parent.name));
    }
    Ok(())
}
pub(crate) fn check_independent_toggle(state: &ExtState, name: &str) -> Result<(), ExtError> {
    if let Some(parent) = owner(state, name, true) {
        return Err(member_error(&parent.name));
    }
    Ok(())
}
pub(crate) fn check_independent_remove(state: &ExtState, name: &str) -> Result<(), ExtError> {
    check_independent_toggle(state, name)
}

pub(crate) use super::bundle_members::{consent_sha256, member_inspections, summary};
use super::bundle_members::{metadata, mismatch};
pub(crate) use super::bundle_update::{precheck_preservation, preserve_activation_held};

fn preflight(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    name: &str,
    opts: &ToggleOpts,
    on: bool,
    allow_missing: bool,
) -> Result<(ItemRecord, Vec<ItemRecord>, String), ExtError> {
    let paths = ExtPaths::of(layout);
    let state = state::read(&paths).map_err(state_invalid)?;
    let parent = state
        .items
        .get(name)
        .filter(|r| r.kind == "bundle")
        .ok_or_else(|| lifecycle::unknown(name))?
        .clone();
    let disclosures = if on {
        member_inspections(layout, &parent)?
    } else {
        member_inspections(layout, &parent).unwrap_or_default()
    };
    let consent = consent_sha256(&parent, &disclosures);
    if opts
        .expected_consent_sha256
        .as_ref()
        .is_some_and(|expected| expected != &consent)
    {
        return Err(ExtError::new(
            "E_CONFLICT",
            "inspection-changed",
            "the bundle consent subject changed; inspect its selected members again",
        ));
    }
    let mut children = Vec::new();
    for member in &parent.members {
        if let Some(child) = state.items.get(&member.name) {
            if child.package_sha256 != member.sha256
                || child.kind != member.kind
                || child.version != member.version
            {
                return Err(mismatch());
            }
            children.push(child.clone());
        } else if on {
            return Err(mismatch());
        }
    }
    if on {
        let cfg = host.config();
        let agents = opts.agents.clone().unwrap_or(Agents::All);
        for record in std::iter::once(&parent).chain(children.iter()) {
            lifecycle::refuse_missing_code(
                layout,
                &Target {
                    name: record.name.clone(),
                    kind: record.kind.clone(),
                    version: record.version.clone(),
                    record: Some(record.clone()),
                },
            )?;
        }
        let facts = super::host::host_facts();
        let revocations = overlays::load_revocations(&paths);
        let mut wrapper = parent.clone();
        wrapper.integrity = Some(overlays::rehash(layout, &parent));
        lifecycle::refuse_overlays(
            &paths,
            &wrapper,
            &overlays::overlays_with_missing(&wrapper, &facts, &revocations, None, &[]),
            &[],
        )?;
        for child in &mut children {
            lifecycle::check_agents(&child.name, &child.kind, &cfg, &agents)?;
            child.integrity = Some(overlays::rehash(layout, child));
            let missing = host.missing_secrets(&child.name, &child.required_secrets);
            let compat = metadata(&paths, &child.package_sha256)?["manifest"]
                .get("compat")
                .cloned();
            let mut found = overlays::overlays_with_missing(
                child,
                &facts,
                &revocations,
                compat.as_ref(),
                &missing,
            );
            if allow_missing {
                found.retain(|overlay| *overlay != Overlay::NeedsSetup);
            }
            lifecycle::refuse_overlays(&paths, child, &found, &missing)?;
            if let Err(mut error) = lifecycle::check_acknowledged(&paths, child, opts) {
                if error.code == "E_APPROVAL_REQUIRED" {
                    error.data = json!({"name":name,"id":parent.id,"version":parent.version,"kind":"bundle",
                        "trust":parent.trust,"consentSha256":consent,"members":disclosures});
                }
                return Err(error);
            }
        }
        if parent.capabilities_ack.as_deref() != Some(consent.as_str())
            && !opts.acknowledge.iter().any(|a| a == "capabilities")
        {
            return Err(ExtError::new(
                "E_APPROVAL_REQUIRED",
                "acknowledge-capabilities",
                "acknowledge the full selected bundle composition before enabling it",
            )
            .with_data(
                json!({"name":name,"kind":"bundle","consentSha256":consent,"members":disclosures}),
            ));
        }
    }
    Ok((parent, children, consent))
}

pub(crate) fn activate_held<'a>(
    layout: &'a Layout,
    host: &mut dyn ModuleHost,
    name: &str,
    opts: &ToggleOpts,
    on: bool,
    rb: &mut Rollback<'a>,
) -> Result<Value, ExtError> {
    activate_install_held(layout, host, name, opts, on, false, rb)
}

pub(crate) fn activate_install_held<'a>(
    layout: &'a Layout,
    host: &mut dyn ModuleHost,
    name: &str,
    opts: &ToggleOpts,
    on: bool,
    allow_missing: bool,
    rb: &mut Rollback<'a>,
) -> Result<Value, ExtError> {
    let (mut parent, children, consent) = preflight(layout, host, name, opts, on, allow_missing)?;
    let paths = ExtPaths::of(layout);
    let mut state = state::read(&paths).map_err(state_invalid)?;
    let mut projected = host.config();
    let mut changes = BTreeMap::new();
    let mut restore = BTreeMap::new();
    let mut idx = index::read_index(layout)?;
    let original = idx.clone();
    let agents = opts.agents.clone().unwrap_or(Agents::All);
    for mut child in children {
        let (writes, undo) = match child.kind.as_str() {
            "skill" => {
                let selected_disable = !on && matches!(opts.agents, Some(Agents::Some(_)));
                let enabled = on
                    || selected_disable
                        && idx
                            .entry(&child.name)
                            .is_some_and(|entry| entry["enabled"] == true);
                let mut entry = idx.entry(&child.name).cloned().unwrap_or_else(|| {
                    index::package_entry(&child, "-", enabled, &super::now_iso(), None)
                });
                entry["enabled"] = json!(enabled);
                idx.upsert(entry);
                if on {
                    lifecycle::skill_enable_changes(&projected, &child.name, &agents)
                } else if let Some(Agents::Some(list)) = &opts.agents {
                    lifecycle::skill_disable_changes(&projected, &child.name, list)
                } else {
                    (vec![], vec![])
                }
            }
            "mcp-server" => {
                let (c, r, _) =
                    lifecycle::mcp_activation_changes(&projected, &child.name, &agents, on);
                (c, r)
            }
            _ => {
                let key = record::config_key(&child.name, &child.kind);
                if allow_missing
                    && on
                    && !host
                        .missing_secrets(&child.name, &child.required_secrets)
                        .is_empty()
                {
                    host.hold_for_setup(&child.name);
                }
                (
                    vec![(format!("{key}.enabled"), json!(on))],
                    vec![(
                        key,
                        record::config_section(&projected, &child.name, &child.kind),
                    )],
                )
            }
        };
        for (key, value) in undo {
            restore.entry(key).or_insert(value);
        }
        projected = commit::apply_changes(&projected, &writes)?;
        changes.extend(writes);
        if on {
            child.capabilities_ack = Some(commit::capabilities_hash(&child.capabilities));
            state.items.insert(child.name.clone(), child);
        }
    }
    let now_on = !parent.members.is_empty()
        && parent.members.iter().all(|member| {
            commit::enabled_in(layout, Some(&idx), &projected, &member.name, &member.kind)
        });
    let changes: Vec<_> = changes.into_iter().collect();
    let plan = if opts.dry_run {
        host.set_config(changes, true)?
    } else {
        parent.capabilities_ack = on.then_some(consent).or(parent.capabilities_ack);
        state.items.insert(name.to_string(), parent);
        let before = commit::read_bytes(&paths.state);
        state::write(&paths, &state)
            .map_err(|e| record::io_err("cannot write", &paths.state, e))?;
        rb.push(
            "bundle.state",
            commit::restore_file(paths.state.clone(), before),
        );
        let plan = if changes.is_empty() {
            json!({"restart":{"modules":[]},"heldBack":[]})
        } else {
            commit::config_change(
                host,
                "bundle.config",
                changes,
                restore.into_iter().collect(),
                rb,
            )?
        };
        if idx != original {
            let path = index::index_path(layout);
            let before = commit::read_bytes(&path);
            index::write_index(layout, &idx)
                .map_err(|e| record::io_err("cannot write", &path, e))?;
            rb.push("bundle.index", commit::restore_file(path, before));
        }
        plan
    };
    Ok(
        json!({"name":name,"state":if now_on {"enabled"}else{"installed"},"restart":plan["restart"],"heldBack":plan["heldBack"]}),
    )
}

pub(crate) fn with_holds<T>(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    records: &[ItemRecord],
    operation: impl FnOnce(&mut dyn ModuleHost) -> Result<T, ExtError>,
) -> Result<T, ExtError> {
    let mut held = Vec::new();
    for child in records.iter().filter(|child| child.kind == "mcp-server") {
        match host.hold_runtime(&child.name) {
            Ok(true) => held.push(child.name.clone()),
            Ok(false) => {}
            Err(error) => {
                for name in held.iter().rev() {
                    let _ = host.release_runtime(name);
                }
                return Err(error);
            }
        }
    }
    let result = operation(host);
    if super::bundle_transaction::pending(layout) {
        return result;
    }
    let mut release = None;
    for name in held.iter().rev() {
        if let Err(error) = host.release_runtime(name) {
            release = Some(error);
        }
    }
    match result {
        Err(error) => Err(error),
        Ok(value) => match release {
            Some(error) => Err(error),
            None => Ok(value),
        },
    }
}

pub(crate) fn toggle_held(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    name: &str,
    opts: &ToggleOpts,
    on: bool,
) -> Result<Value, ExtError> {
    commit::reset_kill();
    let (parent, children, _) = preflight(layout, host, name, opts, on, false)?;
    if opts.dry_run {
        return activate_held(layout, host, name, opts, on, &mut Rollback::default());
    }
    let _skills = index::lock_skills(layout)?;
    let mut records = children;
    records.push(parent);
    with_holds(layout, host, &records, |host| {
        let result = super::bundle_transaction::run(layout, host, &records, &[], |host, rb| {
            activate_held(layout, host, name, opts, on, rb)
        })?;
        super::remove::audit(
            layout,
            if on { "ext.enable" } else { "ext.disable" },
            name,
            json!({"kind":"bundle","members":records.iter().filter(|r|r.kind!="bundle").map(|r|&r.name).collect::<Vec<_>>(),"via":host.via()}),
        );
        host.notify(json!({"name":name,"kind":"bundle","state":result["state"],"version":records.last().unwrap().version,"overlays":[]}));
        Ok(result)
    })
}

pub(crate) fn remove_members_held<'a>(
    layout: &'a Layout,
    host: &mut dyn ModuleHost,
    records: &[ItemRecord],
    rb: &mut Rollback<'a>,
) -> Result<Vec<String>, ExtError> {
    let paths = ExtPaths::of(layout);
    let mut ids = Vec::new();
    for record in records {
        let target = Target {
            name: record.name.clone(),
            kind: record.kind.clone(),
            version: record.version.clone(),
            record: Some(record.clone()),
        };
        let (id, _) = super::remove::move_to_trash(
            layout,
            &paths,
            host,
            &target,
            &super::remove::RemoveOpts::default(),
            rb,
        )?;
        ids.push(id);
    }
    Ok(ids)
}

pub(crate) fn uninstall_held(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    name: &str,
    opts: &super::remove::RemoveOpts,
) -> Result<Value, ExtError> {
    let (parent, mut children, _) =
        preflight(layout, host, name, &ToggleOpts::default(), false, false)?;
    let cfg = host.config();
    let mut outside = std::collections::BTreeSet::new();
    for child in &children {
        outside.extend(
            lifecycle::dependents(layout, &cfg, &child.name)
                .into_iter()
                .filter(|name| !children.iter().any(|child| &child.name == name)),
        );
    }
    if !outside.is_empty() && !opts.cascade {
        return Err(ExtError::new(
            "E_CONFLICT",
            "required-by",
            "a module outside the bundle still requires a selected child",
        )
        .with_data(json!({"dependents":outside})));
    }
    let current = state::read(&ExtPaths::of(layout)).map_err(state_invalid)?;
    for name in &outside {
        check_independent_toggle(&current, name)?;
    }
    let mut slots = Vec::new();
    if opts.purge {
        for child in &children {
            let mut declared = std::collections::BTreeSet::new();
            declared.extend(super::runtime::declared_slots(&child.capabilities)?);
            for version in child.versions.values() {
                declared.extend(super::runtime::declared_slots(&version.capabilities)?);
            }
            if !declared.is_empty() {
                slots.push((child.name.clone(), declared.into_iter().collect::<Vec<_>>()));
            }
        }
        if !slots.is_empty() {
            host.check_secret_store()?;
        }
    }
    let _skills = index::lock_skills(layout)?;
    children.push(parent);
    let result = with_holds(layout, host, &children, |host| {
        let committed =
            super::bundle_transaction::run(layout, host, &children, &[], |host, rb| {
                if !outside.is_empty() {
                    let changes = outside
                        .iter()
                        .map(|name| (format!("modules.{name}.enabled"), json!(false)))
                        .collect();
                    let restore = outside
                        .iter()
                        .map(|name| (format!("modules.{name}"), cfg["modules"][name].clone()))
                        .collect();
                    commit::config_change(host, "bundle.cascade", changes, restore, rb)?;
                }
                activate_held(layout, host, name, &ToggleOpts::default(), false, rb)?;
                let paths = ExtPaths::of(layout);
                let mut parent_trash = None;
                let mut member_trash = BTreeMap::new();
                for child in &children {
                    let target = Target {
                        name: child.name.clone(),
                        kind: child.kind.clone(),
                        version: child.version.clone(),
                        record: Some(child.clone()),
                    };
                    let (id, _) =
                        super::remove::move_to_trash(layout, &paths, host, &target, opts, rb)?;
                    if child.name == name {
                        parent_trash = Some(id);
                    } else {
                        member_trash.insert(child.name.clone(), id);
                    }
                }
                if let Some(id) = &parent_trash {
                    let path = paths.trash.join(id).join("record.json");
                    let mut body: Value = serde_json::from_slice(
                        &std::fs::read(&path)
                            .map_err(|e| record::io_err("cannot read", &path, e))?,
                    )
                    .map_err(|_| mismatch())?;
                    body["memberTrashIds"] = json!(member_trash);
                    state::write_private_atomic(
                        &path,
                        &serde_json::to_vec(&body).map_err(|_| mismatch())?,
                    )
                    .map_err(|e| record::io_err("cannot write", &path, e))?;
                }
                Ok(json!({"name":name,"removed":true,"trashId":parent_trash,"purged":opts.purge}))
            })?;
        super::remove::audit(
            layout,
            if opts.purge {
                "ext.purge"
            } else {
                "ext.uninstall"
            },
            name,
            json!({"kind":"bundle","trashId":committed["trashId"],"purged":opts.purge,"members":children.iter().filter(|child|child.kind!="bundle").map(|child|&child.name).collect::<Vec<_>>(),"via":host.via()}),
        );
        host.notify(json!({"name":name,"kind":"bundle","state":"removed","version":children.last().unwrap().version,"overlays":[]}));
        Ok(committed)
    })?;
    // Irreversible deletion is deliberately after a completed reversible group transaction.
    let mut incomplete = false;
    for (name, declared) in slots {
        if host.purge_secrets(&name, &declared).is_err() {
            incomplete = true;
        }
    }
    if incomplete {
        return Err(ExtError::new("E_NOT_AVAILABLE","secret-store-unavailable",
        "the bundle was removed, but deletion of all declared child secret slots could not be confirmed"));
    }
    Ok(result)
}
