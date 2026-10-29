//! One install transaction for an inert wrapper and its selected, individually verified children.
use super::commit::{self, Agents, InstallOpts, ModuleHost};
use super::paths::ExtPaths;
use super::record::{self, InspectionRecord, StagedItem};
use super::state;
use super::ExtError;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn invalid(message: &str) -> ExtError {
    ExtError::new("E_INVALID_PARAMS", "package-invalid", message)
}

/// Compare the disclosed rights of named children; code revisions transfer only an already valid identical grant.
fn rights_subject(members: &[Value]) -> Value {
    let subject:std::collections::BTreeMap<String,Value>=members.iter().map(|member|(
        member["name"].as_str().unwrap_or("").to_string(),
        json!({"kind":member["kind"],"optional":member["optional"],"trust":member["trust"],"capabilities":member["capabilities"],"scripts":member["scripts"],"requires":member["requires"]})
    )).collect();
    json!(subject)
}

pub(crate) fn install(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    rec: &InspectionRecord,
    staged: StagedItem,
    opts: &InstallOpts,
) -> Result<Value, ExtError> {
    let paths = ExtPaths::of(layout);
    let st = state::read(&paths).map_err(record::state_invalid)?;
    let cfg = host.config();
    commit::recheck(layout, &paths, &st, &staged, &cfg)?;
    if staged.members.len() != rec.members.len() || staged.members.len() > 256 {
        return Err(invalid(
            "the staged bundle member set differs from its verified inspection",
        ));
    }
    let names: BTreeSet<String> = match &opts.members {
        None => staged.members.iter().map(|m| m.item.name.clone()).collect(),
        Some(names) => {
            let selected: BTreeSet<_> = names.iter().cloned().collect();
            if selected.len() != names.len()
                || selected
                    .iter()
                    .any(|n| !staged.members.iter().any(|m| &m.item.name == n))
            {
                return Err(invalid(
                    "bundle member selection has unknown or repeated names",
                ));
            }
            selected
        }
    };
    if staged
        .members
        .iter()
        .any(|m| !m.optional && !names.contains(&m.item.name))
    {
        return Err(invalid("every nonoptional bundle member must be selected"));
    }
    // The complete staged answer is bound to the inspected parent; selection cannot approve substitute bytes.
    for (position, member) in staged.members.iter().enumerate() {
        let disclosure = rec
            .members
            .iter()
            .find(|d| d["name"] == member.item.name)
            .ok_or_else(|| invalid("a staged member was not inspected"))?;
        if member.inspection.inspection_id != format!("{}-{position}", rec.inspection_id)
            || disclosure["sha256"] != member.inspection.sha256
            || disclosure["optional"] != member.optional
            || disclosure["manifest"] != member.inspection.manifest
            || disclosure["trust"] != member.inspection.trust
            || disclosure["capabilities"] != member.inspection.capabilities
            || !member.item.members.is_empty()
            || member.item.kind == plur1bus_ext::manifest::Kind::Bundle
        {
            return Err(invalid(
                "the staged member metadata differs from the verified parent disclosure",
            ));
        }
        let expected = record::staging_dir(layout, &staged.name, &rec.inspection_id)
            .join("child-packages")
            .join(format!("{}.p1x", member.item.name));
        commit::validate_staged(layout, &member.inspection, &member.item, &expected)?;
    }
    let selected: Vec<_> = staged
        .members
        .iter()
        .filter(|m| names.contains(&m.item.name))
        .collect();
    if let Some(previous) = st
        .items
        .get(&staged.name)
        .filter(|old| old.id == staged.record.id && old.package_sha256 == rec.sha256)
    {
        let same = previous.members.len() == selected.len()
            && selected.iter().all(|member| {
                previous.members.iter().any(|old| {
                    old.name == member.item.name
                        && old.sha256 == member.inspection.sha256
                        && old.version == member.item.record.version
                        && old.kind == member.item.record.kind
                        && old.optional == member.optional
                }) && st.items.get(&member.item.name).is_some_and(|old| {
                    old.package_sha256 == member.inspection.sha256
                        && old.version == member.item.record.version
                        && old.kind == member.item.record.kind
                })
            });
        if same {
            let enabled = super::bundle_lifecycle::summary(layout, &cfg, previous).0;
            return Ok(
                json!({"name":staged.name,"version":previous.version,"kind":"bundle","replaced":false,"state":if enabled{"enabled"}else{"installed"}}),
            );
        }
    }
    let previous = st.items.get(&staged.name);
    let public: Vec<Value> = rec
        .members
        .iter()
        .filter(|member| names.contains(member["name"].as_str().unwrap_or("")))
        .cloned()
        .collect();
    let prior_disclosures = previous
        .and_then(|parent| super::bundle_lifecycle::member_inspections(layout, parent).ok());
    let prior_approved =
        previous
            .zip(prior_disclosures.as_ref())
            .is_some_and(|(parent, members)| {
                parent.capabilities_ack.as_deref()
                    == Some(super::bundle_lifecycle::consent_sha256(parent, members).as_str())
            });
    let unchanged_rights = prior_disclosures
        .as_ref()
        .is_some_and(|members| rights_subject(members) == rights_subject(&public));
    let prior_active = previous.is_some_and(|parent| {
        parent
            .members
            .iter()
            .any(|member| commit::enabled_now(layout, &cfg, &member.name, &member.kind))
    });
    let widened = prior_active && (!prior_approved || !unchanged_rights);
    let mut effective = opts.clone();
    if staged.record.trust == "first-party" {
        effective.enable = Some(Agents::All);
        if !widened
            && selected
                .iter()
                .all(|m| m.item.record.trust == "first-party")
            && !effective.acknowledge.iter().any(|a| a == "capabilities")
        {
            effective.acknowledge.push("capabilities".into());
        }
    }
    commit::acknowledgments(rec, &staged, previous, widened, &effective)?;
    for member in &selected {
        commit::recheck(layout, &paths, &st, &member.item, &cfg)?;
        if let Some(owner) = st.items.values().find(|parent| {
            parent.kind == "bundle"
                && parent.name != staged.name
                && parent.members.iter().any(|m| m.name == member.item.name)
        }) {
            return Err(ExtError::new(
                "E_CONFLICT",
                "bundle-member",
                format!(
                    "{} belongs to bundle {}; update that bundle instead",
                    member.item.name, owner.name
                ),
            ));
        }
        if member.item.kind == plur1bus_ext::manifest::Kind::McpServer {
            commit::check_mcp_destination(
                layout,
                &paths,
                st.items.get(&member.item.name),
                &member.item.record,
            )?;
        }
        let child_widened = st.items.get(&member.item.name).is_some_and(|old| {
            commit::enabled_now(layout, &cfg, &old.name, &old.kind)
                && old.capabilities != member.item.record.capabilities
        });
        // The union of the selected children's signer, downgrade and capability consent is mandatory.
        commit::acknowledgments(
            &member.inspection,
            &member.item,
            st.items.get(&member.item.name),
            child_widened,
            &effective,
        )
        .map_err(|error| {
            let mut data = serde_json::to_value(rec).unwrap_or(Value::Null);
            data["members"] = json!(rec
                .members
                .iter()
                .filter(|m| names.contains(m["name"].as_str().unwrap_or("")))
                .collect::<Vec<_>>());
            error.with_data(data)
        })?;
        if let Some(agents) = &effective.enable {
            let missing = if staged.record.trust == "first-party" {
                Vec::new()
            } else {
                host.missing_secrets(&member.item.name, &member.item.record.required_secrets)
            };
            super::lifecycle::enable_prechecks(
                &member.item.name,
                &member.item.record.kind,
                &missing,
                &cfg,
                agents,
            )?;
        }
    }
    let _skills = super::index::lock_skills(layout)?;
    let prior_index = super::index::read_index(layout)?;
    let selected_records: Vec<_> = selected.iter().map(|m| m.item.record.clone()).collect();
    let mut parent_record = staged.record.clone();
    parent_record.members = selected
        .iter()
        .map(|m| super::state::BundleMemberRecord {
            name: m.item.name.clone(),
            kind: m.item.record.kind.clone(),
            version: m.item.record.version.clone(),
            sha256: m.inspection.sha256.clone(),
            optional: m.optional,
        })
        .collect();
    let preservation = super::bundle_update::Preservation {
        previous_state: &st,
        previous_config: &cfg,
        previous_index: &prior_index,
        new_parent: &parent_record,
        new_children: &selected_records,
        approved: (prior_approved && unchanged_rights)
            || effective.acknowledge.iter().any(|a| a == "capabilities"),
    };
    if effective.enable.is_none() && previous.is_some() {
        super::bundle_lifecycle::precheck_preservation(layout, host, &preservation)?;
    }
    let mut records: Vec<_> = selected_records.clone();
    records.push(staged.record.clone());
    if let Some(old) = previous {
        for member in &old.members {
            if let Some(r) = st.items.get(&member.name) {
                records.push(r.clone());
            }
        }
    }
    let hashes: Vec<_> = records
        .iter()
        .map(|r| r.package_sha256.clone())
        .chain(
            records
                .iter()
                .filter_map(|r| st.items.get(&r.name).map(|old| old.package_sha256.clone())),
        )
        .collect();
    let mut held = Vec::new();
    for record in &records {
        if matches!(record.kind.as_str(), "module" | "channel") {
            host.hold_for_setup(&record.name);
        }
        if record.kind == "mcp-server" && !held.contains(&record.name) {
            match host.hold_runtime(&record.name) {
                Ok(true) => held.push(record.name.clone()),
                Ok(false) => {}
                Err(error) => {
                    for name in held.iter().rev() {
                        let _ = host.release_runtime(name);
                    }
                    return Err(error);
                }
            }
        }
    }
    let result = super::bundle_transaction::run(layout, host, &records, &hashes, |host, rb| {
        // Stop existing children before publishing any replacement. The shared undo restores flags last.
        let mut changes = Vec::new();
        let mut restore = Vec::new();
        let mut idx = super::index::read_index(layout)?;
        let old_index = commit::read_bytes(&super::index::index_path(layout));
        let mut index_changed = false;
        for record in &records {
            if record.kind == "skill" {
                index_changed |= idx.set_enabled(&record.name, false);
            } else if record.kind != "bundle" {
                let key = record::config_key(&record.name, &record.kind);
                changes.push((format!("{key}.enabled"), json!(false)));
                restore.push((
                    key,
                    record::config_section(&cfg, &record.name, &record.kind),
                ));
            }
        }
        if !changes.is_empty() {
            commit::config_change(host, "bundle.config", changes, restore, rb)?;
        }
        if index_changed {
            let path = super::index::index_path(layout);
            super::index::write_index(layout, &idx)
                .map_err(|e| record::io_err("cannot write", &path, e))?;
            rb.push("bundle.index", commit::restore_file(path, old_index));
        }
        let obsolete: Vec<_> = previous
            .into_iter()
            .flat_map(|parent| parent.members.iter())
            .filter(|member| !names.contains(&member.name))
            .filter_map(|member| st.items.get(&member.name).cloned())
            .collect();
        if !obsolete.is_empty() {
            super::bundle_lifecycle::remove_members_held(layout, host, &obsolete, rb)?;
        }
        for member in &selected {
            let current = state::read(&paths).map_err(record::state_invalid)?;
            let config = host.config();
            let previous = current.items.get(&member.item.name);
            let unchanged =
                previous.is_some_and(|old| old.package_sha256 == member.item.record.package_sha256);
            if !unchanged {
                let child_opts = InstallOpts::default();
                let context = commit::Ctx {
                    layout,
                    paths: &paths,
                    rec: &member.inspection,
                    staged: &member.item,
                    prev: previous,
                    prev_enabled: false,
                    widened: st.items.get(&member.item.name).is_some_and(|old| {
                        commit::enabled_now(layout, &cfg, &old.name, &old.kind)
                            && old.capabilities != member.item.record.capabilities
                    }),
                    prev_index: super::index::read_index(layout)?
                        .entry(&member.item.name)
                        .cloned(),
                    st: &current,
                    cfg: &config,
                    opts: &child_opts,
                };
                commit::run_steps(&context, host, rb)?;
            }
            commit::fail_at(&format!("bundle.member.{}", member.item.name))?;
        }
        let current = state::read(&paths).map_err(record::state_invalid)?;
        let config = host.config();
        let mut parent = staged.clone();
        parent.record.members = parent_record.members.clone();
        let approved = rec.clone();
        let context = commit::Ctx {
            layout,
            paths: &paths,
            rec: &approved,
            staged: &parent,
            prev: current.items.get(&parent.name),
            prev_enabled: false,
            widened: false,
            prev_index: None,
            st: &current,
            cfg: &config,
            opts: &InstallOpts::default(),
        };
        commit::run_steps(&context, host, rb)?;
        if effective.enable.is_some() {
            let toggle = super::lifecycle::ToggleOpts {
                agents: effective.enable.clone(),
                acknowledge: effective.acknowledge.clone(),
                ..Default::default()
            };
            super::bundle_lifecycle::activate_install_held(
                layout,
                host,
                &staged.name,
                &toggle,
                true,
                staged.record.trust == "first-party",
                rb,
            )?;
        }
        if effective.enable.is_none() && previous.is_some() {
            super::bundle_lifecycle::preserve_activation_held(layout, host, &preservation, rb)?;
        }
        commit::fail_at("bundle.publish")?;
        Ok(
            json!({"name":staged.name,"version":staged.record.version,"kind":"bundle","replaced":previous.is_some(),"state":if super::bundle_lifecycle::summary(layout,&host.config(),&state::read(&paths).map_err(record::state_invalid)?.items[&staged.name]).0{"enabled"}else{"installed"}}),
        )
    });
    if let Ok(value) = &result {
        let detail = json!({"id":staged.record.id,"kind":"bundle","version":staged.record.version,"sha256":staged.record.package_sha256,
            "trust":staged.record.trust,"keyId":staged.record.key_id,"acknowledged":effective.acknowledge,"replaced":previous.is_some(),"via":host.via(),
            "members":selected.iter().map(|member|json!({"name":member.item.name,"version":member.item.record.version,"sha256":member.inspection.sha256,"trust":member.item.record.trust})).collect::<Vec<_>>()});
        if let Err(error) = crate::audit::append(layout, "ext.install", &staged.name, detail) {
            record::warn(format!(
                "cannot write the bundle install audit line: {error}"
            ));
        }
        host.notify(json!({"name":staged.name,"kind":"bundle","version":staged.record.version,"state":value["state"],"overlays":[]}));
    }
    if !commit::killed() && !super::bundle_transaction::pending(layout) {
        let mut release_failed = false;
        for name in held.iter().rev() {
            release_failed |= host.release_runtime(name).is_err();
        }
        if release_failed {
            return Err(ExtError::new(
                "E_NOT_AVAILABLE",
                "runtime-unavailable",
                "the bundle transaction completed, but runtime release could not be confirmed",
            ));
        }
    }
    result
}
