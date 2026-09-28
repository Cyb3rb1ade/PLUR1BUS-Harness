//! `1staid check`'s installer-aware checks (2a-H3b-b Task 6, HB15): `runtime.node`, `runtime.core` and
//! `models.cache`. Kept out of `firstaid.rs` itself so that file only gains the three ids and three call lines
//! (fewer merge conflicts with the parallel installer tasks, HB15).
//!
//! A home with no install manifest — every `PLUR1BUS_NODE`/`PLUR1BUS_CORE_JS` dev setup, and every existing test —
//! always `skip`s `runtime.node` and `runtime.core`: nothing was installed by `setup`, so there is nothing to check
//! it against. `models.cache` has no such gate: the model cache is meaningful whether or not `setup` ever ran.
use crate::commands::core::locate_node;
use crate::commands::firstaid::{Check, Status};
use crate::install::archive::sha256_file;
use crate::install::manifest::InstallManifest;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::path::Path;

/// Parity with `packages/core/src/engine-config.ts`'s `E5_SMALL`/`BGE_RERANKER` (`model_ids_match_engine_config_ts`
/// reads that file and checks both strings appear).
pub const MODEL_IDS: [&str; 2] = [
    "intfloat/multilingual-e5-small",
    "woxpas-ai/bge-reranker-v2-m3-onnx",
];

/// Every fail this file reports points at the same remedy: `setup` puts the unit back.
const REPAIR_HINT: &str = "plur1bus 1staid repair";

fn ok(id: &'static str, summary: impl Into<String>) -> Check {
    Check {
        id,
        status: Status::Ok,
        summary: summary.into(),
        detail: None,
        hint: None,
    }
}
fn warn(
    id: &'static str,
    summary: impl Into<String>,
    detail: Option<Value>,
    hint: Option<String>,
) -> Check {
    Check {
        id,
        status: Status::Warn,
        summary: summary.into(),
        detail,
        hint,
    }
}
fn fail(
    id: &'static str,
    summary: impl Into<String>,
    detail: Option<Value>,
    hint: Option<String>,
) -> Check {
    Check {
        id,
        status: Status::Fail,
        summary: summary.into(),
        detail,
        hint,
    }
}
fn skip(id: &'static str, summary: impl Into<String>) -> Check {
    Check {
        id,
        status: Status::Skip,
        summary: summary.into(),
        detail: None,
        hint: None,
    }
}

/// `runtime/node-<v>/bin/node`, matching [`crate::commands::core::locate_node`]'s own layout convention.
fn node_binary_path(layout: &Layout, version: &str) -> std::path::PathBuf {
    layout
        .runtime()
        .join(format!("node-{version}"))
        .join("bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" })
}

/// `runtime.node` (HB15): no manifest → `skip` (nothing to check: not installed by `setup`). The pinned binary
/// missing, or its SHA-256 no longer matching `node.binarySha256` (a hand edit, a partial install, bit rot) → `fail`,
/// both pointing at `1staid repair`. Otherwise `ok`.
pub(crate) fn check_runtime_node(layout: &Layout, m: Option<&InstallManifest>) -> Check {
    const ID: &str = "runtime.node";
    let Some(m) = m else {
        return skip(
            ID,
            format!(
                "not installed by setup (using {})",
                locate_node(layout).display()
            ),
        );
    };
    let path = node_binary_path(layout, &m.node.version);
    if !path.exists() {
        return fail(
            ID,
            format!("runtime/node-{} is missing", m.node.version),
            Some(json!({ "path": path })),
            Some(REPAIR_HINT.to_string()),
        );
    }
    match sha256_file(&path) {
        Ok(actual) if actual.eq_ignore_ascii_case(&m.node.binary_sha256) => ok(
            ID,
            format!("runtime/node-{} matches its install hash", m.node.version),
        ),
        Ok(actual) => fail(
            ID,
            format!(
                "runtime/node-{} does not match its install hash",
                m.node.version
            ),
            Some(json!({ "expected": m.node.binary_sha256, "actual": actual })),
            Some(REPAIR_HINT.to_string()),
        ),
        Err(e) => fail(
            ID,
            format!("cannot hash runtime/node-{}: {e}", m.node.version),
            None,
            Some(REPAIR_HINT.to_string()),
        ),
    }
}

/// `runtime/core/package.json`'s `"version"` field, or `None` when the file is missing, unreadable or has no string
/// `version`.
fn installed_core_version(core_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(core_dir.join("package.json")).ok()?;
    let doc: Value = serde_json::from_str(&text).ok()?;
    doc["version"].as_str().map(str::to_string)
}

/// `runtime.core` (HB15): no manifest → `skip`. `runtime/core/core.js` missing, or `runtime/core/package.json`'s
/// version not matching the manifest's `core.version` → `fail`. A running core (`core.status`) whose `contract` or
/// `rpc` differ from the manifest's → `warn` (it still answers; a re-`setup`/`repair` should still true it back up).
/// Otherwise `ok`.
pub(crate) fn check_runtime_core(
    layout: &Layout,
    m: Option<&InstallManifest>,
    core_status: Option<&Value>,
) -> Check {
    const ID: &str = "runtime.core";
    let Some(m) = m else {
        return skip(ID, "not installed by setup");
    };
    let core_dir = layout.runtime().join("core");
    if !core_dir.join("core.js").exists() {
        return fail(
            ID,
            "runtime/core/core.js is missing",
            None,
            Some(REPAIR_HINT.to_string()),
        );
    }
    match installed_core_version(&core_dir) {
        Some(v) if v == m.core.version => {}
        installed => {
            return fail(
                ID,
                format!(
                    "runtime/core/package.json is version {}, expected {}",
                    installed.as_deref().unwrap_or("unknown"),
                    m.core.version
                ),
                Some(json!({ "installed": installed, "expected": m.core.version })),
                Some(REPAIR_HINT.to_string()),
            );
        }
    }
    if let Some(status) = core_status {
        let contract = status["contract"].as_str().unwrap_or_default();
        let rpc = status["rpc"].as_str().unwrap_or_default();
        if contract != m.core.contract || rpc != m.core.rpc {
            return warn(
                ID,
                format!(
                    "the running core reports contract {contract}/rpc {rpc}, the manifest expects {}/{}",
                    m.core.contract, m.core.rpc
                ),
                Some(json!({
                    "running": { "contract": contract, "rpc": rpc },
                    "manifest": { "contract": m.core.contract, "rpc": m.core.rpc },
                })),
                None,
            );
        }
    }
    ok(ID, format!("runtime/core is version {}", m.core.version))
}

/// Whether `dir` (or any of its subdirectories) holds at least one `*.onnx` file.
fn has_onnx_file(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if has_onnx_file(&path) {
                return true;
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some("onnx") {
            return true;
        }
    }
    false
}

/// `models.cache` (HB15): a live engine reporting a model load failure (`core.status.engine.models.<embedder|
/// reranker>.error`) is authoritative and `fail`s with its text, whatever is on disk. Otherwise, for each of
/// [`MODEL_IDS`], `models/<id>/` holding at least one `*.onnx` file → `ok`; a missing one → `warn` ("downloads at
/// first warm-up", `detail.missing`) — the cache fills itself in at first use, so this is never a `fail`.
pub(crate) fn check_models_cache(layout: &Layout, core_status: Option<&Value>) -> Check {
    const ID: &str = "models.cache";
    if let Some(status) = core_status {
        for capability in ["embedder", "reranker"] {
            let model = &status["engine"]["models"][capability];
            if model["state"] == json!("failed") {
                let error = model["error"].as_str().unwrap_or("unknown").to_string();
                return fail(
                    ID,
                    format!("the {capability} failed to load: {error}"),
                    Some(json!({ "capability": capability, "error": error })),
                    Some(
                        "see logs/core.log; check the model download or the provider credentials"
                            .to_string(),
                    ),
                );
            }
        }
    }
    let missing: Vec<&str> = MODEL_IDS
        .iter()
        .copied()
        .filter(|id| !has_onnx_file(&layout.models().join(id)))
        .collect();
    if missing.is_empty() {
        ok(ID, "model cache is warm")
    } else {
        warn(
            ID,
            "downloads at first warm-up",
            Some(json!({ "missing": missing })),
            None,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::manifest::{CoreUnit, NodeUnit, Unit};

    fn manifest() -> InstallManifest {
        let h = "b".repeat(64);
        InstallManifest {
            schema_version: 1,
            installed_at: 1_790_000_000_000,
            updated_at: 1_790_000_000_001,
            channel: "stable".into(),
            target: "linux-x64".into(),
            binary: Unit {
                version: "0.1.0".into(),
                sha256: None,
            },
            node: NodeUnit {
                version: "24.21.0".into(),
                archive_sha256: h.clone(),
                binary_sha256: h,
                path: "runtime/node-24.21.0/bin/node".into(),
            },
            core: CoreUnit {
                version: "0.1.0".into(),
                contract: "1.9.0".into(),
                rpc: "1.3.0".into(),
                sha256: None,
                source: "release".into(),
            },
            modules: vec![],
            skills: vec![],
        }
    }

    fn write_node_binary(layout: &Layout, version: &str, bytes: &[u8]) {
        let path = node_binary_path(layout, version);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
    }

    #[test]
    fn runtime_node_skips_without_a_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let c = check_runtime_node(&layout, None);
        assert_eq!(c.status, Status::Skip, "{c:?}");
        assert!(c.summary.contains("not installed by setup"), "{c:?}");
    }

    #[test]
    fn runtime_node_fails_when_the_binary_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let m = manifest();
        let c = check_runtime_node(&layout, Some(&m));
        assert_eq!(c.status, Status::Fail, "{c:?}");
        assert!(c.summary.contains("is missing"), "{c:?}");
        assert_eq!(c.hint.as_deref(), Some("plur1bus 1staid repair"));
    }

    #[test]
    fn runtime_node_fails_on_a_hash_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let m = manifest();
        write_node_binary(&layout, &m.node.version, b"not the pinned bytes");
        let c = check_runtime_node(&layout, Some(&m));
        assert_eq!(c.status, Status::Fail, "{c:?}");
        assert!(
            c.summary.contains("does not match its install hash"),
            "{c:?}"
        );
    }

    #[test]
    fn runtime_node_ok_when_the_hash_matches() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let mut m = manifest();
        write_node_binary(&layout, &m.node.version, b"pinned node bytes");
        m.node.binary_sha256 = sha256_file(&node_binary_path(&layout, &m.node.version)).unwrap();
        let c = check_runtime_node(&layout, Some(&m));
        assert_eq!(c.status, Status::Ok, "{c:?}");
    }

    fn write_core(layout: &Layout, version: &str) {
        let dir = layout.runtime().join("core");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("core.js"), "export {};\n").unwrap();
        std::fs::write(
            dir.join("package.json"),
            format!(r#"{{"version":"{version}"}}"#),
        )
        .unwrap();
    }

    #[test]
    fn runtime_core_skips_without_a_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        assert_eq!(check_runtime_core(&layout, None, None).status, Status::Skip);
    }

    #[test]
    fn runtime_core_fails_without_core_js() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let m = manifest();
        let c = check_runtime_core(&layout, Some(&m), None);
        assert_eq!(c.status, Status::Fail, "{c:?}");
        assert!(c.summary.contains("core.js is missing"), "{c:?}");
    }

    #[test]
    fn runtime_core_fails_on_a_version_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let m = manifest();
        write_core(&layout, "0.0.9");
        let c = check_runtime_core(&layout, Some(&m), None);
        assert_eq!(c.status, Status::Fail, "{c:?}");
    }

    #[test]
    fn runtime_core_warns_on_a_contract_drift() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let m = manifest();
        write_core(&layout, &m.core.version);
        let running = json!({ "contract": "1.8.0", "rpc": "1.3.0" });
        let c = check_runtime_core(&layout, Some(&m), Some(&running));
        assert_eq!(c.status, Status::Warn, "{c:?}");
        assert!(c.summary.contains("1.8.0"), "{c:?}");
    }

    #[test]
    fn runtime_core_ok_when_installed_and_matching() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let m = manifest();
        write_core(&layout, &m.core.version);
        let running = json!({ "contract": m.core.contract, "rpc": m.core.rpc });
        let c = check_runtime_core(&layout, Some(&m), Some(&running));
        assert_eq!(c.status, Status::Ok, "{c:?}");
        // Also ok with no supervisor to ask.
        assert_eq!(
            check_runtime_core(&layout, Some(&m), None).status,
            Status::Ok
        );
    }

    #[test]
    fn models_cache_warns_with_the_missing_models() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let c = check_models_cache(&layout, None);
        assert_eq!(c.status, Status::Warn, "{c:?}");
        let missing = c.detail.unwrap()["missing"].clone();
        assert_eq!(missing, json!(MODEL_IDS));
    }

    #[test]
    fn models_cache_ok_when_every_model_has_an_onnx_file() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        for id in MODEL_IDS {
            let model_dir = layout.models().join(id);
            std::fs::create_dir_all(&model_dir).unwrap();
            std::fs::write(model_dir.join("model.onnx"), b"onnx").unwrap();
        }
        let c = check_models_cache(&layout, None);
        assert_eq!(c.status, Status::Ok, "{c:?}");
    }

    #[test]
    fn models_cache_fails_when_the_engine_reports_a_load_error() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let status = json!({
            "engine": {
                "models": {
                    "embedder": { "state": "failed", "warming": false, "checkedAt": 1, "id": "e5", "error": "boom" },
                    "reranker": { "state": "ready", "warming": false, "checkedAt": 1, "id": "bge" },
                }
            }
        });
        let c = check_models_cache(&layout, Some(&status));
        assert_eq!(c.status, Status::Fail, "{c:?}");
        assert!(c.summary.contains("boom"), "{c:?}");
    }

    /// `model_ids_match_engine_config_ts`: [`MODEL_IDS`] must be the exact strings `packages/core/src/
    /// engine-config.ts` hardcodes, so `models.cache` never drifts from what the core actually caches under.
    #[test]
    fn model_ids_match_engine_config_ts() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/src/engine-config.ts");
        let text =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        for id in MODEL_IDS {
            assert!(text.contains(id), "{id} not found in {}", path.display());
        }
    }
}
