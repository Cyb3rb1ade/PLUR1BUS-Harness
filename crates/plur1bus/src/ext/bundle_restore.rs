//! Restore a complete removed composition, disabled, under one journal containing every source trash beforeimage.
use super::bundle_lifecycle;
use super::commit::ModuleHost;
use super::paths::ExtPaths;
use super::record::{self, state_invalid};
use super::remove::{self, Trashed};
use super::state;
use super::ExtError;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn invalid() -> ExtError {
    ExtError::new(
        "E_NOT_AVAILABLE",
        "composition-conflict",
        "the complete selected bundle trash composition is unavailable; no member was restored",
    )
}

pub(crate) fn restore_held(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    id: &str,
    parent: Trashed,
) -> Result<Value, ExtError> {
    let paths = ExtPaths::of(layout);
    let state = state::read(&paths).map_err(state_invalid)?;
    let record = parent
        .record
        .as_ref()
        .filter(|record| {
            record.kind == "bundle"
                && record.name == parent.name
                && record.version == parent.version
        })
        .ok_or_else(invalid)?;
    let mapping = parent.body["memberTrashIds"]
        .as_object()
        .ok_or_else(invalid)?;
    if mapping.len() != record.members.len() {
        return Err(invalid());
    }
    let mut ids = BTreeSet::new();
    ids.insert(id.to_string());
    let mut entries = Vec::new();
    let days = remove::trash_days(&host.config());
    for member in &record.members {
        let child_id = mapping
            .get(&member.name)
            .and_then(Value::as_str)
            .filter(|id| remove::valid_trash_id(id))
            .ok_or_else(invalid)?;
        if !ids.insert(child_id.to_string()) {
            return Err(invalid());
        }
        let child = remove::read_entry(&paths.trash.join(child_id), child_id, days)?;
        let child_record = child.record.as_ref().ok_or_else(invalid)?;
        if child.name != member.name
            || child.kind != member.kind
            || child.version != member.version
            || child_record.name != member.name
            || child_record.kind != member.kind
            || child_record.version != member.version
            || child_record.package_sha256 != member.sha256
            || !child_record.members.is_empty()
        {
            return Err(invalid());
        }
        entries.push((child_id.to_string(), child));
    }
    entries.push((id.to_string(), parent));
    for (trash_id, entry) in &entries {
        bundle_lifecycle::check_independent_update(layout, &entry.name)?;
        remove::check_free(layout, &state, &entry.name)?;
        let trash = paths.trash.join(trash_id);
        for path in [&trash, &trash.join("code")] {
            if !std::fs::symlink_metadata(path)
                .is_ok_and(|info| info.is_dir() && !info.file_type().is_symlink())
            {
                return Err(invalid());
            }
        }
        if trash.join("data").exists() && remove::data_in_the_way(layout, &entry.name) {
            return Err(ExtError::new(
                "E_CONFLICT",
                "name-taken",
                "a selected bundle data namespace already exists; no member was restored",
            ));
        }
    }
    let _skills = super::index::lock_skills(layout)?;
    let records: Vec<_> = entries
        .iter()
        .filter_map(|(_, entry)| entry.record.clone())
        .collect();
    let trash_ids: Vec<_> = entries.iter().map(|(id, _)| id.clone()).collect();
    let result = bundle_lifecycle::with_holds(layout, host, &records, |host| {
        let committed = super::bundle_transaction::run_with_trash(
            layout,
            host,
            &records,
            &[],
            &trash_ids,
            |host, rb| {
                for (trash_id, entry) in &entries {
                    remove::restore_steps(
                        layout,
                        &paths,
                        host,
                        &paths.trash.join(trash_id),
                        entry,
                        rb,
                    )?;
                    super::commit::fail_at(&format!("bundle.restore.{}", entry.name))?;
                }
                // The durable group journal owns recovery until commit. Markers must not trigger independent child recovery.
                for trash_id in &trash_ids {
                    let marker = paths.trash.join(trash_id).join(remove::RESTORING);
                    state::remove_retrying(&marker).map_err(|error| {
                        record::io_err("cannot clear restore marker", &marker, error)
                    })?;
                }
                let parent = entries.last().ok_or_else(invalid)?;
                Ok(json!({"name":parent.1.name,"version":parent.1.version,"state":"installed"}))
            },
        )?;
        let parent = entries.last().ok_or_else(invalid)?;
        remove::audit(
            layout,
            "ext.restore",
            &parent.1.name,
            json!({"kind":"bundle","trashId":id,"members":parent.1.record.as_ref().map(|record|&record.members),"via":host.via()}),
        );
        host.notify(json!({"name":parent.1.name,"kind":"bundle","state":"installed","version":parent.1.version,"overlays":[]}));
        Ok(committed)
    })?;
    for trash_id in trash_ids {
        // A spent entry with no code is safe if a platform handle delays its cleanup; it can never be restored twice.
        let _ = state::remove_dir_all_retrying(&paths.trash.join(trash_id));
    }
    Ok(result)
}
