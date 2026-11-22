//! Binding a coding session to a verified Git root.
use crate::collab::repo::RepoGit;
use crate::collab::{CollabError, CollabErrorCode as C};
use crate::policy::fs_paths::{
    canonicalise_path, normalise_native, stat_verified, CanonicalPath, CanonicaliseOptions,
    FileKind, PathFs, PathRoot,
};
use crate::policy::paths::{
    contains_exact, fold_for_deny, grant_reaches_system_tree, IcuNfc, TreeOptions,
};
use serde_json::json;
use serde_json::Value;
use std::path::Path;

type R<T> = Result<T, CollabError>;

/// The installation's authorized root probe.
pub struct RootProbe<'a, F: PathFs> {
    /// Native path and identity operations.
    pub fs: &'a F,
    /// Read-only repository identity.
    pub git: &'a dyn RepoGit,
    /// Canonical core home which a checkout may not reach.
    pub core_home: &'a str,
    /// Configured authority roots for this agent.
    pub roots: &'a [PathRoot],
    /// Host and configured deny list, written in policy's JSON shape.
    pub deny: &'a Value,
}

fn invalid(msg: &str) -> CollabError {
    CollabError::new(C::Invalid, msg)
}

fn protect(msg: &str, reason: &str) -> CollabError {
    CollabError::with_reason(C::Unauthorized, msg, reason)
}

pub(super) fn git_line(text: &str) -> &str {
    text.strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(text)
}

fn real<F: PathFs>(fs: &F, path: &str) -> R<String> {
    fs.realpath(path)
        .map(|p| normalise_native(p, fs.platform() == "win32"))
        .map_err(|_| protect("coding root is protected or invalid", "realpath"))
}

fn inside(parent: &str, child: &str, windows: bool) -> bool {
    if !windows {
        return contains_exact(parent, child, "/");
    }
    match (
        fold_for_deny(parent, &IcuNfc),
        fold_for_deny(child, &IcuNfc),
    ) {
        (Some(parent), Some(child)) => contains_exact(&parent, &child, "\\"),
        _ => true,
    }
}

/// Revalidate the candidate root with D109 before Git may inspect it.
pub fn coding_root<F: PathFs>(raw: &str, probe: &RootProbe<'_, F>) -> R<CanonicalPath> {
    if !Path::new(raw).is_absolute() {
        return Err(invalid("coding requires an absolute Git worktree root"));
    }
    let windows = probe.fs.platform() == "win32";
    let sep = if windows { "\\" } else { "/" };
    let private = real(probe.fs, probe.core_home)?;
    let mut deny = probe
        .deny
        .as_array()
        .cloned()
        .ok_or_else(|| protect("coding root is protected or invalid", "deny-listed"))?;
    deny.extend(["run", "state", "config.json", "bin", "runtime", "secrets"].into_iter().map(|name| {
        json!({ "path": format!("{}{sep}{name}", private.trim_end_matches(['/', '\\'])) })
    }));
    let deny = Value::Array(deny);
    let mut options = CanonicaliseOptions::new(probe.roots);
    options.require_root = false;
    options.deny = Some(&deny);
    let path = canonicalise_path(probe.fs, raw, &options, &IcuNfc)
        .map_err(|e| protect("coding root is protected or invalid", e.reason))?;
    let homes = [probe.fs.home_dir()];
    if path.system_tree()
        || grant_reaches_system_tree(
            path.canonical(),
            true,
            TreeOptions {
                windows,
                homes: &homes,
            },
            &IcuNfc,
        )
    {
        return Err(protect(
            "home, drive and system roots cannot be coding roots",
            "protected-root",
        ));
    }
    if inside(path.canonical(), &private, windows) {
        return Err(protect(
            "coding root cannot contain the protected core home",
            "protected-root",
        ));
    }
    if !path.exists() || !stat_verified(probe.fs, &path).is_ok_and(|m| m.kind == FileKind::Dir) {
        return Err(invalid("coding requires an existing Git worktree root"));
    }
    let top = probe
        .git
        .read(path.canonical(), &["rev-parse", "--show-toplevel"])
        .map_err(|_| invalid("coding requires the Git worktree root"))?;
    if real(probe.fs, git_line(&top))? != path.canonical() {
        return Err(invalid("coding requires the Git worktree root"));
    }
    Ok(path)
}

#[cfg(test)]
#[path = "root_vectors.rs"]
mod vectors;
