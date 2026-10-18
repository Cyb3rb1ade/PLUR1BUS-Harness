//! HM4 profile transaction. Snapshot installed code/config only; the live state/store is never copied or renamed.
use super::{manifest, setup};
use crate::paths::Layout;
use crate::update::Host;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

const ITEMS: [&str; 5] = [
    "config.json",
    "manifest.json",
    "runtime",
    "modules",
    "skills",
];

pub fn requested(layout: &Layout, profile: Option<&str>) -> Result<bool, String> {
    let previous = manifest::read(layout).map_err(|e| e.to_string())?;
    Ok(profile == Some("full") && previous.as_ref().is_some_and(|m| m.profile() == "host"))
}

pub fn plan(layout: &Layout, profile: Option<&str>) -> Result<Value, String> {
    let upgrade = requested(layout, profile)?;
    let previous = manifest::read(layout).map_err(|e| e.to_string())?;
    setup::effective_profile(profile, previous.as_ref()).map_err(|e| e.message)?;
    Ok(
        json!({ "schema": "setup.plan/1", "dryRun": true, "upgrade": upgrade, "from": previous.as_ref().map(|m| m.profile()), "to": profile.unwrap_or_else(|| previous.as_ref().map(|m| m.profile()).unwrap_or("full")), "home": layout.home,
      "store": { "action": "reuse-in-place", "copied": false }, "snapshot": ITEMS,
      "steps": if upgrade { vec!["snapshot", "stop", "setup-full", "health-check", "commit-or-rollback"] } else { setup::STEP_IDS.to_vec() },
      "hermes": "Requires a pre-approved scoped token for every existing Hermes binding; no core token fallback after full-profile upgrade" }),
    )
}

fn hermes_bindings(layout: &Layout) -> Result<Vec<(String, std::path::PathBuf)>, String> {
    let raw = match fs::read(layout.home.join("hosts/hermes-bindings.json")) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let registry: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    if registry["schema"] != "plur1bus.hermes-bindings/1" {
        return Err("invalid Hermes bindings registry schema".into());
    }
    registry["bindings"]
        .as_object()
        .ok_or("invalid Hermes bindings registry")?
        .iter()
        .map(|(agent, home)| {
            let home = Path::new(home.as_str().ok_or("invalid Hermes home")?);
            if !home.is_absolute() {
                return Err("Hermes home must be absolute".into());
            }
            Ok((agent.clone(), home.join("plur1bus-client.token")))
        })
        .collect()
}
fn verify_hermes_clients(layout: &Layout) -> Result<(), String> {
    for (agent_id, path) in hermes_bindings(layout)? {
        let token = fs::read_to_string(path).map_err(|_| "Hermes client credential unavailable")?;
        let platform = if cfg!(windows) { "windows" } else { "posix" };
        let address = layout
            .endpoints(&crate::supervisor::Role::core(), platform)
            .address;
        let mut client = crate::commands::connect_recorded(
            layout,
            &address,
            token.trim(),
            plur1bus_rpc::ConnectOptions::default(),
        )
        .map_err(|_| "upgraded core refused a Hermes client credential")?;
        client
            .call("agent.status", json!({ "agentId": agent_id }))
            .map_err(|_| "upgraded Hermes binding is not authorized for its agent")?;
    }
    Ok(())
}

fn copy(from: &Path, to: &Path) -> Result<(), String> {
    if from.is_dir() {
        setup::copy_tree(from, to).map_err(|e| e.message)
    } else {
        fs::copy(from, to).map(|_| ()).map_err(|e| e.to_string())
    }
}
fn remove(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
    .map_err(|e| e.to_string())
}
fn hashes(dir: &Path, base: &Path, rows: &mut Vec<(String, String)>) -> Result<(), String> {
    for item in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let p = item.map_err(|e| e.to_string())?.path();
        if p.is_symlink() {
            return Err("profile snapshot refuses symlinked runtime/module/skill files".into());
        }
        if p.is_dir() {
            hashes(&p, base, rows)?;
        } else {
            rows.push((
                p.strip_prefix(base)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .into_owned(),
                super::archive::sha256_file(&p).map_err(|e| e.to_string())?,
            ));
        }
    }
    rows.sort();
    Ok(())
}

pub fn child_authorized(layout: &Layout) -> bool {
    let Ok(parent) = std::env::var("PLUR1BUS_HM4_PARENT") else {
        return false;
    };
    let Ok(pid) = parent.parse::<u32>() else {
        return false;
    };
    let saved = fs::read_to_string(layout.home.join(".profile-upgrade/owner"));
    saved.is_ok_and(|p| p.trim() == parent)
        && pid != std::process::id()
        && crate::proc::pid_alive(pid)
}

/// Rollback on any returned failure, including a child setup that exits instead of returning an error.
/// The caller holds the transaction directory lease for the entire child process.
pub fn transaction(
    layout: &Layout,
    host: &dyn Host,
    binary: &Path,
    apply: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let dir = layout.home.join(".profile-upgrade");
    // The transaction is exclusive. A killed parent leaves its snapshot for explicit recovery, never overwritten.
    fs::create_dir(&dir).map_err(|e| {
        format!("profile transaction unavailable (preserve any pending snapshot): {e}")
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let snap = dir.join("snapshot");
    fs::create_dir(&snap).map_err(|e| e.to_string())?;
    let prepared = (|| {
        for (_, token) in hermes_bindings(layout)? {
            if token.is_symlink() || !token.is_file() {
                return Err(
                    "approve a separate token for each Hermes binding before upgrade".into(),
                );
            }
        }
        // Refuse a customized store placed in an install-code directory rather than risk copying it.
        let config_bytes = match fs::read(layout.config_path()) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => b"{}".to_vec(),
            Err(e) => return Err(e.to_string()),
        };
        let cfg: Value = serde_json::from_slice(&config_bytes).map_err(|e| e.to_string())?;
        for key in ["baseDbPath", "baseDbPathOverride"] {
            if let Some(store) = cfg["engine"][key].as_str() {
                let store = fs::canonicalize(store)
                    .map_err(|_| "custom store path cannot be resolved; refuse snapshot")?;
                let root = fs::canonicalize(&layout.home).map_err(|e| e.to_string())?;
                if !store.is_absolute()
                    || ["runtime", "modules", "skills"]
                        .iter()
                        .any(|name| store.starts_with(root.join(name)))
                {
                    return Err("custom store overlaps installed code or is relative; refuse profile snapshot".into());
                }
            }
        }
        for name in ITEMS {
            let from = layout.home.join(name);
            if from.exists() {
                if from.is_symlink() {
                    return Err("snapshot refuses symlinked install paths".into());
                }
                if from.is_dir() {
                    hashes(&from, &from, &mut Vec::new())?;
                }
                copy(&from, &snap.join(name))?;
            }
        }
        let mut checks = Vec::new();
        hashes(&snap, &snap, &mut checks)?;
        fs::write(
            dir.join("checksums.json"),
            serde_json::to_vec(&checks).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::write(dir.join("owner"), std::process::id().to_string()).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })();
    if let Err(e) = prepared {
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    let was_running = match host.stop(layout) {
        Ok(r) => r,
        Err(e) => {
            let _ = fs::remove_dir_all(&dir);
            return Err(e);
        }
    };
    fs::write(
        dir.join("was-running"),
        if was_running { "true" } else { "false" },
    )
    .map_err(|e| e.to_string())?;
    let result = apply()
        .and_then(|()| host.gate(layout, binary, env!("CARGO_PKG_VERSION")))
        .and_then(|()| verify_hermes_clients(layout));
    if let Err(e) = result {
        // Never replace code while a failed upgraded daemon might still own it.
        host.stop(layout).map_err(|stop| {
            format!("upgrade failed: {e}; rollback stop failed: {stop}; snapshot preserved")
        })?;
        restore(layout)?;
        if was_running {
            host.start(layout, binary).map_err(|start| {
                format!("rolled back files; old daemon restart failed: {start}")
            })?;
        }
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        return Err(format!("upgrade failed and rolled back: {e}"));
    }
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn restore(layout: &Layout) -> Result<(), String> {
    let dir = layout.home.join(".profile-upgrade");
    let snap = dir.join("snapshot");
    let wanted: Vec<(String, String)> =
        serde_json::from_slice(&fs::read(dir.join("checksums.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let mut actual = Vec::new();
    hashes(&snap, &snap, &mut actual)?;
    if wanted != actual {
        return Err("profile snapshot checksum mismatch; leave files and snapshot intact".into());
    }
    for name in ITEMS {
        let dest = layout.home.join(name);
        remove(&dest)?;
        if snap.join(name).exists() {
            copy(&snap.join(name), &dest)?;
        }
    }
    Ok(())
}

/// Explicit recovery after an interrupted parent; snapshots are never silently discarded.
pub fn recover(layout: &Layout, host: &dyn Host, binary: &Path) -> Result<(), String> {
    let dir = layout.home.join(".profile-upgrade");
    let pid = fs::read_to_string(dir.join("owner"))
        .map_err(|e| e.to_string())?
        .trim()
        .parse::<u32>()
        .map_err(|e| e.to_string())?;
    if crate::proc::pid_alive(pid) {
        return Err("profile transaction owner is still alive".into());
    }
    let was_running =
        fs::read_to_string(dir.join("was-running")).map_err(|e| e.to_string())? == "true";
    host.stop(layout)?;
    restore(layout)?;
    if was_running {
        host.start(layout, binary)?;
    }
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    struct Fake {
        running: Cell<bool>,
        starts: Cell<u32>,
    }
    impl Host for Fake {
        fn stop(&self, _: &Layout) -> Result<bool, String> {
            Ok(self.running.replace(false))
        }
        fn start(&self, _: &Layout, _: &Path) -> Result<(), String> {
            self.running.set(true);
            self.starts.set(self.starts.get() + 1);
            Ok(())
        }
        fn gate(&self, _: &Layout, _: &Path, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn alive(&self, _: u32) -> bool {
            true
        }
    }
    #[test]
    fn injected_failure_restores_profile_runtime_and_same_store_inode() {
        let tmp = tempfile::tempdir().unwrap();
        let l = Layout::new(tmp.path().into());
        fs::write(l.config_path(), "{}").unwrap();
        fs::write(l.install_manifest(), "host manifest").unwrap();
        fs::create_dir_all(l.runtime()).unwrap();
        fs::write(l.runtime().join("core.js"), "old core").unwrap();
        fs::create_dir_all(tmp.path().join("state/lancedb")).unwrap();
        let store = tmp.path().join("state/lancedb/row");
        fs::write(&store, "memory bytes").unwrap();
        #[cfg(unix)]
        let inode = {
            use std::os::unix::fs::MetadataExt;
            fs::metadata(&store).unwrap().ino()
        };
        let host = Fake {
            running: Cell::new(true),
            starts: Cell::new(0),
        };
        let err = transaction(&l, &host, Path::new("binary"), || {
            fs::write(l.config_path(), "changed").unwrap();
            fs::write(l.runtime().join("core.js"), "new core").unwrap();
            Err("injected".into())
        })
        .unwrap_err();
        assert!(err.contains("rolled back"));
        assert_eq!(fs::read_to_string(l.config_path()).unwrap(), "{}");
        assert_eq!(
            fs::read_to_string(l.runtime().join("core.js")).unwrap(),
            "old core"
        );
        assert_eq!(fs::read_to_string(&store).unwrap(), "memory bytes");
        assert!(host.running.get());
        assert_eq!(host.starts.get(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(inode, fs::metadata(&store).unwrap().ino());
        }
        assert!(!tmp.path().join(".profile-upgrade").exists());
    }
    #[test]
    fn existing_pending_snapshot_is_never_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        let l = Layout::new(tmp.path().into());
        fs::create_dir(tmp.path().join(".profile-upgrade")).unwrap();
        let host = Fake {
            running: Cell::new(true),
            starts: Cell::new(0),
        };
        assert!(transaction(&l, &host, Path::new("binary"), || panic!("must refuse")).is_err());
        assert!(host.running.get());
    }
}
