//! Replay of the vectors recorded from the stateful parts of the TypeScript secret store
//! (`scripts/parity/export-secrets-store.ts`, `fixtures/parity/secrets-store/*.json`). Recorded, never edited by hand.
use super::audit::DetailValue;
use super::backend::SecretBackend;
use super::error::{SecretError, SecretErrorCode};
use super::file_backend::{node_base64_decode, FileBackend, FILE_SCHEMA, MAX_TOMBSTONES};
use super::leases::{IssueOptions, Lease};
use super::memory_backend::MemoryBackend;
use super::store::{
    parse_iso_ms, AuditEvent, AuditSink, SecretStore, SecretStoreLogger, SecretStoreOptions,
    StartupOptions,
};
use super::types::{BackendKind, BackendProbe, SecretMeta, SecretPrincipal};
use crate::identity::codes::RandomSource;
use crate::logs::redact::{SecretSet, MAX_REGISTERED_SECRETS};
use crate::rbac::surface::SurfaceTrustLevel;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
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

// --- store -------------------------------------------------------------------------------------------------------------------

/// What a scenario switches and what it collects, shared with the backends, the sink, the logger and the hooks.
#[derive(Default)]
struct Control {
    /// `"<which>.<operation>"` -> `storage` or `outage`: the next such call fails.
    fail: HashMap<String, String>,
    keyring_available: bool,
    audit_fails: bool,
    audit: Vec<Value>,
    logs: Vec<Value>,
    changes: Vec<String>,
    marks: Vec<String>,
}

type Ctl = Arc<Mutex<Control>>;

/// A backend the scenario can make fail, as the exporter's `wrap` does. `outage` is the way a helper process dies: the
/// store is told (the flag) and the call is `backend-unavailable`.
struct Wrapped<B> {
    inner: Arc<Mutex<B>>,
    which: &'static str,
    ctl: Ctl,
    signal: Arc<AtomicBool>,
    /// The memory backend follows the scenario's `keyring` switch and has no tombstones.
    sync: fn(&mut B, &Control),
    tombstones: bool,
}

impl<B: SecretBackend> Wrapped<B> {
    fn call<T>(
        &mut self,
        operation: &str,
        run: impl FnOnce(&mut B) -> Result<T, SecretError>,
    ) -> Result<T, SecretError> {
        let mode = {
            let mut ctl = self.ctl.lock().unwrap();
            let mode = ctl.fail.remove(&format!("{}.{operation}", self.which));
            (self.sync)(&mut self.inner.lock().unwrap(), &ctl);
            mode
        };
        match mode.as_deref() {
            Some("outage") => {
                self.signal.store(true, Ordering::SeqCst);
                Err(SecretError::new(
                    SecretErrorCode::BackendUnavailable,
                    "the helper went away",
                ))
            }
            Some(_) => Err(SecretError::with_detail(
                SecretErrorCode::Storage,
                "injected failure (EIO)",
                json!({ "cause": "EIO" }),
            )),
            None => run(&mut self.inner.lock().unwrap()),
        }
    }
}

impl<B: SecretBackend> SecretBackend for Wrapped<B> {
    fn kind(&self) -> BackendKind {
        self.inner.lock().unwrap().kind()
    }
    fn probe(&mut self) -> Result<BackendProbe, SecretError> {
        self.call("probe", |b| b.probe())
    }
    fn get(&mut self, name: &str) -> Result<Option<String>, SecretError> {
        self.call("get", |b| b.get(name))
    }
    fn put(
        &mut self,
        name: &str,
        value: &str,
        now_ms: i64,
        updated_by: Option<&str>,
        description: Option<&str>,
        register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, SecretError> {
        self.call("put", |b| {
            b.put(name, value, now_ms, updated_by, description, register)
        })
    }
    fn describe(
        &mut self,
        name: &str,
        description: &str,
        now_ms: i64,
        updated_by: Option<&str>,
        register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, SecretError> {
        self.call("describe", |b| {
            b.describe(name, description, now_ms, updated_by, register)
        })
    }
    fn delete(&mut self, name: &str, tombstone_at_ms: Option<i64>) -> Result<bool, SecretError> {
        self.call("delete", |b| b.delete(name, tombstone_at_ms))
    }
    fn tombstones(&mut self) -> Option<Result<BTreeMap<String, String>, SecretError>> {
        self.tombstones.then(|| {
            self.call("tombstones", |b| {
                b.tombstones().unwrap_or_else(|| Ok(BTreeMap::new()))
            })
        })
    }
    fn clear_tombstone(&mut self, name: &str) -> Option<Result<(), SecretError>> {
        self.tombstones.then(|| {
            self.call("clearTombstone", |b| {
                b.clear_tombstone(name).unwrap_or(Ok(()))
            })
        })
    }
    fn list(&mut self) -> Result<Vec<SecretMeta>, SecretError> {
        self.call("list", |b| b.list())
    }
}

struct RecordingSink(Ctl);

impl AuditSink for RecordingSink {
    fn record(&mut self, event: &AuditEvent) -> Result<(), SecretError> {
        let mut ctl = self.0.lock().unwrap();
        if ctl.audit_fails {
            return Err(SecretError::audit_unavailable());
        }
        let detail: serde_json::Map<String, Value> = event
            .detail
            .iter()
            .filter_map(|(key, value)| {
                let value = match value {
                    DetailValue::Str(units) => Value::String(String::from_utf16_lossy(units)),
                    DetailValue::Num(n) => Value::Number(n.clone()),
                    DetailValue::Bool(b) => Value::Bool(*b),
                    DetailValue::Other => return None,
                };
                Some((key.clone(), value))
            })
            .collect();
        ctl.audit.push(json!({
            "action": event.action.as_str(), "target": event.target,
            "principal": principal_json(&event.principal), "detail": detail,
        }));
        Ok(())
    }
}

struct RecordingLogger(Ctl);

impl RecordingLogger {
    fn line(&self, level: &str, message: &str, fields: &Value) {
        self.0
            .lock()
            .unwrap()
            .logs
            .push(json!([level, message, fields]));
    }
}

impl SecretStoreLogger for RecordingLogger {
    fn debug(&self, message: &str, fields: Value) {
        self.line("debug", message, &fields);
    }
    fn info(&self, message: &str, fields: Value) {
        self.line("info", message, &fields);
    }
    fn warn(&self, message: &str, fields: Value) {
        self.line("warn", message, &fields);
    }
}

/// The lease ids the TypeScript run drew, in order.
struct ScriptedIds(Arc<Mutex<VecDeque<Vec<u8>>>>);

impl RandomSource for ScriptedIds {
    fn random_int(&mut self, _max: u32) -> u32 {
        panic!("the store draws no integers")
    }
    fn fill_bytes(&mut self, out: &mut [u8]) {
        let next = self
            .0
            .lock()
            .unwrap()
            .pop_front()
            .expect("an id the recording has");
        out.copy_from_slice(&next);
    }
}

fn principal_of(v: &Value) -> SecretPrincipal {
    let text = |key: &str| v.get(key).and_then(Value::as_str).map(str::to_owned);
    match v["kind"].as_str().unwrap() {
        "owner" => SecretPrincipal::Owner {
            id: text("id"),
            surface: v
                .get("surface")
                .and_then(Value::as_f64)
                .map(|n| SurfaceTrustLevel::from_f64(n).unwrap()),
        },
        "core" => SecretPrincipal::Core,
        "agent" => SecretPrincipal::Agent {
            agent_id: text("agentId"),
        },
        other => panic!("a principal of kind {other}"),
    }
}

fn principal_json(p: &SecretPrincipal) -> Value {
    let mut out = serde_json::Map::new();
    match p {
        SecretPrincipal::Owner { id, surface } => {
            out.insert("kind".into(), json!("owner"));
            if let Some(id) = id {
                out.insert("id".into(), json!(id));
            }
            if let Some(surface) = surface {
                out.insert("surface".into(), json!(surface.as_u8()));
            }
        }
        SecretPrincipal::Core => {
            out.insert("kind".into(), json!("core"));
        }
        SecretPrincipal::Agent { agent_id } => {
            out.insert("kind".into(), json!("agent"));
            if let Some(id) = agent_id {
                out.insert("agentId".into(), json!(id));
            }
        }
    }
    Value::Object(out)
}

fn lease_json(lease: &Lease) -> Value {
    json!({
        "leaseId": lease.lease_id, "name": lease.name, "value": lease.value, "expiresAt": lease.expires_at,
        "purpose": lease.purpose, "profileId": lease.profile_id,
    })
}

/// `Date.parse` for the timestamps a backend can hold, as V8 reads them.
#[test]
fn timestamps_are_parsed_as_date_parse_parses_them() {
    let file = load("store");
    let cases = file["dates"].as_array().unwrap();
    assert!(cases.len() >= 25);
    for case in cases {
        let text = case[0].as_str().unwrap();
        assert_eq!(json!(parse_iso_ms(text)), case[1], "{text:?}");
    }
}

/// Every step of every scenario against the store, over the memory backend in the keyring's place and the real file
/// backend: the answer, the audit records, the log lines, the change notifications, the lifecycle hooks, the start-up
/// status, the registry's values, the keyring's content and the text of `store.json`.
#[test]
fn the_store_replays_the_recorded_scenarios() {
    let file = load("store");
    let mut bad = Vec::new();
    let mut total = 0;
    for scenario in file["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("secrets");
        let ctl: Ctl = Arc::new(Mutex::new(Control {
            keyring_available: scenario["keyring"].as_bool().unwrap(),
            ..Control::default()
        }));
        let fallback = Arc::new(AtomicBool::new(scenario["fallback"].as_bool().unwrap()));
        let now = Arc::new(AtomicI64::new(1_767_323_045_678));
        let mono = Arc::new(AtomicI64::new(1000));
        let signal = Arc::new(AtomicBool::new(false));
        let draws: Arc<Mutex<VecDeque<Vec<u8>>>> = Arc::default();
        let ids: Arc<Mutex<VecDeque<Vec<u8>>>> = Arc::default();
        let memory = Arc::new(Mutex::new(MemoryBackend::new(true)));
        let script = draws.clone();
        let disk = Arc::new(Mutex::new(FileBackend::new(&dir).with_random(Box::new(
            move |out| {
                let next = script
                    .lock()
                    .unwrap()
                    .pop_front()
                    .ok_or_else(|| io::Error::other("a draw the recording does not have"))?;
                out.copy_from_slice(&next);
                Ok(())
            },
        ))));
        let redaction = Arc::new(SecretSet::new());
        let (clock, monotonic, enabled) = (now.clone(), mono.clone(), fallback.clone());
        let (cancelled, closed) = (ctl.clone(), ctl.clone());
        let store = SecretStore::new(SecretStoreOptions {
            keyring: Box::new(Wrapped {
                inner: memory.clone(),
                which: "keyring",
                ctl: ctl.clone(),
                signal: signal.clone(),
                sync: |backend: &mut MemoryBackend, ctl| backend.available = ctl.keyring_available,
                tombstones: false,
            }),
            file: Box::new(Wrapped {
                inner: disk.clone(),
                which: "file",
                ctl: ctl.clone(),
                signal: signal.clone(),
                sync: |_, _| {},
                tombstones: true,
            }),
            file_fallback: Box::new(move || enabled.load(Ordering::SeqCst)),
            audit: Box::new(RecordingSink(ctl.clone())),
            clock: Arc::new(move || clock.load(Ordering::SeqCst)),
            monotonic: Box::new(move || monotonic.load(Ordering::SeqCst) as f64),
            random: Box::new(ScriptedIds(ids.clone())),
            logger: Some(Box::new(RecordingLogger(ctl.clone()))),
            redaction: redaction.clone(),
            startup: StartupOptions {
                budget_ms: 3000.0,
                retry_after_ms: 30_000.0,
                unavailable: signal.clone(),
                cancel: Some(Box::new(move || {
                    cancelled.lock().unwrap().marks.push("cancel".into());
                })),
                close: Some(Box::new(move || {
                    closed.lock().unwrap().marks.push("close".into());
                })),
            },
        });
        let heard = ctl.clone();
        store.on_change(Box::new(move |changed| {
            heard.lock().unwrap().changes.push(changed.to_owned());
        }));
        // What a step does not record is what the step before it recorded.
        let mut last: HashMap<&str, Value> = HashMap::new();
        for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            total += 1;
            {
                let mut ctl = ctl.lock().unwrap();
                ctl.audit.clear();
                ctl.logs.clear();
                ctl.changes.clear();
                ctl.marks.clear();
            }
            let queue = |key: &str| -> VecDeque<Vec<u8>> {
                step[key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|d| unhex(d.as_str().unwrap()))
                    .collect()
            };
            *draws.lock().unwrap() = queue("draws");
            *ids.lock().unwrap() = queue("ids");
            let op = step["op"].as_array().unwrap();
            let text = |n: usize| op[n].as_str().unwrap();
            let p = || principal_of(&op[1]);
            let meta = |m: SecretMeta| m.to_json();
            let got = match text(0) {
                "status" => outcome(store.status(&p()), |s| s.to_json()),
                "list" => outcome(store.list(&p()), |l| {
                    Value::Array(l.iter().map(SecretMeta::to_json).collect())
                }),
                "meta" => outcome(store.meta(&p(), text(2)), meta),
                "reveal" => outcome(
                    store.reveal(&p(), text(2)),
                    |(m, value)| json!({ "meta": m.to_json(), "value": value }),
                ),
                "delete" => outcome(store.delete(&p(), text(2)), |()| json!({ "removed": true })),
                "describe" => outcome(store.describe(&p(), text(2), text(3)), meta),
                "set" => outcome(store.set(&p(), text(2), text(3), op[4].as_str()), meta),
                "lease" => outcome(
                    store.lease(
                        &p(),
                        text(2),
                        IssueOptions {
                            purpose: text(3),
                            profile_id: text(4),
                            ttl_ms: op[5].as_f64(),
                        },
                    ),
                    |l| lease_json(&l),
                ),
                "readLease" => outcome(store.read_lease(&p(), text(2)), |l| lease_json(&l)),
                "revokeLease" => outcome(store.revoke_lease(&p(), text(2)), |b| json!(b)),
                "activeLeases" => outcome(store.active_leases(&p()), |list| {
                    Value::Array(
                        list.iter()
                            .map(|l| {
                                json!({
                                    "leaseId": l.lease_id, "name": l.name, "expiresAt": l.expires_at,
                                    "purpose": l.purpose, "profileId": l.profile_id,
                                })
                            })
                            .collect(),
                    )
                }),
                "raw" => {
                    let ms = |n: usize| op[n].as_f64().map(|v| v as i64);
                    let run = |backend: &mut dyn SecretBackend| match text(2) {
                        "put" => backend
                            .put(
                                text(3),
                                text(4),
                                ms(5).unwrap(),
                                op[6].as_str(),
                                op[7].as_str(),
                                None,
                            )
                            .map(|_| ()),
                        _ => backend.delete(text(3), ms(4)).map(|_| ()),
                    };
                    let done = if text(1) == "keyring" {
                        let mut backend = memory.lock().unwrap();
                        backend.available = ctl.lock().unwrap().keyring_available;
                        run(&mut *backend)
                    } else {
                        run(&mut *disk.lock().unwrap())
                    };
                    outcome(done, |()| Value::Null)
                }
                other => {
                    match other {
                        "preload" => store.preload_redaction(),
                        "unavailable" => store.backend_unavailable(),
                        "close" => store.close(),
                        "startup" => {}
                        "keyring" => {
                            ctl.lock().unwrap().keyring_available = op[1].as_bool().unwrap();
                        }
                        "fallback" => fallback.store(op[1].as_bool().unwrap(), Ordering::SeqCst),
                        "auditFails" => ctl.lock().unwrap().audit_fails = op[1].as_bool().unwrap(),
                        "tick" => {
                            let by = op[1].as_i64().unwrap();
                            now.fetch_add(by, Ordering::SeqCst);
                            mono.fetch_add(by, Ordering::SeqCst);
                        }
                        "fail" => {
                            ctl.lock()
                                .unwrap()
                                .fail
                                .insert(format!("{}.{}", text(1), text(2)), text(3).to_owned());
                        }
                        unknown => panic!("{name}: unknown step {unknown}"),
                    }
                    json!({ "ok": null })
                }
            };
            let collected = {
                let ctl = ctl.lock().unwrap();
                [
                    ("audit", Value::Array(ctl.audit.clone())),
                    ("logs", Value::Array(ctl.logs.clone())),
                    ("changes", json!(ctl.changes)),
                    ("marks", json!(ctl.marks)),
                ]
            };
            let state = [
                ("startup", store.startup_status().to_json()),
                ("values", json!(redaction.values())),
                (
                    "keyring",
                    Value::Array(
                        memory
                            .lock()
                            .unwrap()
                            .dump()
                            .into_iter()
                            .map(|(n, v)| json!([n, v]))
                            .collect(),
                    ),
                ),
                (
                    "store",
                    match std::fs::read_to_string(dir.join("store.json")) {
                        Ok(content) => Value::String(content),
                        Err(_) => Value::Null,
                    },
                ),
            ];
            let mut differs = Vec::new();
            if got != step["result"] {
                differs.push(format!("answer {got} (recorded {})", step["result"]));
            }
            for (key, value) in collected {
                if value != step[key] {
                    differs.push(format!("{key} {value} (recorded {})", step[key]));
                }
            }
            for (key, value) in state {
                if let Some(recorded) = step.get(key) {
                    last.insert(key, recorded.clone());
                }
                if Some(&value) != last.get(key) {
                    differs.push(format!(
                        "{key} {value} (recorded {})",
                        last.get(key).unwrap_or(&Value::Null)
                    ));
                }
            }
            let left = draws.lock().unwrap().len() + ids.lock().unwrap().len();
            if left != 0 {
                differs.push(format!("{left} recorded draw(s) not taken"));
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
    assert!(total > 400, "the grid shrank: {total} steps");
    assert!(
        bad.is_empty(),
        "{} of {total} steps differ:\n{}",
        bad.len(),
        bad.iter()
            .take(4)
            .map(|line| line.chars().take(1800).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    );
}

// --- what the vectors cannot hold ----------------------------------------------------------------------------------------------

struct NoAudit;

impl AuditSink for NoAudit {
    fn record(&mut self, _event: &AuditEvent) -> Result<(), SecretError> {
        Ok(())
    }
}

/// A backend that takes its time: every call moves the monotonic clock on by `step` milliseconds.
struct Slow {
    inner: MemoryBackend,
    mono: Arc<AtomicI64>,
    step: Arc<AtomicI64>,
}

impl Slow {
    fn wait(&self) {
        self.mono
            .fetch_add(self.step.load(Ordering::SeqCst), Ordering::SeqCst);
    }
}

impl SecretBackend for Slow {
    fn kind(&self) -> BackendKind {
        BackendKind::Memory
    }
    fn probe(&mut self) -> Result<BackendProbe, SecretError> {
        self.wait();
        self.inner.probe()
    }
    fn get(&mut self, name: &str) -> Result<Option<String>, SecretError> {
        self.wait();
        self.inner.get(name)
    }
    fn put(
        &mut self,
        name: &str,
        value: &str,
        now_ms: i64,
        updated_by: Option<&str>,
        description: Option<&str>,
        register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, SecretError> {
        self.wait();
        self.inner
            .put(name, value, now_ms, updated_by, description, register)
    }
    fn describe(
        &mut self,
        name: &str,
        description: &str,
        now_ms: i64,
        updated_by: Option<&str>,
        register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, SecretError> {
        self.wait();
        self.inner
            .describe(name, description, now_ms, updated_by, register)
    }
    fn delete(&mut self, name: &str, tombstone_at_ms: Option<i64>) -> Result<bool, SecretError> {
        self.wait();
        self.inner.delete(name, tombstone_at_ms)
    }
    fn list(&mut self) -> Result<Vec<SecretMeta>, SecretError> {
        self.wait();
        self.inner.list()
    }
}

fn store_over(
    keyring: Box<dyn SecretBackend + Send>,
    mono: Arc<AtomicI64>,
    cancelled: Arc<AtomicI64>,
) -> SecretStore {
    SecretStore::new(SecretStoreOptions {
        keyring,
        file: Box::new(MemoryBackend::new(false)),
        file_fallback: Box::new(|| false),
        audit: Box::new(NoAudit),
        clock: Arc::new(|| 1_767_323_045_678),
        monotonic: Box::new(move || mono.load(Ordering::SeqCst) as f64),
        random: Box::new(ScriptedIds(Arc::new(Mutex::new(VecDeque::from([
            vec![1_u8; 16],
            vec![2_u8; 16],
        ]))))),
        logger: None,
        redaction: Arc::new(SecretSet::new()),
        startup: StartupOptions {
            cancel: Some(Box::new(move || {
                cancelled.fetch_add(1, Ordering::SeqCst);
            })),
            ..StartupOptions::default()
        },
    })
}

const OWNER_HERE: SecretPrincipal = SecretPrincipal::Owner {
    id: None,
    surface: None,
};

/// One deadline covers the probe, the list and every read of a preload. A preload that runs out of its budget leaves the
/// store unavailable as `startup-timeout`: the values it had read are not registered, nothing is safe to flush, the helpers
/// are retired, and the next attempt waits for the retry.
#[test]
fn a_preload_that_runs_out_of_its_budget_registers_nothing() {
    let (mono, step, cancelled) = (
        Arc::new(AtomicI64::new(0)),
        Arc::new(AtomicI64::new(1200)),
        Arc::new(AtomicI64::new(0)),
    );
    let mut inner = MemoryBackend::new(true);
    for name in ["first", "second", "third"] {
        inner
            .put(
                name,
                &format!("the value of {name} in words"),
                0,
                None,
                None,
                None,
            )
            .unwrap();
    }
    let store = store_over(
        Box::new(Slow {
            inner,
            mono: mono.clone(),
            step: step.clone(),
        }),
        mono.clone(),
        cancelled.clone(),
    );
    // probe 1200, list 2400, first read 3600: the second read is past the 3000 ms.
    store.preload_redaction();
    assert_eq!(
        store.startup_status().to_json(),
        json!({ "state": "unavailable", "reason": "startup-timeout", "safeToFlush": false })
    );
    assert!(store.redaction().values().is_empty());
    assert_eq!(cancelled.load(Ordering::SeqCst), 1);
    let refused = store.reveal(&OWNER_HERE, "first").unwrap_err();
    assert_eq!(
        refused.to_json()["message"],
        json!("Secret-Store unavailable")
    );
    // Before the retry is due nothing is tried again, however fast the backend is now.
    step.store(0, Ordering::SeqCst);
    store.preload_redaction();
    assert_eq!(store.startup_status().state.as_str(), "unavailable");
    mono.fetch_add(30_000, Ordering::SeqCst);
    store.preload_redaction();
    assert_eq!(
        store.startup_status().to_json(),
        json!({ "state": "ready", "safeToFlush": true })
    );
    assert_eq!(store.redaction().values().len(), 3);
    assert_eq!(
        store.reveal(&OWNER_HERE, "first").unwrap().1,
        "the value of first in words"
    );
}

/// A change listener runs after the store's lock is released: it may call the store, and it hears the names in the order
/// the changes were committed, from whichever thread made them.
#[test]
fn a_change_listener_may_call_the_store_and_the_store_is_shared_between_threads() {
    fn shared<T: Send + Sync>() {}
    shared::<SecretStore>();
    let store = Arc::new(store_over(
        Box::new(MemoryBackend::new(true)),
        Arc::new(AtomicI64::new(0)),
        Arc::new(AtomicI64::new(0)),
    ));
    let heard: Arc<Mutex<Vec<String>>> = Arc::default();
    let (inside, log) = (Arc::downgrade(&store), heard.clone());
    let id = store.on_change(Box::new(move |name| {
        let store = inside.upgrade().unwrap();
        let seen = store.meta(&OWNER_HERE, name).map(|m| m.name);
        log.lock().unwrap().push(format!(
            "{name}:{}",
            if seen.is_ok() { "there" } else { "gone" }
        ));
    }));
    let writer = store.clone();
    std::thread::spawn(move || {
        writer
            .set(&OWNER_HERE, "api", "a value in plain words", None)
            .unwrap();
    })
    .join()
    .unwrap();
    store.delete(&OWNER_HERE, "api").unwrap();
    assert!(store.delete(&OWNER_HERE, "api").is_err());
    store.remove_listener(id);
    store
        .set(&OWNER_HERE, "api", "another value in words", None)
        .unwrap();
    assert_eq!(*heard.lock().unwrap(), ["api:there", "api:gone"]);
}
