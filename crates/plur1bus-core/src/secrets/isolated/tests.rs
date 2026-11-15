//! The helper's two sides against each other, in one process: the server runs on a thread behind two in-memory pipes, so
//! every way a helper can fail is scripted (it hangs, ends, cannot be started, writes no frame). The real executable is
//! covered by `tests/secrets_helper.rs`.
use super::client::{
    isolated_backend, HelperControl, HelperProcess, IsolatedBackend, IsolatedHandle,
    IsolatedOptions, SpawnHelper,
};
use super::protocol::{
    encode_frame, operation_failed, read_frame, store_unavailable, unknown_operation,
    BackendDescription, Operation, MAX_FRAME_BYTES, PROTOCOL,
};
use super::server::serve;
use crate::secrets::backend::SecretBackend;
use crate::secrets::error::{SecretError, SecretErrorCode};
use crate::secrets::file_backend::FileBackend;
use crate::secrets::keyring_backend::KeyringBackend;
use crate::secrets::keyring_vectors as recorded;
use crate::secrets::memory_backend::MemoryBackend;
use crate::secrets::types::{BackendKind, BackendProbe, SecretMeta};
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

// --- two in-memory pipes -----------------------------------------------------------------------------------------------

/// The writing end; `cut` makes the reading end see the end of the stream (a killed helper's output).
#[derive(Clone)]
struct PipeWriter(Arc<Mutex<Option<Sender<Vec<u8>>>>>);

impl PipeWriter {
    fn cut(&self) {
        self.0.lock().unwrap().take();
    }
}

impl Write for PipeWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        match &*self.0.lock().unwrap() {
            Some(chunks) if chunks.send(bytes.to_vec()).is_ok() => Ok(bytes.len()),
            _ => Err(io::ErrorKind::BrokenPipe.into()),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct PipeReader {
    chunks: Receiver<Vec<u8>>,
    rest: Vec<u8>,
    at: usize,
}

impl Read for PipeReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.at == self.rest.len() {
            match self.chunks.recv() {
                Ok(chunk) => (self.rest, self.at) = (chunk, 0),
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.rest.len() - self.at);
        out[..n].copy_from_slice(&self.rest[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

fn pipe() -> (PipeWriter, PipeReader) {
    let (chunks, receiver) = mpsc::channel();
    (
        PipeWriter(Arc::new(Mutex::new(Some(chunks)))),
        PipeReader {
            chunks: receiver,
            rest: Vec::new(),
            at: 0,
        },
    )
}

// --- a helper on a thread ----------------------------------------------------------------------------------------------

/// What the test sees of the helpers: how many were started and killed, and the flag the store would read.
#[derive(Clone, Default)]
struct Seen {
    started: Arc<AtomicUsize>,
    killed: Arc<AtomicUsize>,
    unavailable: Arc<AtomicBool>,
}

impl Seen {
    fn started(&self) -> usize {
        self.started.load(Ordering::SeqCst)
    }

    fn killed(&self) -> usize {
        self.killed.load(Ordering::SeqCst)
    }

    /// Reads the flag and lowers it, as the store does.
    fn told(&self) -> bool {
        self.unavailable.swap(false, Ordering::SeqCst)
    }

    /// Waits until `what` holds; false when it does not within two seconds.
    fn until(&self, what: impl Fn(&Seen) -> bool) -> bool {
        let started = Instant::now();
        while !what(self) {
            if started.elapsed() > Duration::from_secs(2) {
                return false;
            }
            thread::sleep(Duration::from_millis(2));
        }
        true
    }
}

struct Control {
    output: PipeWriter,
    killed: Arc<AtomicUsize>,
    dead: bool,
}

impl HelperControl for Control {
    fn kill(&mut self) {
        if !self.dead {
            self.killed.fetch_add(1, Ordering::SeqCst);
        }
        self.dead = true;
        self.output.cut();
    }

    fn exited(&mut self) -> bool {
        self.dead
    }
}

/// What a helper does with its two pipes; the number is which helper it is (the first is 1).
type Body = Arc<dyn Fn(usize, PipeReader, PipeWriter) + Send + Sync>;

/// A backend whose helpers run `body` on a thread.
fn lab(
    description: BackendDescription,
    budget_ms: u64,
    body: Body,
) -> (IsolatedBackend, IsolatedHandle, Seen) {
    let seen = Seen::default();
    let counted = seen.clone();
    let spawn: SpawnHelper = Box::new(move |_| {
        let nth = counted.started.fetch_add(1, Ordering::SeqCst) + 1;
        let (input, requests) = pipe();
        let (replies, output) = pipe();
        let control = Control {
            output: replies.clone(),
            killed: counted.killed.clone(),
            dead: false,
        };
        let body = body.clone();
        thread::spawn(move || body(nth, requests, replies));
        Ok(HelperProcess {
            input: Box::new(input),
            output: Box::new(output),
            control: Box::new(control),
        })
    });
    let (backend, handle) = isolated_backend(
        description,
        IsolatedOptions {
            budget: Duration::from_millis(budget_ms),
            spawn,
            unavailable: seen.unavailable.clone(),
        },
    );
    (backend, handle, seen)
}

/// A helper that serves the backend `create` makes.
fn serving(
    create: impl Fn(&BackendDescription) -> Box<dyn SecretBackend> + Send + Sync + 'static,
) -> Body {
    Arc::new(move |_, requests, replies| {
        let _ = serve(requests, replies, &create);
    })
}

/// A helper that reads and never answers.
fn silent(_: usize, mut requests: PipeReader, _replies: PipeWriter) {
    while let Ok(Some(_)) = read_frame(&mut requests) {}
}

fn file_in(dir: &std::path::Path) -> BackendDescription {
    BackendDescription::File {
        dir: dir.to_str().unwrap().to_owned(),
    }
}

/// Random draws that count: draw k is the bytes `16k, 16k + 1, ...`, the same in every backend that starts from zero.
fn counting() -> crate::secrets::file_backend::RandomBytes {
    let mut drawn = 0usize;
    Box::new(move |out| {
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = ((drawn * 16 + i) & 0xff) as u8;
        }
        drawn += 1;
        Ok(())
    })
}

fn outcome<T>(result: Result<T, SecretError>, ok: impl FnOnce(T) -> Value) -> Value {
    match result {
        Ok(value) => json!({ "ok": ok(value) }),
        Err(e) => json!({ "err": e.to_json() }),
    }
}

/// One of the operations below against a backend: the answer and what was registered.
fn apply(backend: &mut dyn SecretBackend, op: &Value) -> (Value, Vec<String>) {
    let text = |n: usize| op[n].as_str().unwrap();
    let mut registered = Vec::new();
    let mut register = |value: &str| registered.push(value.to_owned());
    let answer = match text(0) {
        "probe" => outcome(
            backend.probe(),
            |probe| json!({ "available": probe.available, "reason": probe.reason }),
        ),
        "get" => outcome(backend.get(text(1)), |v| json!(v)),
        "list" => outcome(backend.list(), |metas| {
            Value::Array(metas.iter().map(SecretMeta::to_json).collect())
        }),
        "put" => outcome(
            backend.put(
                text(1),
                text(2),
                op[3].as_i64().unwrap(),
                op[4].as_str(),
                op[5].as_str(),
                Some(&mut register),
            ),
            |meta| meta.to_json(),
        ),
        "describe" => outcome(
            backend.describe(
                text(1),
                text(2),
                op[3].as_i64().unwrap(),
                op[4].as_str(),
                Some(&mut register),
            ),
            |meta| meta.to_json(),
        ),
        "delete" => outcome(backend.delete(text(1), op[2].as_i64()), |removed| {
            json!(removed)
        }),
        "tombstones" => match backend.tombstones() {
            Some(tombstones) => outcome(tombstones, |t| json!(t)),
            None => json!("not supported"),
        },
        "clear" => match backend.clear_tombstone(text(1)) {
            Some(cleared) => outcome(cleared, |()| Value::Null),
            None => json!("not supported"),
        },
        other => panic!("unknown operation {other}"),
    };
    (answer, registered)
}

// --- the transport is faithful ------------------------------------------------------------------------------------------

/// The file backend behind a helper answers every operation as the file backend itself does, registers the same values
/// and, with the same random draws, writes the same bytes.
#[test]
fn every_operation_travels_to_the_helper_and_back() {
    const T0: i64 = 1_767_323_045_678;
    let (v1, v2) = (
        "the first value in plain words",
        "a second value after rotation",
    );
    let ops = json!([
        ["probe"],
        ["list"],
        ["get", "api"],
        ["tombstones"],
        ["put", "api", v1, T0, null, "what it is for"],
        ["put", "api", v2, T0 + 60_000, "owner:local", null],
        ["put", "other", v1, T0 + 120_000, null, null],
        ["put", "api", v1, T0, null, "value after rotation"],
        ["put", "late", v1, 8_640_000_000_000_001_i64, null, null],
        [
            "describe",
            "other",
            "  described  ",
            T0 + 180_000,
            "owner:local"
        ],
        ["describe", "absent", "a text", T0, null],
        ["describe", "other", v1, T0, null],
        ["get", "api"],
        ["get", "other"],
        ["list"],
        ["delete", "other", T0 + 240_000],
        ["delete", "other", T0 + 240_000],
        ["delete", "absent", null],
        ["tombstones"],
        ["clear", "other"],
        ["clear", "other"],
        ["tombstones"],
        ["list"],
        ["probe"],
    ]);
    let (direct_home, helper_home) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (direct_dir, helper_dir) = (
        direct_home.path().join("secrets"),
        helper_home.path().join("secrets"),
    );
    let mut direct = FileBackend::new(&direct_dir).with_random(counting());
    let (mut helped, handle, seen) = lab(
        file_in(&helper_dir),
        5000,
        serving(|description| {
            let BackendDescription::File { dir } = description else {
                panic!("the helper was asked for {description:?}");
            };
            Box::new(FileBackend::new(dir.as_str()).with_random(counting()))
        }),
    );
    assert_eq!(helped.kind(), BackendKind::File);
    assert_eq!(seen.started(), 0, "no helper before the first call");
    let mut refused = Vec::new();
    for op in ops.as_array().unwrap() {
        let want = apply(&mut direct, op);
        let got = apply(&mut helped, op);
        assert_eq!(got, want, "{op}");
        if let Some(code) = want.0["err"]["code"].as_str() {
            refused.push(code.to_owned());
        }
    }
    refused.sort();
    refused.dedup();
    assert_eq!(
        refused,
        ["invalid-description", "not-found", "storage"],
        "the refusals that travelled"
    );
    for file in ["store.json", "store.key"] {
        assert_eq!(
            std::fs::read_to_string(helper_dir.join(file)).unwrap(),
            std::fs::read_to_string(direct_dir.join(file)).unwrap(),
            "{file}"
        );
    }
    assert_eq!((seen.started(), seen.killed(), seen.told()), (1, 0, false));
    handle.close();
    assert_eq!(seen.killed(), 1);
}

/// The recorded keyring scenarios, with the backend behind a helper: every answer, every registered value, every call on
/// the keyring and every change in it are the recorded ones.
#[test]
fn the_keyring_backend_behind_a_helper_replays_the_recorded_scenarios() {
    let file = recorded::load();
    let service = file["service"].as_str().unwrap().to_owned();
    let mut total = 0;
    let mut bad = Vec::new();
    for scenario in file["scenarios"].as_array().unwrap() {
        if scenario.get("note").is_some() {
            continue;
        }
        let name = scenario["name"].as_str().unwrap();
        let fake = recorded::Fake::of(&service);
        let keyring = fake.clone();
        let (mut backend, _handle, seen) = lab(
            BackendDescription::Keyring {
                service: service.clone(),
            },
            5000,
            serving(move |description| {
                let BackendDescription::Keyring { service } = description else {
                    panic!("the helper was asked for {description:?}");
                };
                Box::new(KeyringBackend::new(
                    service.clone(),
                    Box::new(keyring.clone()),
                ))
            }),
        );
        assert_eq!(backend.kind(), BackendKind::Keyring);
        assert!(backend.tombstones().is_none() && backend.clear_tombstone("api").is_none());
        for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            total += 1;
            let got = recorded::run(&mut backend, &fake, &step["op"]);
            if got.answer != step["result"]
                || json!(got.registered) != step["registered"]
                || json!(got.calls) != step["calls"]
                || got.items != recorded::recorded_items(step)
            {
                bad.push(format!("{name} step {i} {}: {}", step["op"], got.answer));
            }
        }
        assert_eq!(
            (seen.started(), seen.killed(), seen.told()),
            (1, 0, false),
            "{name}"
        );
    }
    assert!(total > 250, "the grid shrank: {total} steps");
    assert!(
        bad.is_empty(),
        "{} of {total} steps differ:\n{}",
        bad.len(),
        bad[..bad.len().min(5)].join("\n")
    );
}

// --- a helper that fails -----------------------------------------------------------------------------------------------

/// A helper that does not answer within the budget is killed, the store is told, the call answers `backend-unavailable`,
/// and the next call starts a new helper.
#[test]
fn a_helper_that_does_not_answer_is_killed_at_the_budget() {
    let home = tempfile::tempdir().unwrap();
    let healthy = serving(|d| super::backend_of(d));
    let body: Body = Arc::new(move |nth, requests, replies| {
        if nth == 1 {
            silent(nth, requests, replies);
        } else {
            healthy(nth, requests, replies);
        }
    });
    let (mut backend, _handle, seen) = lab(file_in(home.path()), 80, body);
    let started = Instant::now();
    assert_eq!(backend.list(), Err(store_unavailable()));
    let took = started.elapsed();
    assert!(
        took >= Duration::from_millis(80),
        "the budget was not waited for: {took:?}"
    );
    assert!(
        took < Duration::from_secs(2),
        "the call outlived its budget by far: {took:?}"
    );
    assert_eq!((seen.started(), seen.killed()), (1, 1));
    assert!(seen.told(), "the store is told");
    // The second helper is a healthy one.
    assert_eq!(backend.list(), Ok(Vec::new()));
    assert_eq!((seen.started(), seen.killed(), seen.told()), (2, 1, false));
}

/// A helper that ends between two calls: the store is told at once, not at the next call.
#[test]
fn a_helper_that_ends_between_two_calls_tells_the_store_at_once() {
    let home = tempfile::tempdir().unwrap();
    let body: Body = Arc::new(|nth, mut requests, mut replies| {
        if nth > 1 {
            let _ = serve(requests, replies, super::backend_of);
            return;
        }
        // One request, one answer, then the helper is gone.
        let request = read_frame(&mut requests).unwrap().unwrap();
        let reply = json!({ "id": request["id"], "registrations": [], "value": [] });
        replies.write_all(&encode_frame(&reply).unwrap()).unwrap();
        replies.cut();
    });
    let (mut backend, _handle, seen) = lab(file_in(home.path()), 5000, body);
    assert_eq!(backend.list(), Ok(Vec::new()));
    assert!(
        seen.until(|seen| seen.unavailable.load(Ordering::SeqCst)),
        "nobody told the store"
    );
    assert!(seen.told());
    assert_eq!((seen.started(), seen.killed()), (1, 1));
    assert_eq!(backend.list(), Ok(Vec::new()));
    assert_eq!((seen.started(), seen.told()), (2, false));
}

/// `cancel` retires the helper without telling the store, also under a call in flight; `close` is final.
#[test]
fn cancel_is_silent_and_close_is_final() {
    let home = tempfile::tempdir().unwrap();
    let healthy = serving(|d| super::backend_of(d));
    let body: Body = Arc::new(move |nth, requests, replies| {
        if nth == 2 {
            silent(nth, requests, replies);
        } else {
            healthy(nth, requests, replies);
        }
    });
    let (mut backend, handle, seen) = lab(file_in(home.path()), 10_000, body);
    assert_eq!(backend.list(), Ok(Vec::new()));
    handle.cancel();
    assert_eq!((seen.started(), seen.killed(), seen.told()), (1, 1, false));
    handle.cancel();
    assert_eq!(seen.killed(), 1, "nothing left to retire");

    // The second helper never answers; `cancel` from another thread ends the call long before its budget.
    let canceller = handle.clone();
    let waiting = seen.clone();
    let cancel = thread::spawn(move || {
        assert!(waiting.until(|seen| seen.started() == 2));
        thread::sleep(Duration::from_millis(30));
        canceller.cancel();
    });
    let started = Instant::now();
    assert_eq!(backend.list(), Err(store_unavailable()));
    cancel.join().unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the call waited for its budget"
    );
    assert_eq!((seen.started(), seen.killed(), seen.told()), (2, 2, false));

    assert_eq!(backend.list(), Ok(Vec::new()));
    assert_eq!(seen.started(), 3);
    handle.close();
    assert_eq!(seen.killed(), 3);
    // A closed backend starts nothing; the call is an outage like any other (`onUnavailable`, as in TypeScript).
    assert_eq!(backend.list(), Err(store_unavailable()));
    assert_eq!((seen.started(), seen.told()), (3, true));
    handle.close();
}

/// A helper that cannot be started is an outage, every time it is tried.
#[test]
fn a_helper_that_cannot_be_started_is_an_outage() {
    let unavailable: Arc<AtomicBool> = Arc::default();
    let tried: Arc<AtomicUsize> = Arc::default();
    let count = tried.clone();
    let (mut backend, handle) = isolated_backend(
        BackendDescription::Keyring {
            service: "plur1bus:test".into(),
        },
        IsolatedOptions {
            budget: Duration::from_secs(5),
            spawn: Box::new(move |_| {
                count.fetch_add(1, Ordering::SeqCst);
                Err(io::Error::other("no such executable"))
            }),
            unavailable: unavailable.clone(),
        },
    );
    for round in 1..=2 {
        assert_eq!(backend.probe(), Err(store_unavailable()));
        assert!(unavailable.swap(false, Ordering::SeqCst));
        assert_eq!(tried.load(Ordering::SeqCst), round);
    }
    handle.close();
}

/// Bytes that are no frame, and an end inside a frame, are a broken helper.
#[test]
fn a_helper_that_writes_no_frame_is_an_outage() {
    let home = tempfile::tempdir().unwrap();
    let body: Body = Arc::new(|nth, mut requests, mut replies| {
        let _ = read_frame(&mut requests);
        let bytes: &[u8] = match nth {
            1 => b"this is a line of text, not a frame\n",
            2 => &[0, 0, 0, 9, b'{'],
            _ => &[0, 0, 0, 2, b'n', b'o'],
        };
        replies.write_all(bytes).unwrap();
        if nth == 2 {
            replies.cut();
        }
        silent(nth, requests, replies);
    });
    let (mut backend, _handle, seen) = lab(file_in(home.path()), 10_000, body);
    for round in 1..=3 {
        let started = Instant::now();
        assert_eq!(backend.list(), Err(store_unavailable()), "helper {round}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "helper {round} was waited for"
        );
        assert!(seen.told(), "helper {round}");
        assert_eq!((seen.started(), seen.killed()), (round, round));
    }
}

/// What a reply can carry: a stale id is passed over; an error keeps its code, message and detail and the values to mask
/// still arrive; a code outside the vocabulary and a value of another shape are `secret backend operation failed`, and
/// the helper is not killed for either.
#[test]
fn replies_are_read_as_the_protocol_says() {
    let script: Arc<Mutex<Vec<Value>>> = Arc::default();
    let replies_for = script.clone();
    let seen_requests: Arc<Mutex<Vec<Value>>> = Arc::default();
    let record = seen_requests.clone();
    let body: Body = Arc::new(move |_, mut requests, mut replies| {
        while let Ok(Some(request)) = read_frame(&mut requests) {
            record.lock().unwrap().push(request.clone());
            let id = request["id"].as_u64().unwrap();
            let mut reply = replies_for.lock().unwrap().remove(0);
            let stale = json!({ "id": id + 1000, "registrations": ["a stale registration"], "value": "stale" });
            reply["id"] = json!(id);
            for message in [stale, reply] {
                replies.write_all(&encode_frame(&message).unwrap()).unwrap();
            }
        }
    });
    let (mut backend, _handle, seen) = lab(
        BackendDescription::Keyring {
            service: "plur1bus:test".into(),
        },
        5000,
        body,
    );
    let script_next = |reply: Value| script.lock().unwrap().push(reply);
    let mut registered: Vec<String> = Vec::new();

    script_next(
        json!({ "registrations": ["the value before", 5, "its bare form"], "error":
        { "code": "corrupt", "message": "keyring index is corrupt (bad-entry); refusing to continue", "detail": { "n": 1 } } }),
    );
    let mut register = |value: &str| registered.push(value.to_owned());
    let refused = backend.put(
        "api",
        "a value in plain words",
        5,
        Some("owner:local"),
        None,
        Some(&mut register),
    );
    assert_eq!(
        refused,
        Err(SecretError::with_detail(
            SecretErrorCode::Corrupt,
            "keyring index is corrupt (bad-entry); refusing to continue",
            json!({ "n": 1 })
        ))
    );
    assert_eq!(registered, ["the value before", "its bare form"]);

    script_next(
        json!({ "registrations": [], "error": { "code": "weird", "message": "platform text" } }),
    );
    assert_eq!(backend.get("api"), Err(operation_failed()));
    script_next(json!({ "registrations": [], "error": "not an object" }));
    assert_eq!(backend.get("api"), Err(operation_failed()));
    script_next(json!({ "registrations": [], "value": 5 }));
    assert_eq!(backend.get("api"), Err(operation_failed()));
    script_next(json!({ "registrations": [] }));
    assert_eq!(backend.get("api"), Ok(None));
    script_next(json!({ "registrations": [], "value": { "available": "yes" } }));
    assert_eq!(backend.probe(), Err(operation_failed()));
    script_next(json!({ "registrations": [], "value": [{ "name": "api" }] }));
    assert_eq!(backend.list(), Err(operation_failed()));
    script_next(json!({ "registrations": [], "value": "true" }));
    assert_eq!(backend.delete("api", Some(7)), Err(operation_failed()));
    assert_eq!((seen.started(), seen.killed(), seen.told()), (1, 0, false));

    // What was asked: the protocol id, a rising id, the backend, and the arguments in the order of the TypeScript calls.
    let requests = seen_requests.lock().unwrap();
    assert_eq!(
        requests[0],
        json!({ "protocol": PROTOCOL, "id": 1, "backend": { "kind": "keyring", "service": "plur1bus:test" },
            "operation": "put", "args": ["api", "a value in plain words", 5, "owner:local", null] })
    );
    assert_eq!(requests[7]["args"], json!(["api", 7]));
    let ids: Vec<u64> = requests.iter().map(|r| r["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, (1..=8).collect::<Vec<u64>>());
}

// --- the server alone --------------------------------------------------------------------------------------------------

/// Runs `serve` over the given messages and returns the replies and how often a backend was made.
fn served(
    messages: &[Value],
    create: impl Fn(&BackendDescription) -> Box<dyn SecretBackend>,
) -> (Vec<Value>, usize) {
    let mut input = Vec::new();
    for message in messages {
        input.extend(encode_frame(message).unwrap());
    }
    let made = std::cell::Cell::new(0);
    let mut output = Vec::new();
    serve(input.as_slice(), &mut output, |description| {
        made.set(made.get() + 1);
        create(description)
    })
    .unwrap();
    let mut replies = Vec::new();
    let mut rest = output.as_slice();
    while let Some(reply) = read_frame(&mut rest).unwrap() {
        replies.push(reply);
    }
    (replies, made.get())
}

fn ask(id: u64, backend: &BackendDescription, operation: &str, args: Value) -> Value {
    let mut message = json!({ "protocol": PROTOCOL, "id": id, "backend": backend.to_json(), "operation": operation });
    message["args"] = args;
    message
}

fn failed(id: u64, error: &SecretError) -> Value {
    json!({ "id": id, "registrations": [], "error": error.to_json() })
}

struct Panics;

impl SecretBackend for Panics {
    fn kind(&self) -> BackendKind {
        BackendKind::Memory
    }
    fn probe(&mut self) -> Result<BackendProbe, SecretError> {
        Ok(BackendProbe {
            available: true,
            reason: None,
        })
    }
    fn get(&mut self, _: &str) -> Result<Option<String>, SecretError> {
        panic!("a backend that panics");
    }
    fn put(
        &mut self,
        _: &str,
        _: &str,
        _: i64,
        _: Option<&str>,
        _: Option<&str>,
        register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, SecretError> {
        if let Some(register) = register {
            register("the value that was there");
        }
        panic!("after the registration");
    }
    fn describe(
        &mut self,
        _: &str,
        _: &str,
        _: i64,
        _: Option<&str>,
        _: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, SecretError> {
        unreachable!()
    }
    fn delete(&mut self, _: &str, _: Option<i64>) -> Result<bool, SecretError> {
        unreachable!()
    }
    fn list(&mut self) -> Result<Vec<SecretMeta>, SecretError> {
        Ok(Vec::new())
    }
}

#[test]
fn the_server_answers_requests_and_nothing_else() {
    let keyring = BackendDescription::Keyring {
        service: "plur1bus:test".into(),
    };
    let other = BackendDescription::Keyring {
        service: "plur1bus:another".into(),
    };
    let memory =
        |_: &BackendDescription| -> Box<dyn SecretBackend> { Box::new(MemoryBackend::new(true)) };
    let mut wrong_protocol = ask(4, &keyring, "list", json!([]));
    wrong_protocol["protocol"] = json!("plur1bus.secrets-helper/2");
    let (replies, made) = served(
        &[
            json!({ "no": "id" }),
            json!({ "id": 1 }),
            json!({ "id": "2", "args": [] }),
            json!("not an object"),
            ask(
                3,
                &keyring,
                "put",
                json!(["api", "a value in plain words", 5, null, "what it is for"]),
            ),
            wrong_protocol,
            ask(5, &keyring, "explode", json!([])),
            ask(6, &keyring, "get", json!([5])),
            ask(7, &keyring, "get", json!([])),
            ask(
                8,
                &keyring,
                "put",
                json!(["api", "a value in plain words", "now", null, null]),
            ),
            ask(
                9,
                &keyring,
                "put",
                json!(["api", "a value in plain words", 5, 7, null]),
            ),
            ask(10, &other, "list", json!([])),
            json!({ "protocol": PROTOCOL, "id": 11, "backend": { "kind": "vault" }, "operation": "list", "args": [] }),
            ask(12, &keyring, "tombstones", json!([])),
            ask(13, &keyring, "clearTombstone", json!(["api"])),
            ask(14, &keyring, "delete", json!(["api", "soon"])),
            ask(15, &keyring, "get", json!(["api"])),
            ask(16, &keyring, "delete", json!(["api"])),
            ask(17, &keyring, "get", json!(["api"])),
            ask(
                18,
                &keyring,
                "describe",
                json!(["api", "a text", 5.0, null]),
            ),
        ],
        memory,
    );
    assert_eq!(made, 1, "one helper serves one backend, made once");
    let at = "1970-01-01T00:00:00.005Z";
    assert_eq!(
        replies,
        [
            json!({ "id": 3, "registrations": [], "value":
                { "name": "api", "backend": "memory", "createdAt": at, "updatedAt": at, "description": "what it is for" } }),
            failed(4, &operation_failed()),
            failed(5, &unknown_operation()),
            failed(6, &operation_failed()),
            failed(7, &operation_failed()),
            failed(8, &operation_failed()),
            failed(9, &operation_failed()),
            failed(10, &operation_failed()),
            failed(11, &operation_failed()),
            json!({ "id": 12, "registrations": [], "value": {} }),
            json!({ "id": 13, "registrations": [] }),
            failed(14, &operation_failed()),
            json!({ "id": 15, "registrations": [], "value": "a value in plain words" }),
            json!({ "id": 16, "registrations": [], "value": true }),
            json!({ "id": 17, "registrations": [], "value": null }),
            failed(18, &SecretError::not_found()),
        ]
    );

    // A backend that panics: the request is answered, what it registered before still travels, and the next is served.
    let (replies, _) = served(
        &[
            ask(1, &keyring, "get", json!(["api"])),
            ask(
                2,
                &keyring,
                "put",
                json!(["api", "a value in plain words", 5, null, null]),
            ),
            ask(3, &keyring, "list", json!([])),
        ],
        |_| Box::new(Panics),
    );
    assert_eq!(
        replies,
        [
            failed(1, &operation_failed()),
            json!({ "id": 2, "registrations": ["the value that was there"], "error": operation_failed().to_json() }),
            json!({ "id": 3, "registrations": [], "value": [] }),
        ]
    );
}

#[test]
fn the_server_ends_with_its_input_and_fails_on_what_is_no_frame() {
    let memory =
        |_: &BackendDescription| -> Box<dyn SecretBackend> { Box::new(MemoryBackend::new(true)) };
    assert!(
        serve(&[][..], Vec::new(), memory).is_ok(),
        "an empty input is a clean end"
    );
    for broken in [
        &[0u8, 0][..],
        &[0, 0, 0, 5, b'{'],
        &[0, 0, 0, 0],
        &[0xff, 0xff, 0xff, 0xff],
        &[0, 0, 0, 2, b'n', b'o'],
    ] {
        assert!(serve(broken, Vec::new(), memory).is_err(), "{broken:?}");
    }
    // The output is gone: the helper ends instead of working for nobody.
    struct Closed;
    impl Write for Closed {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let keyring = BackendDescription::Keyring {
        service: "plur1bus:test".into(),
    };
    let input = encode_frame(&ask(1, &keyring, "list", json!([]))).unwrap();
    assert!(serve(input.as_slice(), Closed, memory).is_err());
}

// --- frames ------------------------------------------------------------------------------------------------------------

#[test]
fn frames_have_a_length_and_a_limit() {
    let message = json!({ "text": "caf\u{e9} \u{1f600}", "n": [1, 2, 3] });
    let frame = encode_frame(&message).unwrap();
    assert_eq!(frame[..4], (frame.len() as u32 - 4).to_be_bytes());
    let mut two = frame.clone();
    two.extend(&frame);
    let mut rest = two.as_slice();
    assert_eq!(read_frame(&mut rest).unwrap(), Some(message.clone()));
    assert_eq!(read_frame(&mut rest).unwrap(), Some(message));
    assert_eq!(read_frame(&mut rest).unwrap(), None);

    // The largest value a secret can be, every character escaped, fits many times over; a message beyond the limit does
    // not leave, and a length beyond it is not read.
    let escaped = "\u{1}".repeat(64 * 1024);
    assert!(encode_frame(&json!([escaped])).unwrap().len() < MAX_FRAME_BYTES / 16);
    assert_eq!(encode_frame(&json!("x".repeat(MAX_FRAME_BYTES))), None);
    let length = (MAX_FRAME_BYTES as u32 + 1).to_be_bytes();
    assert!(read_frame(&mut &length[..]).is_err());
    for op in Operation::ALL {
        assert_eq!(Operation::from_wire(op.as_str()), Some(op));
    }
    assert_eq!(Operation::from_wire("revoke"), None);
    let descriptions = [
        BackendDescription::Keyring {
            service: "plur1bus:test".into(),
        },
        BackendDescription::File {
            dir: "/a home/state/secrets".into(),
        },
    ];
    for description in descriptions {
        assert_eq!(
            BackendDescription::from_json(&description.to_json()),
            Some(description)
        );
    }
    for odd in [
        json!({ "kind": "file" }),
        json!({ "kind": "keyring", "service": 5 }),
        json!("file"),
        json!({ "kind": "memory" }),
    ] {
        assert_eq!(BackendDescription::from_json(&odd), None, "{odd}");
    }
}
