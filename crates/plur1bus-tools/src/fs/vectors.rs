//! Replay of `fixtures/parity/tools/fs.json` and `fs-meta.json` (`scripts/parity/export-tools.ts`): the same file trees,
//! built in a fresh temporary directory, the same calls and changes in turn, and the outcomes TypeScript recorded.
//!
//! The cases were recorded on darwin; they are replayed on every unix system (the directory of a case is `$ROOT`), and
//! not on Windows, whose paths the recorded roots are not. One answer differs on purpose (K10-D2, see `races`): after a
//! write whose parent directory was swapped, TypeScript leaves its temporary file behind and Rust does not.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![cfg_attr(
    not(unix),
    allow(unused_imports, dead_code, unused_variables, unused_mut)
)]

use super::*;
use crate::exec::vectors::{assert_same, expand};
use crate::gate::doubles::{MemoryAudit, Permits, SetClock};
use crate::gate::{Gate, GatedTool, UnverifiedAction};
use plur1bus_core::approvals::OsRandom;
use plur1bus_core::policy::fs_paths::RealFs;
use plur1bus_core::policy::paths::IcuNfc;
use plur1bus_log_schema::redact::matcher::SecretMatcher;
use std::cell::RefCell;
use std::path::Path;
use std::sync::Arc;

fn fixture(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

#[test]
fn failure_texts_tools_and_limits_are_the_typescript_ones() {
    let m = fixture(include_str!(
        "../../../../fixtures/parity/tools/fs-meta.json"
    ));
    let failures = m["failures"].as_array().unwrap();
    assert_eq!(failures.len(), FsFailureCode::ALL.len());
    for (code, want) in FsFailureCode::ALL.iter().zip(failures) {
        assert_same(
            &FsFailure::new(*code, "m").to_result()["error"],
            want,
            code.as_str(),
        );
    }
    let with_reason = FsFailure::refused(
        C::PathRefused,
        &PathRefusal {
            reason: "outside-root",
            detail: "d".into(),
        },
    );
    assert_same(&with_reason.to_result(), &m["withReason"], "with a reason");
    let d = FsLimits::default();
    assert_same(
        &json!({ "maxReadBytes": d.max_read_bytes, "maxWriteBytes": d.max_write_bytes,
            "maxListEntries": d.max_list_entries, "maxResultBytes": d.max_result_bytes }),
        &m["limits"],
        "limits",
    );
    let tools: Vec<Value> = TOOLS
        .iter()
        .map(|(name, description, effect, parallel)| {
            json!({ "name": name, "description": description, "effect": effect, "parallelSafe": parallel })
        })
        .collect();
    assert_same(&json!(tools), &m["tools"], "tools");
    // The argument names the executor accepts are the properties of each schema.
    for (tool, keys) in KEYS {
        let mut props: Vec<&str> = m["schemas"][tool]["properties"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let mut keys = keys.to_vec();
        props.sort_unstable();
        keys.sort_unstable();
        assert_eq!(props, keys, "{tool}");
    }
    assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_from_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
    assert_eq!(iso_from_ms(-1), "1969-12-31T23:59:59.999Z");
    assert_eq!(
        iso_from_ms(253_402_300_800_000),
        "+010000-01-01T00:00:00.000Z"
    );
}

#[cfg(unix)]
fn apply(ops: &Value, root: &str) {
    use std::os::unix::fs::PermissionsExt;
    for op in ops.as_array().unwrap() {
        let at = |k: &str| format!("{root}/{}", op[k].as_str().unwrap());
        if op.get("mkdir").is_some() {
            std::fs::create_dir_all(at("mkdir")).unwrap();
        } else if op.get("file").is_some() {
            let p = at("file");
            std::fs::create_dir_all(Path::new(&p).parent().unwrap()).unwrap();
            let bytes = match op["b64"].as_str() {
                Some(b) => base64::engine::general_purpose::STANDARD.decode(b).unwrap(),
                None => op["text"].as_str().unwrap_or("").as_bytes().to_vec(),
            };
            std::fs::write(p, bytes).unwrap();
        } else if op.get("symlink").is_some() {
            let target = op["target"].as_str().unwrap().replace("$ROOT", root);
            std::os::unix::fs::symlink(target, at("symlink")).unwrap();
        } else if op.get("link").is_some() {
            std::fs::hard_link(at("to"), at("link")).unwrap();
        } else if op.get("fifo").is_some() {
            assert!(std::process::Command::new("mkfifo")
                .arg(at("fifo"))
                .status()
                .unwrap()
                .success());
        } else if op.get("rm").is_some() {
            let p = at("rm");
            if std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_dir()) {
                std::fs::remove_dir_all(p).unwrap();
            } else {
                let _ = std::fs::remove_file(p);
            }
        } else if op.get("rename").is_some() {
            std::fs::rename(at("rename"), at("to")).unwrap();
        } else if op.get("chmod").is_some() {
            let mode = u32::try_from(op["mode"].as_u64().unwrap()).unwrap();
            std::fs::set_permissions(at("chmod"), std::fs::Permissions::from_mode(mode)).unwrap();
        } else {
            let ms = op["ms"].as_u64().unwrap();
            let when = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms);
            File::open(at("mtime")).unwrap().set_modified(when).unwrap();
        }
    }
}

#[cfg(unix)]
fn peek(path: &str) -> Value {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::symlink_metadata(path) {
        Err(_) => json!({ "missing": true }),
        Ok(m) if m.is_file() => json!({
            "b64": base64::engine::general_purpose::STANDARD.encode(std::fs::read(path).unwrap()),
            "mode": m.permissions().mode() & 0o777,
        }),
        Ok(m) if m.file_type().is_symlink() => json!({ "kind": "symlink" }),
        Ok(m) if m.is_dir() => json!({ "kind": "directory" }),
        Ok(_) => json!({ "kind": "other" }),
    }
}

/// The size of a directory is the file system's business: compared only where the vectors were recorded.
fn portable(mut v: Value) -> Value {
    if !cfg!(target_os = "macos") && v["value"]["type"] == "directory" {
        if let Some(m) = v["value"].as_object_mut() {
            m.remove("size");
        }
    }
    v
}

#[cfg(unix)]
fn replay(case: &Value, base: &Value) {
    let name = case["name"].as_str().unwrap();
    let dir = tempfile::Builder::new()
        .prefix("p4k-fstool-")
        .tempdir()
        .unwrap();
    let root = std::fs::canonicalize(dir.path())
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    apply(base, &root);
    apply(&case["tree"], &root);
    let cfg = expand(&case["config"], Some(&root));
    let limit = |k: &str, d: u64| cfg["limits"][k].as_u64().unwrap_or(d);
    let d = FsLimits::default();
    let config = FsConfig {
        roots: vec![PathRoot {
            id: "ws".into(),
            path: format!("{root}/root"),
            identity: None,
        }],
        deny: cfg.get("deny").cloned(),
        cwd: cfg["cwd"].as_str().map(str::to_owned),
        limits: FsLimits {
            max_read_bytes: limit("maxReadBytes", d.max_read_bytes),
            max_write_bytes: limit("maxWriteBytes", d.max_write_bytes),
            max_list_entries: limit("maxListEntries", d.max_list_entries),
            max_result_bytes: limit("maxResultBytes", d.max_result_bytes),
        },
        home: Some(format!("{root}/no-home")),
        platform: None,
    };
    let who = Caller {
        principal: "christian".into(),
        agent_id: "bernd".into(),
        surface: 3,
        session_id: Some("s1".into()),
        ..Caller::default()
    };
    let clock = SetClock::at(1_000_000.0);
    let never = || false;
    let steps = case["steps"].as_array().unwrap();
    let results = case["results"].as_array().unwrap();
    for (i, (step, want)) in steps.iter().zip(results).enumerate() {
        let what = format!("{name} step {i}");
        if step.get("fs").is_some() {
            apply(&step["fs"], &root);
            continue;
        }
        if let Some(p) = step["peek"].as_str() {
            assert_same(&peek(&format!("{root}/{p}")), want, &what);
            continue;
        }
        let tool = step["tool"].as_str().unwrap();
        let args = expand(&step["args"], Some(&root));
        let access = if tool == "file.write" {
            Access::Write
        } else {
            Access::Read
        };
        // What the gate classified: the path as it resolves now, leniently (a call the classifier or the policy would
        // refuse is given to the executor anyway, so that its own refusals are reached, as the exporter recorded them).
        let classify = |a: &Value| -> Result<Classification, String> {
            let mut o = CanonicaliseOptions::new(&config.roots);
            o.deny = config.deny.as_ref();
            o.access = access;
            o.require_root = false;
            o.cwd = config
                .cwd
                .as_deref()
                .or(Some(config.roots[0].path.as_str()));
            o.home = config.home.as_deref();
            let target = a
                .get("path")
                .and_then(Value::as_str)
                .and_then(|p| canonicalise_path(&RealFs, p, &o, &IcuNfc).ok())
                .map(|c| vec![c.canonical().to_owned()]);
            let mut flags = Map::new();
            flags.insert("outsideRoots".into(), json!(false));
            Ok(Classification {
                flags,
                targets: target,
                access: Some(access.as_str()),
                hash_extra: None,
            })
        };
        let tools: Vec<GatedTool<'_>> = TOOLS
            .iter()
            .map(|(name, _, effect, _)| GatedTool {
                name,
                capability: if *effect == "read" {
                    "fs.read"
                } else {
                    "fs.write"
                },
                effect,
                risk: "low",
                classifier: Some(&classify),
            })
            .collect();
        let mut audit = MemoryAudit::default();
        let mut permits = Permits::approving();
        let approved = Gate::new(&tools, &clock, &mut audit, &mut permits)
            .verify(
                UnverifiedAction {
                    tool: tool.to_owned(),
                    args,
                    call_id: format!("c{i}"),
                    reason: None,
                    diff: None,
                },
                &who,
            )
            .unwrap_or_else(|e| panic!("{what}: the gate refused: {e}"));

        let forms: Vec<String> = step
            .get("secrets")
            .and_then(Value::as_array)
            .map(|l| {
                l.iter()
                    .map(|s| expand(s, None).as_str().unwrap().to_owned())
                    .collect()
            })
            .unwrap_or_default();
        let matcher = Arc::new(SecretMatcher::from_strs(forms.iter().map(String::as_str)));
        let known = || Arc::clone(&matcher);
        let pending = RefCell::new(step.get("afterCheck").cloned());
        let after_check = |_: &str| {
            if let Some(ops) = pending.borrow_mut().take() {
                apply(&ops, &root);
            }
        };
        let result = FsTools {
            config: config.clone(),
            ports: FsPorts {
                fs: &RealFs,
                nfc: &IcuNfc,
                clock: &clock,
                random: &OsRandom,
                aborted: &never,
                known_secrets: step.get("secrets").map(|_| &known as KnownSecrets<'_>),
            },
            after_check: Some(&after_check),
        }
        .execute(approved, &who);
        let got = match result {
            Ok(v) => json!({ "isError": false, "value": v }),
            Err(e) => e.to_result(),
        };
        let got = fixture(&serde_json::to_string(&got).unwrap().replace(&root, "$ROOT"));
        let mut want = want.clone();
        // K10-D2: the listing after the write whose parent was swapped. TypeScript removes its temporary file by path,
        // which by then leads elsewhere, so the file stays; Rust removes it through the directory's descriptor.
        if name == "races" && i == steps.len() - 1 {
            let entries = want["value"]["entries"].as_array_mut().unwrap();
            let before = entries.len();
            entries.retain(|e| e["name"] != "$TMPFILE");
            assert_eq!(
                entries.len() + 1,
                before,
                "the vector shows the file TypeScript leaves behind"
            );
        }
        assert_same(&portable(got), &portable(want), &what);
    }
    // No temporary file is left anywhere in the tree, whatever happened.
    fn walk(p: &Path, out: &mut Vec<String>) {
        for e in std::fs::read_dir(p).unwrap().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.ends_with(".p1tmp") {
                out.push(name);
            }
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                walk(&e.path(), out);
            }
        }
    }
    let mut left = Vec::new();
    walk(Path::new(&root), &mut left);
    assert!(left.is_empty(), "{name}: {left:?}");
}

#[test]
fn the_recorded_cases_come_out_as_in_typescript() {
    let f = fixture(include_str!("../../../../fixtures/parity/tools/fs.json"));
    let cases = f["cases"].as_array().unwrap();
    assert!(cases.len() >= 11);
    let mut played = 0;
    for case in cases {
        // The recorded roots are POSIX paths; on Windows no case is played.
        #[cfg(unix)]
        {
            replay(case, &f["base"]);
            played += 1;
        }
        #[cfg(not(unix))]
        let _ = case;
    }
    assert_eq!(played, if cfg!(unix) { cases.len() } else { 0 });
}
