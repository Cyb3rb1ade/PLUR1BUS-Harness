//! Replay of `fixtures/parity/tools/exec-rules.json` and `exec-runs.json` (`scripts/parity/export-tools.ts`).
//!
//! The rules are pure and replayed on every system. The runs were recorded on darwin against real directories; they are
//! replayed on every unix system with the recorded platform as an argument (the directory of a run is `$ROOT`), and not
//! on Windows, whose paths the recorded roots are not.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::capture::BoundedCapture;
use super::process::doubles::{ScriptedPort, Stage, Step};
use super::*;
use crate::gate::doubles::{MemoryAudit, Permits};
use crate::gate::{Gate, GatedTool, UnverifiedAction};
use base64::Engine as _;
use plur1bus_canon::canonical_json;
use plur1bus_core::policy::fs_paths::RealFs;
use plur1bus_core::policy::paths::IcuNfc;
use plur1bus_log_schema::redact::matcher::SecretMatcher;
use std::rc::Rc;
use std::sync::Arc;

fn fixture(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

/// The input notation of the exporter: `$repeat`, `$fill`, `parts`, and `$ROOT` in strings.
pub(crate) fn expand(v: &Value, root: Option<&str>) -> Value {
    match v {
        Value::String(s) => Value::String(match root {
            Some(r) => s.replace("$ROOT", r),
            None => s.clone(),
        }),
        Value::Array(a) => Value::Array(a.iter().map(|x| expand(x, root)).collect()),
        Value::Object(o) => {
            if let Some(r) = o.get("$repeat").and_then(Value::as_array) {
                let n = usize::try_from(r[1].as_u64().unwrap()).unwrap();
                return Value::String(r[0].as_str().unwrap().repeat(n));
            }
            if let Some(f) = o.get("$fill").and_then(Value::as_array) {
                let n = usize::try_from(f[1].as_u64().unwrap()).unwrap();
                return Value::Array(vec![expand(&f[0], root); n]);
            }
            if let Some(p) = o.get("parts").and_then(Value::as_array) {
                return Value::String(p.iter().map(|x| x.as_str().unwrap()).collect());
            }
            Value::Object(
                o.iter()
                    .map(|(k, x)| (k.clone(), expand(x, root)))
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

/// Equal as JavaScript values (a whole float is the integer).
#[track_caller]
pub(crate) fn assert_same(got: &Value, want: &Value, what: &str) {
    assert_eq!(canonical_json(got), canonical_json(want), "{what}");
}

fn outcome<T>(r: Result<T, ExecFailure>, ok: impl FnOnce(T) -> Value) -> Value {
    match r {
        Ok(v) => json!({ "ok": ok(v) }),
        Err(e) => json!({ "code": e.code.as_str(), "message": e.message }),
    }
}

fn pairs(v: &Value) -> Vec<(String, Value)> {
    v.as_array()
        .map(|l| {
            l.iter()
                .map(|p| (p[0].as_str().unwrap().to_owned(), p[1].clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn allowlist(v: &Value) -> Vec<AllowedProgram> {
    v.as_array()
        .map(|l| {
            l.iter()
                .map(|e| AllowedProgram {
                    program: e["program"].as_str().unwrap().to_owned(),
                    arg_pattern: e["argPattern"].as_str().map(str::to_owned),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_owned())
        .collect()
}

fn rules() -> Value {
    fixture(include_str!(
        "../../../../fixtures/parity/tools/exec-rules.json"
    ))
}

#[test]
fn constants_and_the_schema_are_the_typescript_ones() {
    let c = &rules()["constants"];
    assert_same(
        &json!({ "timeoutMs": EXEC_TIMEOUT_MS, "maxTimeoutMs": EXEC_MAX_TIMEOUT_MS, "maxOutputBytes": EXEC_MAX_OUTPUT_BYTES,
            "maxMaxOutputBytes": EXEC_MAX_MAX_OUTPUT_BYTES, "defaultEnvAllow": env::DEFAULT_ENV_ALLOW }),
        &json!({ "timeoutMs": c["timeoutMs"], "maxTimeoutMs": c["maxTimeoutMs"], "maxOutputBytes": c["maxOutputBytes"],
            "maxMaxOutputBytes": c["maxMaxOutputBytes"], "defaultEnvAllow": c["defaultEnvAllow"] }),
        "constants",
    );
    // The argument names the executor accepts are the properties of the schema.
    let mut props: Vec<&str> = c["schema"]["properties"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let mut keys = KEYS.to_vec();
    props.sort_unstable();
    keys.sort_unstable();
    assert_eq!(props, keys);
}

#[test]
fn programs_are_validated_like_typescript() {
    let r = rules();
    let cases = r["programs"].as_array().unwrap();
    assert!(cases.len() > 70);
    for c in cases {
        let p = expand(&c["input"], None);
        let got = outcome(args::validate_program(Some(&p), false), |s| json!(s));
        assert_same(&got, &c["result"], &format!("program {}", c["input"]));
        if let Some(s) = p.as_str() {
            assert_eq!(
                args::program_key(s, false),
                c["key"].as_str().unwrap(),
                "key of {s:?}"
            );
        }
    }
    assert_eq!(
        args::validate_program(None, false).unwrap_err().message,
        "program must be a non-empty string"
    );
    // On a Windows host Node's basename also leaves out a drive prefix: `C:sh` is `sh` there and a file name here.
    assert_eq!(args::program_key("C:sh", true), "sh");
    assert_eq!(args::program_key("C:sh", false), "c:sh");
    assert_eq!(
        args::validate_program(Some(&json!("C:bash.exe")), true)
            .unwrap_err()
            .code,
        ExecFailureCode::ProgramRefused
    );
}

#[test]
fn arguments_are_validated_like_typescript() {
    let r = rules();
    for c in r["args"].as_array().unwrap() {
        let v = expand(&c["input"], None);
        let input = (!c["absent"].as_bool().unwrap()).then_some(&v);
        let got = outcome(
            args::validate_args(input),
            |list| json!({ "count": list.len(), "sha256": sha256_hex(&strings_json(&list)) }),
        );
        assert_same(&got, &c["result"], &format!("args {}", c["input"]));
    }
}

#[test]
fn the_allowlist_and_its_patterns_answer_like_typescript() {
    let r = rules();
    let lists: Vec<Vec<AllowedProgram>> = r["allowLists"]
        .as_array()
        .unwrap()
        .iter()
        .map(allowlist)
        .collect();
    for c in r["allow"].as_array().unwrap() {
        let list = &lists[usize::try_from(c["list"].as_u64().unwrap()).unwrap()];
        let found = args::find_allowed(
            list,
            c["program"].as_str().unwrap(),
            c["windows"].as_bool().unwrap(),
        )
        .map(|e| list.iter().position(|x| std::ptr::eq(x, e)).unwrap());
        assert_same(&json!(found), &c["found"], &format!("allow {c}"));
    }
    let arg_lists: Vec<Vec<String>> = r["patternArgs"]
        .as_array()
        .unwrap()
        .iter()
        .map(strings)
        .collect();
    let (mut exact, mut declined_where_typescript_allows) = (0, 0);
    for p in r["patterns"].as_array().unwrap() {
        let pattern = p["pattern"].as_str().unwrap();
        let subset = p["subset"].as_bool().unwrap();
        assert_eq!(
            pattern::ArgPattern::compile(pattern).is_some(),
            subset,
            "{pattern:?} in the subset"
        );
        for (args, want) in arg_lists.iter().zip(p["matches"].as_array().unwrap()) {
            let got = pattern::args_match_pattern(Some(pattern), args);
            let want = want.as_bool().unwrap();
            if subset {
                assert_eq!(got, want, "{pattern:?} on {args:?}");
                exact += 1;
            } else {
                // Outside the subset the entry allows nothing (fail closed), whatever TypeScript answers.
                assert!(!got, "{pattern:?} on {args:?}");
                declined_where_typescript_allows += usize::from(want);
            }
        }
    }
    assert!(exact > 600, "{exact}");
    assert!(declined_where_typescript_allows > 100);
    assert_eq!(
        pattern::args_match_pattern(None, &["anything".to_owned(), "\n".to_owned()]),
        r["noPattern"].as_bool().unwrap()
    );
}

#[test]
fn the_environment_is_built_like_typescript() {
    let r = rules();
    for c in r["secretish"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        assert_eq!(
            env::is_secretish_name(name),
            c["secretish"].as_bool().unwrap(),
            "{name}"
        );
    }
    let cases = r["env"].as_array().unwrap();
    assert!(cases.len() > 20);
    for c in cases {
        let allow: Vec<String> = match c["allow"].as_array() {
            Some(_) => strings(&c["allow"]),
            None => env::DEFAULT_ENV_ALLOW
                .iter()
                .map(|s| (*s).to_owned())
                .collect(),
        };
        let base: Vec<(String, Option<String>)> = pairs(&c["base"])
            .into_iter()
            .map(|(k, v)| (k, v.as_str().map(str::to_owned)))
            .collect();
        let got = match env::build_env(
            &allow,
            &base,
            &pairs(&c["requested"]),
            c["windows"].as_bool().unwrap(),
        ) {
            Ok(e) => {
                json!({ "ok": e.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(), "fingerprint": env::env_fingerprint(&e) })
            }
            Err(e) => json!({ "code": e.code.as_str(), "message": e.message }),
        };
        assert_same(&got, &c["result"], &format!("env {c}"));
    }
}

#[test]
fn a_stream_is_captured_like_typescript() {
    let r = rules();
    let cases = r["capture"].as_array().unwrap();
    assert!(cases.len() > 18);
    for c in cases {
        let forms: Vec<String> = c
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
        let known: Option<KnownSecrets<'_>> = c.get("secrets").map(|_| &known as KnownSecrets<'_>);
        let mut cap = BoundedCapture::new(
            usize::try_from(c["limit"].as_u64().unwrap()).unwrap(),
            known,
        );
        for chunk in c["chunks"].as_array().unwrap() {
            cap.push(
                &base64::engine::general_purpose::STANDARD
                    .decode(chunk.as_str().unwrap())
                    .unwrap(),
            );
        }
        let text = cap.text(c.get("complete").and_then(Value::as_bool).unwrap_or(true));
        assert_eq!(
            (text.as_str(), cap.truncated),
            (
                c["text"].as_str().unwrap(),
                c["truncated"].as_bool().unwrap()
            ),
            "capture {c}"
        );
    }
}

// --- the runs -----------------------------------------------------------------------------------------------------------------

fn who() -> Caller {
    Caller {
        principal: "christian".into(),
        agent_id: "bernd".into(),
        surface: 3,
        session_id: Some("s1".into()),
        task_id: Some("t1".into()),
        ..Caller::default()
    }
}

fn steps(script: &Value) -> Vec<Step> {
    script
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            if let Some(s) = e["out"].as_str() {
                Step::Out(s.as_bytes().to_vec())
            } else if let Some(b) = e["outB64"].as_str() {
                Step::Out(base64::engine::general_purpose::STANDARD.decode(b).unwrap())
            } else if let Some(s) = e["err"].as_str() {
                Step::Err(s.as_bytes().to_vec())
            } else if let Some(n) = e["advance"].as_f64() {
                Step::Advance(n)
            } else if let Some(n) = e["exit"].as_i64() {
                Step::Exit(i32::try_from(n).unwrap())
            } else if e.get("abort").is_some() {
                Step::Abort
            } else {
                Step::Fail(e["fail"].as_str().unwrap().to_owned())
            }
        })
        .collect()
}

fn config_of(c: &Value, root: &str) -> ExecConfig {
    let c = expand(c, Some(root));
    let num = |k: &str| c.get(k).and_then(Value::as_f64);
    ExecConfig {
        mode: match c.get("mode") {
            None => Some("allowlist".to_owned()),
            Some(m) => m.as_str().map(str::to_owned),
        },
        roots: vec![PathRoot {
            id: "r".into(),
            path: root.to_owned(),
            identity: None,
        }],
        deny: c.get("deny").cloned(),
        allowlist: match c.get("allowlist") {
            Some(l) => allowlist(l),
            None => vec![AllowedProgram {
                program: "git".into(),
                arg_pattern: None,
            }],
        },
        env_allow: c.get("envAllow").map(strings),
        default_timeout_ms: num("defaultTimeoutMs"),
        max_timeout_ms: num("maxTimeoutMs"),
        default_max_output_bytes: num("defaultMaxOutputBytes"),
        max_max_output_bytes: num("maxMaxOutputBytes"),
    }
}

/// One recorded run through the gate and the executor; what TypeScript recorded must come out.
fn replay(run: &Value) {
    let name = run["name"].as_str().unwrap();
    let dir = tempfile::Builder::new()
        .prefix("p4k-exec-")
        .tempdir()
        .unwrap();
    let root = std::fs::canonicalize(dir.path())
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    std::fs::create_dir(format!("{root}/work")).unwrap();
    for t in run["tree"].as_array().unwrap() {
        std::fs::write(format!("{root}/{}", t["file"].as_str().unwrap()), "x").unwrap();
    }
    let args = expand(&run["args"], Some(&root));
    let config = config_of(&run["config"], &root);
    let platform = run["platform"].as_str().unwrap().to_owned();
    let base_env: Vec<(String, Option<String>)> = pairs(&run["baseEnv"])
        .into_iter()
        .map(|(k, v)| (k, v.as_str().map(str::to_owned)))
        .collect();
    let stage = Rc::new(Stage::default());
    stage.clock.0.set(1_000_000.0);

    // What the gate classified: this call's own working directory and environment, unless the run replaces a part
    // (computed leniently, as the exporter does, so that the executor's own refusals are reached).
    let env_allow = config.env_allow();
    let classify = |a: &Value| -> Result<Classification, String> {
        let mut target = a
            .get("cwd")
            .and_then(Value::as_str)
            .and_then(|c| std::fs::canonicalize(c).ok())
            .and_then(|p| p.to_str().map(str::to_owned));
        let mut extra = (a.is_object() && a.get("env").is_none_or(Value::is_object))
            .then(|| {
                env::build_env(
                    &env_allow,
                    &base_env,
                    &requested_env(a),
                    platform == "win32",
                )
                .ok()
            })
            .flatten()
            .map(|e| env::env_fingerprint(&e));
        if let Some(o) = run["classified"].as_object() {
            if let Some(t) = o.get("target").and_then(Value::as_str) {
                target = Some(t.replace("$ROOT", &root));
            }
            if let Some(h) = o.get("hashExtra").and_then(Value::as_str) {
                extra = Some(h.to_owned());
            }
        }
        let mut flags = Map::new();
        flags.insert("outsideRoots".into(), json!(false));
        Ok(Classification {
            flags,
            targets: target.map(|t| vec![t]),
            access: Some("write"),
            hash_extra: extra,
        })
    };
    let tools = [GatedTool {
        name: "exec.run",
        capability: "shell.exec",
        effect: "local-write",
        risk: "medium",
        classifier: Some(&classify),
    }];
    let mut gate_audit = MemoryAudit::default();
    let mut permits = Permits::approving();
    let approved = Gate::new(&tools, &stage.clock, &mut gate_audit, &mut permits)
        .verify(
            UnverifiedAction {
                tool: "exec.run".into(),
                args,
                call_id: "c1".into(),
                reason: None,
                diff: None,
            },
            &who(),
        )
        .unwrap_or_else(|e| panic!("{name}: the gate refused: {e}"));

    let failing = strings(&run["auditFails"]);
    let mut events: Vec<AuditEvent> = Vec::new();
    let mut sink = |e: &AuditEvent| -> Result<(), String> {
        if failing.contains(&e.action) {
            return Err("audit sink failed".to_owned());
        }
        events.push(e.clone());
        Ok(())
    };
    let port = ScriptedPort {
        stage: Rc::clone(&stage),
        script: steps(&run["script"]),
        spawn_fails: run["spawnThrows"].as_str().map(str::to_owned),
    };
    let pre_aborted = run["aborted"].as_bool().unwrap();
    let aborted = || pre_aborted || stage.aborted.get();
    let result = ExecTool {
        config,
        ports: ExecPorts {
            fs: &RealFs,
            nfc: &IcuNfc,
            process: &port,
            clock: &stage.clock,
            audit: &mut sink,
            base_env: &base_env,
            aborted: &aborted,
            known_secrets: None,
        },
        platform: Some(&platform),
        host: Some("h1"),
    }
    .execute(approved, &who());

    let masked = |v: &Value| fixture(&serde_json::to_string(v).unwrap().replace(&root, "$ROOT"));
    let got = match &result {
        Ok(r) => r.to_result(),
        Err(e) => e.to_result(),
    };
    assert_same(&masked(&got), &run["outcome"], &format!("{name}: outcome"));
    let mut hash = None;
    let lines: Vec<Value> = events
        .iter()
        .map(|e| {
            let detail: Vec<Value> = e
                .detail
                .iter()
                .map(|(k, v)| {
                    if k == "actionHash" {
                        hash = v.as_str().map(str::to_owned);
                        json!([k, "$HASH"])
                    } else {
                        json!([k, v])
                    }
                })
                .collect();
            json!({ "at": e.at, "user": e.user, "host": e.host, "action": e.action, "target": e.target, "detail": detail })
        })
        .collect();
    assert_same(
        &masked(&json!(lines)),
        &run["audit"],
        &format!("{name}: audit lines"),
    );
    let spawned: Vec<Value> = stage
        .spawned
        .borrow()
        .iter()
        .map(|(s, kills)| {
            json!({ "program": s.program, "args": s.args, "cwd": s.cwd, "kills": kills.get(),
                "env": s.env.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>() })
        })
        .collect();
    assert_same(
        &masked(&json!(spawned)),
        &run["spawned"],
        &format!("{name}: spawned"),
    );
    if let Some(pre) = run["hashPreimage"].as_str() {
        assert_eq!(
            hash.as_deref(),
            Some(sha256_hex(&pre.replace("$ROOT", &root)).as_str()),
            "{name}: the action hash"
        );
    }
}

#[test]
fn the_recorded_runs_come_out_as_in_typescript() {
    let f = fixture(include_str!(
        "../../../../fixtures/parity/tools/exec-runs.json"
    ));
    let runs = f["runs"].as_array().unwrap();
    assert!(runs.len() > 60);
    let mut played = 0;
    for run in runs {
        if cfg!(windows) {
            continue; // the recorded roots are POSIX paths
        }
        replay(run);
        played += 1;
    }
    assert_eq!(played, if cfg!(windows) { 0 } else { runs.len() });
}
