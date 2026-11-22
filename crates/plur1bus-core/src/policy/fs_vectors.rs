//! Replay of `fixtures/parity/policy-fs/darwin.json` (`scripts/parity/export-policy-fs.ts`): the same file trees, built
//! from the description in the vector in a fresh temporary directory, and the same steps against [`super::canonicalise_path`]
//! and [`super::open_verified`] over the real file system. The answers must be the TypeScript answers, step by step.
//!
//! The file was recorded on macOS. A case marked `portable: false` depends on that file system and is played only there;
//! on Windows no case is played (the real file system answers `no-identity` there, see the module documentation). Every
//! case that is not played is counted and printed, never skipped silently.
#![cfg_attr(not(unix), allow(unused_imports, dead_code))]

use super::{
    canonicalise_path, open_verified, AccessMode, CanonicalPath, CanonicaliseOptions, Identity,
    OpenFlags, PathRoot, RealFs,
};
use crate::policy::paths::IcuNfc;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::Path;

const RECORDED_ON: &str = "darwin";

fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/parity/policy-fs/darwin.json"
    ))
    .expect("the vector file is JSON")
}

struct Dirs {
    real: String,
    spelled: String,
}

impl Dirs {
    fn fill(&self, s: &str) -> String {
        s.replace("$ROOT", &self.real)
            .replace("$TMP", &self.spelled)
    }
    fn fill_value(&self, v: &Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.fill(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.fill_value(x)).collect()),
            Value::Object(o) => Value::Object(
                o.iter()
                    .map(|(k, x)| (k.clone(), self.fill_value(x)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }
    fn mask(&self, s: &str) -> String {
        let r = s.replace(&self.real, "$ROOT");
        if self.spelled == self.real {
            r
        } else {
            r.replace(&self.spelled, "$TMP")
        }
    }
}

fn code(e: &std::io::Error) -> String {
    super::error_code(e).code
}

/// One tree operation, as the exporter's `applyOp` does it.
#[cfg(unix)]
fn apply(d: &Dirs, op: &Value) {
    use std::os::unix::fs::PermissionsExt;
    let at = |k: &str| Path::new(&d.real).join(op[k].as_str().unwrap());
    if op.get("mkdir").is_some() {
        std::fs::create_dir_all(at("mkdir")).unwrap();
    } else if op.get("file").is_some() {
        let p = at("file");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, op["text"].as_str().unwrap()).unwrap();
    } else if op.get("symlink").is_some() {
        std::os::unix::fs::symlink(d.fill(op["target"].as_str().unwrap()), at("symlink")).unwrap();
    } else if op.get("link").is_some() {
        std::fs::hard_link(at("to"), at("link")).unwrap();
    } else if op.get("fifo").is_some() {
        let ok = std::process::Command::new("mkfifo")
            .arg(at("fifo"))
            .status()
            .unwrap()
            .success();
        assert!(ok, "mkfifo");
    } else if op.get("rm").is_some() {
        let p = at("rm");
        if std::fs::symlink_metadata(&p).unwrap().is_dir() {
            std::fs::remove_dir_all(p).unwrap();
        } else {
            std::fs::remove_file(p).unwrap();
        }
    } else if op.get("rename").is_some() {
        std::fs::rename(at("rename"), at("to")).unwrap();
    } else {
        let mode = u32::try_from(op["mode"].as_u64().unwrap()).unwrap();
        std::fs::set_permissions(at("chmod"), std::fs::Permissions::from_mode(mode)).unwrap();
    }
}

fn projection(d: &Dirs, r: &Result<CanonicalPath, super::PathRefusal>) -> Value {
    match r {
        Err(e) => json!({ "ok": false, "reason": e.reason, "detail": d.mask(&e.detail) }),
        Ok(c) => {
            json!({ "ok": true, "canonical": d.mask(&c.canonical), "rootId": c.root_id, "exists": c.exists,
            "hardLinked": c.hard_linked, "denyGuarded": c.deny_guarded, "systemTree": c.system_tree, "access": c.access.as_str() })
        }
    }
}

fn flags_of(names: &Value) -> OpenFlags {
    let mut f = OpenFlags::READ;
    for n in names.as_array().unwrap() {
        match n.as_str().unwrap() {
            "O_RDONLY" => {}
            "O_WRONLY" => f.access = AccessMode::WriteOnly,
            "O_RDWR" => f.access = AccessMode::ReadWrite,
            "O_APPEND" => f.append = true,
            "O_TRUNC" => f.truncate = true,
            "O_CREAT" => f.create = true,
            "O_EXCL" => f.exclusive = true,
            other => panic!("unknown flag {other}"),
        }
    }
    f
}

fn identity_of(v: &Value) -> Identity {
    Identity {
        dev: v["dev"].as_str().unwrap().to_owned(),
        ino: v["ino"].as_str().unwrap().to_owned(),
        birth: v.get("birth").and_then(Value::as_str).map(str::to_owned),
    }
}

/// The steps of one case; returns the results in the exporter's shape.
fn run(d: &Dirs, steps: &[Value]) -> Vec<Value> {
    let fs = RealFs;
    let mut canon: Vec<Option<Result<CanonicalPath, super::PathRefusal>>> = Vec::new();
    let mut out = Vec::new();
    for step in steps {
        canon.push(None);
        match step["op"].as_str().unwrap() {
            "canon" => {
                let o = d.fill_value(step.get("options").unwrap_or(&json!({})));
                let roots: Vec<PathRoot> = match o.get("roots") {
                    None => vec![PathRoot {
                        id: "ws".into(),
                        path: d.fill("$ROOT/root"),
                        identity: None,
                    }],
                    Some(list) => list
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|r| PathRoot {
                            id: r["id"].as_str().unwrap().to_owned(),
                            path: r["path"].as_str().unwrap().to_owned(),
                            identity: r.get("identity").map(|i| match i.get("fromStep") {
                                Some(n) => canon[usize::try_from(n.as_u64().unwrap()).unwrap()]
                                    .as_ref()
                                    .unwrap()
                                    .as_ref()
                                    .unwrap()
                                    .identity
                                    .clone(),
                                None => identity_of(i),
                            }),
                        })
                        .collect(),
                };
                let home = o
                    .get("home")
                    .and_then(Value::as_str)
                    .map_or_else(|| d.fill("$ROOT/no-home"), str::to_owned);
                let cwd = o.get("cwd").and_then(Value::as_str);
                let mut opts = CanonicaliseOptions::new(&roots);
                opts.platform = Some(RECORDED_ON);
                opts.cwd = cwd;
                opts.deny = o.get("deny");
                opts.home = Some(&home);
                if o.get("access").and_then(Value::as_str) == Some("write") {
                    opts.access = super::Access::Write;
                }
                if let Some(r) = o.get("requireRoot").and_then(Value::as_bool) {
                    opts.require_root = r;
                }
                opts.scan_cap = o.get("scanCap").and_then(Value::as_i64);
                let input = d.fill(step["input"].as_str().unwrap());
                let r = canonicalise_path(&fs, &input, &opts, &IcuNfc);
                out.push(projection(d, &r));
                *canon.last_mut().unwrap() = Some(r);
            }
            "open" => {
                let of = usize::try_from(step["of"].as_u64().unwrap()).unwrap();
                let c = canon[of].as_ref().unwrap().as_ref().unwrap().clone();
                let flags = flags_of(&step["flags"]);
                match open_verified(&fs, &c, flags) {
                    Err(e) => out.push(projection(d, &Err(e))),
                    Ok(mut h) => {
                        let mut r = json!({ "ok": true });
                        if flags.access != AccessMode::WriteOnly {
                            let mut text = String::new();
                            match h.read_to_string(&mut text) {
                                Ok(_) => r["text"] = json!(text),
                                Err(e) => r["readError"] = json!(code(&e)),
                            }
                        }
                        if flags.access != AccessMode::ReadOnly {
                            match h.write_all(b"W") {
                                Ok(()) => r["wrote"] = json!(true),
                                Err(e) => r["writeError"] = json!(code(&e)),
                            }
                        }
                        out.push(r);
                    }
                }
            }
            "fs" => {
                #[cfg(unix)]
                for op in step["do"].as_array().unwrap() {
                    apply(d, op);
                }
                out.push(Value::Null);
            }
            "read" => out.push(
                match std::fs::read_to_string(d.fill(step["path"].as_str().unwrap())) {
                    Ok(t) => json!({ "text": t }),
                    Err(e) => json!({ "error": code(&e) }),
                },
            ),
            _ => out.push(
                match std::fs::read_dir(d.fill(step["path"].as_str().unwrap())) {
                    Ok(it) => {
                        let mut names: Vec<String> = it
                            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                            .collect();
                        crate::js::sort_default(&mut names);
                        json!({ "names": names })
                    }
                    Err(e) => json!({ "error": code(&e) }),
                },
            ),
        }
    }
    out
}

// The count of cases not played is asserted below per system; the line is for `--nocapture`, so a reader sees it.
#[allow(clippy::print_stderr)]
#[test]
fn fs_path_vectors_replay() {
    let v = vectors();
    assert_eq!(v["platform"], RECORDED_ON);
    let here = super::PathFs::platform(&RealFs);
    let cases = v["cases"].as_array().unwrap();
    let (mut played, mut not_here) = (0, Vec::new());
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let portable = case["portable"].as_bool().unwrap();
        if cfg!(windows) || (!portable && here != RECORDED_ON) {
            not_here.push(name);
            continue;
        }
        let tmp = tempfile::Builder::new()
            .prefix("p4k-fs-")
            .tempdir()
            .unwrap();
        let spelled = tmp.path().to_str().unwrap().to_owned();
        let real = std::fs::canonicalize(tmp.path())
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let d = Dirs { real, spelled };
        #[cfg(unix)]
        for op in v["base"]
            .as_array()
            .unwrap()
            .iter()
            .chain(case["tree"].as_array().unwrap())
        {
            apply(&d, op);
        }
        let got = run(&d, case["steps"].as_array().unwrap());
        // Give back any permission a case took away, so the directory can be removed.
        let _ = std::process::Command::new("chmod")
            .args(["-R", "u+rwx", &d.real])
            .status();
        let want = case["results"].as_array().unwrap();
        assert_eq!(got.len(), want.len(), "{name}");
        for (i, (g, w)) in got.iter().zip(want).enumerate() {
            // Every step is TypeScript's answer, the truncation case of P4D-43 (formerly K2-D5) included.
            assert_eq!(g, w, "case {name}, step {i}: {}", case["steps"][i]);
        }
        played += 1;
    }
    eprintln!(
        "policy-fs vectors: {played} of {} cases played on {here}; recorded on {RECORDED_ON}, not played here: {not_here:?}",
        cases.len()
    );
    assert_eq!(played + not_here.len(), cases.len());
    if here == RECORDED_ON {
        assert!(
            not_here.is_empty(),
            "every case plays on the recording system"
        );
    }
    if cfg!(windows) {
        assert!(played == 0 && not_here.len() == cases.len());
    }
    if cfg!(target_os = "linux") {
        // The cases that depend on the macOS file system, and nothing else, are left out on Linux.
        assert_eq!(
            not_here,
            [
                "unicode-nfd",
                "case-insensitive-volume",
                "long-path",
                "name-scan-unreadable",
                "system-tree-etc",
                "spelled-through-var"
            ]
        );
    }
}
