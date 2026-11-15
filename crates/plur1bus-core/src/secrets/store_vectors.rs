//! Replay of the vectors recorded from the stateful parts of the TypeScript secret store
//! (`scripts/parity/export-secrets-store.ts`, `fixtures/parity/secrets-store/*.json`). Recorded, never edited by hand.
use super::backend::SecretBackend;
use super::error::SecretError;
use super::file_backend::{node_base64_decode, FileBackend, FILE_SCHEMA, MAX_TOMBSTONES};
use super::types::SecretMeta;
use crate::logs::redact::{SecretSet, MAX_REGISTERED_SECRETS};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex};

fn load(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/parity/secrets-store/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect()
}

/// `prefix` and four digits, as the exporter's `numbered`.
fn numbered(prefix: &str, i: u64) -> String {
    format!("{prefix}{i:04}")
}

/// Every step of every scenario: the values the registry holds (pinned first, then retired, oldest first), what a subscribed
/// sink heard during the step, and the answer of `mask` and `contains`. A scenario with a `note` is the one place where the
/// Rust registry differs on purpose (P4D-26): there the values are compared as a set.
#[test]
fn the_registry_replays_the_recorded_scenarios() {
    let file = load("registry");
    assert_eq!(file["maxRegistered"], json!(MAX_REGISTERED_SECRETS));
    let mut bad = Vec::new();
    let mut total = 0;
    for scenario in file["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let as_set = scenario.get("note").is_some();
        let set = SecretSet::new();
        let events: Arc<Mutex<Vec<Value>>> = Arc::default();
        let mut sink = None;
        for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            total += 1;
            events.lock().unwrap().clear();
            let op = step["op"].as_array().unwrap();
            let text = |n: usize| op[n].as_str().unwrap();
            let range = || {
                let from = op[2].as_u64().unwrap();
                from..from + op[3].as_u64().unwrap()
            };
            let mut result = None;
            match text(0) {
                "register" => match op[2].as_str() {
                    Some(slot) => set.register_named(text(1), slot),
                    None => set.register(text(1)),
                },
                "many" => range().for_each(|n| set.register(&numbered(text(1), n))),
                "rotate" => {
                    range().for_each(|n| set.register_named(&numbered(text(1), n), text(4)));
                }
                "group" => {
                    let values = strings(&op[2]);
                    let values: Vec<&str> = values.iter().map(String::as_str).collect();
                    set.replace_group(text(1), &values);
                }
                "mask" => result = Some(Value::String(set.mask(text(1)))),
                "contains" => result = Some(Value::Bool(set.contains(text(1)))),
                "subscribe" => {
                    let heard = events.clone();
                    sink = Some(set.subscribe(Box::new(move |value, pinned| {
                        heard.lock().unwrap().push(json!([value, pinned]));
                    })));
                }
                "unsubscribe" => {
                    if let Some(id) = sink.take() {
                        set.unsubscribe(id);
                    }
                }
                other => panic!("{name}: unknown step {other}"),
            }
            let (mut got, mut want) = (set.values(), strings(&step["values"]));
            if as_set {
                got.sort();
                want.sort();
            }
            let heard = Value::Array(events.lock().unwrap().clone());
            if got != want || heard != step["events"] || result.as_ref() != step.get("result") {
                bad.push(format!(
                    "{name} step {i} {}: values {got:?} (recorded {want:?}), events {heard} (recorded {}), result {result:?} (recorded {:?})",
                    step["op"],
                    step["events"],
                    step.get("result")
                ));
            }
        }
    }
    assert!(total > 80, "the grid shrank: {total} steps");
    assert!(
        bad.is_empty(),
        "{} of {total} steps differ:\n{}",
        bad.len(),
        bad.iter().take(5).cloned().collect::<Vec<_>>().join("\n")
    );
}

/// P4D-26, the Rust side of the noted scenario: a retired value that is registered again is the newest retired value, so
/// the bound drops it last, not first.
#[test]
fn a_retired_value_registered_again_is_the_newest_one() {
    let set = SecretSet::new();
    let (a, b, c) = ("alpha-value-one", "bravo-value-two", "charlie-value-three");
    for value in [a, b, a, c] {
        set.register(value);
    }
    assert_eq!(set.values(), [b, a, c]);
    // `a` is in use again and again while other values come and go: it stays, the idle `b` and `c` leave.
    for n in 0..MAX_REGISTERED_SECRETS as u64 {
        set.register(&numbered("passing-value-", n));
        set.register(a);
    }
    assert!(set.contains(a) && !set.contains(b) && !set.contains(c));
    assert_eq!(set.values().len(), MAX_REGISTERED_SECRETS);
}

// --- file backend ------------------------------------------------------------------------------------------------------------

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn outcome<T>(result: Result<T, SecretError>, ok: impl FnOnce(T) -> Value) -> Value {
    match result {
        Ok(value) => json!({ "ok": ok(value) }),
        Err(e) => json!({ "err": e.to_json() }),
    }
}

/// `Buffer.from(text, "base64")` for every recorded input, the odd ones included.
#[test]
fn node_base64_is_decoded_as_node_decodes_it() {
    let file = load("file-backend");
    let cases = file["base64"].as_array().unwrap();
    assert!(cases.len() >= 30);
    for case in cases {
        let (input, want) = (case[0].as_str().unwrap(), case[1].as_str().unwrap());
        assert_eq!(hex(&node_base64_decode(input)), want, "{input:?}");
    }
}

/// Every step of every scenario against a real directory, with the recorded random draws: the answer, what was handed
/// to `register`, how many bytes were drawn, and the text of `store.json` and `store.key` afterwards, byte for byte.
///
/// One projection: TypeScript's `describe` returns the stored entry without its ciphertext, so a member this version does
/// not know rides along in the answer. The Rust answer is a `SecretMeta`; the replay compares its members.
#[test]
fn the_file_backend_replays_the_recorded_scenarios() {
    let file = load("file-backend");
    assert_eq!(file["schema"], json!(FILE_SCHEMA));
    assert_eq!(file["maxTombstones"], json!(MAX_TOMBSTONES));
    let mut bad = Vec::new();
    let mut total = 0;
    for scenario in file["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("secrets");
        let draws: Arc<Mutex<VecDeque<Vec<u8>>>> = Arc::default();
        let script = draws.clone();
        let mut backend = FileBackend::new(&dir).with_random(Box::new(move |out| {
            let next = script
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| io::Error::other("a draw the recording does not have"))?;
            if next.len() != out.len() {
                return Err(io::Error::other("a draw of another length"));
            }
            out.copy_from_slice(&next);
            Ok(())
        }));
        if let Some(max) = scenario.get("maxTombstones").and_then(Value::as_u64) {
            backend = backend.with_max_tombstones(max as usize);
        }
        for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            total += 1;
            *draws.lock().unwrap() = step["draws"]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| unhex(d.as_str().unwrap()))
                .collect();
            let op = step["op"].as_array().unwrap();
            let text = |n: usize| op[n].as_str().unwrap();
            let ms = |n: usize| op[n].as_f64().map(|v| v as i64);
            let mut registered: Vec<String> = Vec::new();
            let mut want = step["result"].clone();
            let got = match text(0) {
                "probe" => outcome(backend.probe(), |p| match p.reason {
                    Some(reason) => json!({ "available": p.available, "reason": reason }),
                    None => json!({ "available": p.available }),
                }),
                "get" => outcome(backend.get(text(1)), |value| json!(value)),
                "list" => outcome(backend.list(), |metas| {
                    Value::Array(metas.iter().map(SecretMeta::to_json).collect())
                }),
                "tombstones" => outcome(backend.tombstones().unwrap(), |t| json!(t)),
                "clear" => outcome(backend.clear_tombstone(text(1)).unwrap(), |()| Value::Null),
                "put" => {
                    let mut register = |value: &str| registered.push(value.to_owned());
                    outcome(
                        backend.put(
                            text(1),
                            text(2),
                            ms(3).unwrap(),
                            op[4].as_str(),
                            op[5].as_str(),
                            Some(&mut register),
                        ),
                        |meta| meta.to_json(),
                    )
                }
                "describe" => {
                    if let Some(answer) = want.get_mut("ok").and_then(Value::as_object_mut) {
                        answer.retain(|key, _| {
                            [
                                "name",
                                "backend",
                                "createdAt",
                                "updatedAt",
                                "updatedBy",
                                "description",
                            ]
                            .contains(&key.as_str())
                        });
                    }
                    let mut register = |value: &str| registered.push(value.to_owned());
                    outcome(
                        backend.describe(
                            text(1),
                            text(2),
                            ms(3).unwrap(),
                            op[4].as_str(),
                            Some(&mut register),
                        ),
                        |meta| meta.to_json(),
                    )
                }
                "delete" => outcome(backend.delete(text(1), ms(2)), |removed| json!(removed)),
                "seed" => {
                    std::fs::create_dir_all(&dir).unwrap();
                    for (which, path) in [("store", "store.json"), ("key", "store.key")] {
                        match op[1].get(which) {
                            Some(Value::String(content)) => {
                                std::fs::write(dir.join(path), content).unwrap();
                            }
                            Some(Value::Null) => {
                                let _ = std::fs::remove_file(dir.join(path));
                            }
                            _ => {}
                        }
                    }
                    json!({ "ok": null })
                }
                other => panic!("{name}: unknown step {other}"),
            };
            let on_disk = |path: &str| match std::fs::read_to_string(dir.join(path)) {
                Ok(content) => Value::String(content),
                Err(_) => Value::Null,
            };
            let left = draws.lock().unwrap().len();
            let mut differs = Vec::new();
            if got != want {
                differs.push(format!("answer {got} (recorded {want})"));
            }
            if json!(registered) != step["registered"] {
                differs.push(format!(
                    "registered {} values (recorded {})",
                    registered.len(),
                    step["registered"].as_array().map_or(0, Vec::len)
                ));
            }
            if left != 0 {
                differs.push(format!("{left} recorded draw(s) not taken"));
            }
            for (path, key) in [("store.json", "store"), ("store.key", "key")] {
                if on_disk(path) != step[key] {
                    differs.push(format!(
                        "{path} is {} (recorded {})",
                        on_disk(path),
                        step[key]
                    ));
                }
            }
            if !differs.is_empty() {
                bad.push(format!(
                    "{name} step {i} {}: {}",
                    step["op"],
                    differs.join("; ")
                ));
            }
        }
    }
    assert!(total > 350, "the grid shrank: {total} steps");
    assert!(
        bad.is_empty(),
        "{} of {total} steps differ:\n{}",
        bad.len(),
        bad.iter()
            .take(4)
            .map(|line| line.chars().take(1500).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// What the vectors cannot hold: the modes of the directory and the files, and that no temporary file stays behind.
#[cfg(unix)]
#[test]
fn the_file_backend_keeps_its_files_private_and_leaves_no_temporary_file() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("state").join("secrets");
    let mut backend = FileBackend::new(&dir);
    let mode =
        |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    backend
        .put("api", "a value in plain words", 0, None, None, None)
        .unwrap();
    assert_eq!(mode(&dir), 0o700);
    assert_eq!(mode(&dir.join("store.json")), 0o600);
    assert_eq!(mode(&dir.join("store.key")), 0o600);
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, ["store.json", "store.key"]);
    // Two writes of one value do not share a nonce, and the value is nowhere on disk.
    let first = std::fs::read_to_string(dir.join("store.json")).unwrap();
    backend
        .put("api", "a value in plain words", 0, None, None, None)
        .unwrap();
    let second = std::fs::read_to_string(dir.join("store.json")).unwrap();
    assert_ne!(first, second);
    assert!(!second.contains("plain words"));
    assert_eq!(
        backend.get("api").unwrap().as_deref(),
        Some("a value in plain words")
    );
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
}
