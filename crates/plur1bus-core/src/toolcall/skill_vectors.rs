//! Replays `fixtures/parity/toolcall/skill-tools.json` (mode V, `scripts/parity/export-skill-tools.ts`): each scenario's
//! file tree is built in a fresh temporary home, every call is made in order, and the answer must be the one TypeScript
//! gave: the result's JSON text, or the refusal's code and message, or a cancellation. Scenarios with symlinks or a FIFO
//! run on Unix only.
use super::json::{JsStr, V};
use super::skill_tools::{
    create_skill_tools, is_secret_file_name, requests_credential, tool_definitions, Cancelled,
    SkillError, SkillMode, SkillTools, DENY_NAMES,
};
use super::vectors::{js, raw_of};
use serde_json::Value;
use std::path::Path;
use std::sync::{Arc, Mutex};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/parity/toolcall/skill-tools.json"
    ))
    .expect("fixture parses")
}

struct Flag(bool);

impl Cancelled for Flag {
    fn aborted(&self) -> bool {
        self.0
    }
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn build(home: &Path, nodes: &[Value]) {
    for node in nodes {
        let path = node[0].as_str().unwrap();
        let target = path.split('/').fold(home.to_path_buf(), |p, s| p.join(s));
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        match node[1].as_str().unwrap() {
            "dir" => std::fs::create_dir_all(&target).unwrap(),
            "file" => {
                let bytes = match node[2].get("hex").and_then(Value::as_str) {
                    Some(h) => hex(h),
                    None => js(&node[2]).lossy().into_bytes(),
                };
                std::fs::write(&target, bytes).unwrap();
            }
            #[cfg(unix)]
            "link" => std::os::unix::fs::symlink(node[2].as_str().unwrap(), &target).unwrap(),
            #[cfg(unix)]
            "fifo" => {
                let status = std::process::Command::new("mkfifo")
                    .arg(&target)
                    .status()
                    .unwrap();
                assert!(status.success());
            }
            other => panic!("node kind {other} on this platform"),
        }
    }
}

fn mode_of(v: &Value) -> SkillMode {
    match v.as_str().unwrap() {
        "load" => SkillMode::Load,
        _ => SkillMode::Read,
    }
}

fn check_outcome(case: &str, want: &Value, got: Result<V, SkillError>) {
    match (got, want.get("ok")) {
        (Ok(v), Some(text)) => assert_eq!(v.stringify(), js(text).lossy(), "{case}"),
        (Ok(v), None) => panic!(
            "{case}: TypeScript refuses ({want}), Rust answers {}",
            v.stringify()
        ),
        (Err(SkillError::Aborted), _) => {
            assert_eq!(want.get("aborted"), Some(&Value::Bool(true)), "{case}")
        }
        (Err(SkillError::Access(code)), _) => {
            assert_eq!(want["code"].as_str(), Some(code.code()), "{case}");
            assert_eq!(want["message"].as_str(), Some(code.message()), "{case}");
        }
    }
}

#[test]
fn skill_tool_scenarios() {
    let f = fixture();
    let mut ran = 0;
    for s in f["scenarios"].as_array().unwrap() {
        let name = s["name"].as_str().unwrap();
        if s.get("unix").is_some() && !cfg!(unix) {
            continue;
        }
        let home = tempfile::tempdir().unwrap();
        build(home.path(), s["nodes"].as_array().unwrap());
        let admitted: Vec<&str> = s["admitted"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap())
            .collect();
        let loaded = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = Arc::clone(&loaded);
        let mut tools: SkillTools = create_skill_tools(
            home.path(),
            &admitted,
            Some(Box::new(move |n: &str| {
                sink.lock().unwrap().push(n.to_owned())
            })),
        )
        .unwrap();
        for (i, call) in s["calls"].as_array().unwrap().iter().enumerate() {
            let args = raw_of(&call[1]);
            let got = tools.execute(
                mode_of(&call[0]),
                args.as_ref(),
                &Flag(call[2].as_bool().unwrap()),
            );
            check_outcome(&format!("{name} #{i} {}", call[1]), &call[3], got);
            ran += 1;
        }
        let want: Vec<&str> = s["loaded"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap())
            .collect();
        assert_eq!(*loaded.lock().unwrap(), want, "{name}: recorded loads");
    }
    assert!(ran > 100, "only {ran} calls replayed");
}

#[test]
fn skill_tool_tables() {
    let f = fixture();
    assert_eq!(
        tool_definitions().stringify(),
        f["definitions"].as_str().unwrap()
    );
    let deny: Vec<&str> = f["denyNames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap())
        .collect();
    assert_eq!(deny, DENY_NAMES);
    for c in f["secretNames"].as_array().unwrap() {
        let n = c[0].as_str().unwrap();
        assert_eq!(is_secret_file_name(n), c[1].as_bool().unwrap(), "{n}");
    }
    for c in f["classify"].as_array().unwrap() {
        let args = super::vectors::value_of(c[0].as_str().unwrap());
        let got = V::Arr(
            [SkillMode::Load, SkillMode::Read]
                .iter()
                .map(|m| SkillTools::classify(*m, Some(&args)))
                .collect(),
        );
        assert_eq!(got.stringify(), c[1].as_str().unwrap(), "{}", c[0]);
    }
    // No credential reaches the deny-list check through a non-object.
    assert!(!requests_credential(Some(&V::Str(JsStr::from(".env")))));
    assert!(!requests_credential(None));
}
