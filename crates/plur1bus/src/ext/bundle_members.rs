//! Authenticated selected-member disclosures and derived bundle status; never reads package archives.
use super::commit;
use super::index;
use super::overlays::{self, Overlay};
use super::paths::ExtPaths;
use super::record::state_invalid;
use super::state::{self, ItemRecord};
use super::ExtError;
use crate::paths::Layout;
use serde_json::{json, Value};

pub(crate) fn mismatch() -> ExtError {
    ExtError::new(
        "E_CONFLICT",
        "composition-conflict",
        "the installed bundle member no longer matches its approved composition",
    )
}
/// Stable consent binds the selected set and all disclosed child rights, never dynamic enable/scope flags.
pub(crate) fn consent_sha256(parent: &ItemRecord, members: &[Value]) -> String {
    let selected: Vec<Value> = members.iter().map(|member| json!({
        "name":member["name"],"kind":member["kind"],"version":member["version"],"sha256":member["sha256"],
        "optional":member["optional"],"trust":member["trust"],"capabilities":member["capabilities"],
        "scripts":member["scripts"],"requires":member["requires"]
    })).collect();
    commit::capabilities_hash(&json!({"sha256":parent.package_sha256,"members":selected}))
}

pub(crate) fn metadata(paths: &ExtPaths, sha: &str) -> Result<Value, ExtError> {
    let path = paths.cached_meta(sha);
    let info = std::fs::symlink_metadata(&path).map_err(|_| mismatch())?;
    if !info.is_file() || info.file_type().is_symlink() || info.len() > 8 * 1024 * 1024 {
        return Err(mismatch());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let handle = options.open(&path).map_err(|_| mismatch())?;
    if !handle.metadata().map_err(|_| mismatch())?.is_file() {
        return Err(mismatch());
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    handle
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| mismatch())?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(mismatch());
    }
    serde_json::from_slice(&bytes).map_err(|_| mismatch())
}

/// Full disclosures are returned only when every selected summary still binds the current child record and rights.
pub(crate) fn member_inspections(
    layout: &Layout,
    parent: &ItemRecord,
) -> Result<Vec<Value>, ExtError> {
    let paths = ExtPaths::of(layout);
    let state = state::read(&paths).map_err(state_invalid)?;
    let meta = metadata(&paths, &parent.package_sha256)?;
    let members = meta["members"].as_array().ok_or_else(mismatch)?;
    let mut result = Vec::new();
    for summary in &parent.members {
        let child = state.items.get(&summary.name).ok_or_else(mismatch)?;
        let matching: Vec<_> = members
            .iter()
            .filter(|member| member["name"] == summary.name)
            .collect();
        if matching.len() != 1 {
            return Err(mismatch());
        }
        let disclosure = matching[0];
        let child_meta = metadata(&paths, &child.package_sha256)?;
        if child.removed_by_user
            || child.kind != summary.kind
            || child.version != summary.version
            || child.package_sha256 != summary.sha256
            || !child.members.is_empty()
            || disclosure["kind"] != summary.kind
            || disclosure["version"] != summary.version
            || disclosure["sha256"] != summary.sha256
            || disclosure["optional"] != summary.optional
            || disclosure["capabilities"] != child.capabilities
            || disclosure["trust"]["tier"] != child.trust
            || disclosure["trust"]["keyId"].as_str() != child.key_id.as_deref()
            || disclosure["trust"]["label"].as_str() != child.key_label.as_deref()
            || disclosure["manifest"] != child_meta["manifest"]
            || disclosure["scripts"] != child_meta["scripts"]
            || disclosure["manifest"]["name"] != child.name
            || disclosure["manifest"]["id"] != child.id
            || disclosure["manifest"]["version"] != child.version
            || disclosure["manifest"]["kind"] != child.kind
            || disclosure["requires"] != child_meta["manifest"]["requires"]
        {
            return Err(mismatch());
        }
        result.push(disclosure.clone());
    }
    Ok(result)
}

/// Runtime-independent summary for list/show. A missing or changed child keeps the wrapper visibly held.
pub(crate) fn summary(
    layout: &Layout,
    cfg: &Value,
    parent: &ItemRecord,
) -> (bool, bool, Vec<Overlay>) {
    let Ok(state) = state::read(&ExtPaths::of(layout)) else {
        return (false, false, vec![Overlay::Tampered]);
    };
    let idx = index::read_index(layout).ok();
    let mut count = 0;
    let mut coverage = Vec::new();
    let mut found = Vec::new();
    let revs = overlays::load_revocations(&ExtPaths::of(layout));
    let host = super::host::host_facts();
    let mut presence = super::runtime::OperationPresence::default();
    if member_inspections(layout, parent).is_err() {
        found.push(Overlay::Tampered);
    }
    for member in &parent.members {
        let Some(child) = state.items.get(&member.name).filter(|child| {
            child.package_sha256 == member.sha256
                && child.kind == member.kind
                && child.version == member.version
        }) else {
            if !found.contains(&Overlay::Tampered) {
                found.push(Overlay::Tampered);
            }
            continue;
        };
        if commit::enabled_in(layout, idx.as_ref(), cfg, &child.name, &child.kind) {
            count += 1;
            let agents = super::list::agents_of(cfg, &child.name, &child.kind, true);
            let mut selected: Vec<String> = if agents == "all" {
                cfg["agents"]
                    .as_object()
                    .map(|agents| agents.keys().cloned().collect())
                    .unwrap_or_else(|| vec!["*".into()])
            } else {
                agents
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|agent| agent.as_str().map(str::to_owned))
                    .collect()
            };
            selected.sort();
            selected.dedup();
            coverage.push(selected);
        }
        let mut fresh = child.clone();
        fresh.integrity = Some(overlays::rehash(layout, child));
        let compat = super::list::cached_meta(&ExtPaths::of(layout), &child.package_sha256)
            .and_then(|meta| meta["manifest"].get("compat").cloned());
        let missing = presence.missing(layout, &child.name, &child.required_secrets);
        for overlay in
            overlays::overlays_with_missing(&fresh, &host, &revs, compat.as_ref(), &missing)
        {
            if !found.contains(&overlay) {
                found.push(overlay);
            }
        }
    }
    (
        count == parent.members.len() && count > 0,
        count > 0
            && (count < parent.members.len() || coverage.windows(2).any(|pair| pair[0] != pair[1])),
        found,
    )
}
