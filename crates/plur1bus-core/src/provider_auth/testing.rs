//! Test doubles of the package's ports: a hand-moved clock, scripted randomness, an in-memory secret store with scripted
//! failures, a recording log and timer, and the HTTP port double of mode W (it compares every request with the recorded one
//! and answers with the recorded response).
use super::errors::{AuthError, AuthErrorCode};
use super::http::{HttpTransport, TransportError, WireRequest, WireResponse};
use super::ports::{AuthLog, Clock, RandomBytes, RandomUnit};
use super::record::SecretStore;
use super::refresh::RefreshTimer;
use super::secret::Secret;
use crate::egress::guard::{ResolvedAddress, Resolver};
use crate::egress::service::{ConfigSource, Egress};
use crate::egress::HostIdna;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::Mutex;

/// A string of a fixture: plain, or `{ "parts": [...] }`.
pub fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Object(o) if o.contains_key("parts") => o["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect(),
        other => panic!("not a text: {other}"),
    }
}

/// The fixture with every `{ parts }` joined back into its string.
pub fn joined(v: &Value) -> Value {
    match v {
        Value::Object(o) if o.len() == 1 && o.contains_key("parts") => Value::String(text(v)),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), joined(x))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(joined).collect()),
        other => other.clone(),
    }
}

/// Deep equality with numbers compared as doubles (a fixture's `10000` and a computed `10000.0` are the same number).
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

/// Asserts [`same`] with both values in the message.
#[track_caller]
pub fn assert_same(ours: &Value, theirs: &Value, what: &str) {
    assert!(
        same(ours, theirs),
        "{what}\n  rust: {ours}\n  ts:   {theirs}"
    );
}

/// A clock the test moves by hand.
pub struct FakeClock(pub Mutex<f64>);

impl FakeClock {
    /// At `t`.
    pub fn at(t: f64) -> FakeClock {
        FakeClock(Mutex::new(t))
    }
    /// Moves it.
    pub fn advance(&self, ms: f64) {
        *self.0.lock().unwrap() += ms;
    }
}

impl Clock for FakeClock {
    fn now(&self) -> f64 {
        *self.0.lock().unwrap()
    }
}

/// `random` of the exporter: the draws in order, the last one repeated.
pub struct Draws(pub Mutex<Vec<f64>>);

impl Draws {
    /// The list.
    pub fn of(v: &[f64]) -> Draws {
        Draws(Mutex::new(v.to_vec()))
    }
}

impl RandomUnit for Draws {
    fn next(&self) -> f64 {
        let mut d = self.0.lock().unwrap();
        if d.len() > 1 {
            d.remove(0)
        } else {
            d[0]
        }
    }
}

/// `randomBytes` of `k3b-support.ts`: draw k is the SHA-256 of `draw:k`, truncated.
#[derive(Default)]
pub struct ScriptedBytes(pub Mutex<u32>);

impl RandomBytes for ScriptedBytes {
    fn fill(&self, out: &mut [u8]) -> bool {
        let mut k = self.0.lock().unwrap();
        *k += 1;
        let d = Sha256::digest(format!("draw:{k}").as_bytes());
        out.copy_from_slice(&d[..out.len()]);
        true
    }
}

/// The in-memory secret store of the TypeScript tests, with scripted failures.
#[derive(Default)]
pub struct MemStore {
    /// The values.
    pub map: Mutex<BTreeMap<String, String>>,
    /// The next `set` calls that fail.
    pub fail_sets: Mutex<u32>,
    /// The next `get` calls that fail.
    pub fail_gets: Mutex<u32>,
}

impl MemStore {
    /// A value as text.
    pub fn read(&self, r: &str) -> Option<String> {
        self.map.lock().unwrap().get(r).cloned()
    }
    /// Seeds a value.
    pub fn put(&self, r: &str, v: &str) {
        self.map.lock().unwrap().insert(r.to_owned(), v.to_owned());
    }
}

impl SecretStore for MemStore {
    fn get(&self, r: &str) -> Result<Option<Secret>, AuthError> {
        let mut f = self.fail_gets.lock().unwrap();
        if *f > 0 {
            *f -= 1;
            return Err(AuthError::new(
                AuthErrorCode::InvalidSecretRecord,
                "store unavailable",
            ));
        }
        Ok(self.read(r).map(Secret::new))
    }
    fn set(&self, r: &str, value: &Secret) -> Result<(), AuthError> {
        let mut f = self.fail_sets.lock().unwrap();
        if *f > 0 {
            *f -= 1;
            return Err(AuthError::new(
                AuthErrorCode::PersistFailed,
                "store unavailable",
            ));
        }
        self.put(r, value.expose());
        Ok(())
    }
    fn delete(&self, r: &str) -> Result<(), AuthError> {
        self.map.lock().unwrap().remove(r);
        Ok(())
    }
}

/// A log sink that keeps `{ event, fields }`.
#[derive(Default)]
pub struct Logs(pub Mutex<Vec<Value>>);

impl AuthLog for Logs {
    fn log(&self, event: &str, fields: &[(&str, Value)]) {
        let f: Map<String, Value> = fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect();
        self.0
            .lock()
            .unwrap()
            .push(json!({ "event": event, "fields": f }));
    }
}

impl Logs {
    /// What was logged.
    pub fn all(&self) -> Value {
        Value::Array(self.0.lock().unwrap().clone())
    }
}

/// The timer of the exporter: the pending wake-ups in the order they were set.
#[derive(Default)]
pub struct Timers(pub Mutex<Vec<(String, f64)>>);

impl RefreshTimer for Timers {
    fn schedule(&self, key: &str, delay_ms: f64) {
        self.0.lock().unwrap().push((key.to_owned(), delay_ms));
    }
    fn cancel(&self, key: &str) {
        self.0.lock().unwrap().retain(|(k, _)| k != key);
    }
}

impl Timers {
    /// The delays of the pending wake-ups.
    pub fn view(&self) -> Value {
        json!(self
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|(_, d)| *d)
            .collect::<Vec<_>>())
    }
    /// Takes the newest wake-up.
    pub fn take_last(&self) -> Option<(String, f64)> {
        self.0.lock().unwrap().pop()
    }
}

/// The egress world of a vector: its configuration and the scripted resolver.
pub struct World {
    config: Value,
    resolve: BTreeMap<String, String>,
    public: String,
}

impl ConfigSource for World {
    fn egress_config(&self) -> Value {
        self.config.clone()
    }
}

impl Resolver for World {
    fn resolve(&self, host: &str) -> Result<Vec<ResolvedAddress>, Option<String>> {
        Ok(vec![ResolvedAddress {
            address: self
                .resolve
                .get(host)
                .cloned()
                .unwrap_or_else(|| self.public.clone()),
            family: 4,
        }])
    }
}

impl World {
    /// From a vector's `egress`, `resolve` and `public`.
    pub fn new(config: &Value, resolve: &Value, public: &str) -> World {
        World {
            config: config.clone(),
            resolve: resolve
                .as_object()
                .map(|m| {
                    m.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
                        .collect()
                })
                .unwrap_or_default(),
            public: public.to_owned(),
        }
    }

    /// The egress service over this world.
    pub fn egress(&self) -> Egress<'_> {
        static IDNA: HostIdna = HostIdna;
        Egress::new(self, self, &IDNA, 0)
    }
}

/// The HTTP port double of mode W: request `i` must equal the recorded request `i` (method, URL, header set, body byte for
/// byte, limits, pin); the answer is the recorded script entry `i`.
pub struct Wire {
    expected: Vec<Value>,
    script: Vec<Value>,
    seen: Mutex<usize>,
    /// Requests the double saw that did not match (checked by [`Wire::finish`]).
    pub mismatches: Mutex<Vec<String>>,
    /// While true, `send` waits (a test lines up concurrent callers behind the one exchange).
    hold: Mutex<bool>,
    released: std::sync::Condvar,
}

/// A request as the exporter records it.
pub fn request_json(r: &WireRequest) -> Value {
    let headers: Map<String, Value> = r
        .headers
        .iter()
        .map(|(k, v)| (k.clone(), json!(v)))
        .collect();
    json!({
        "method": r.method, "url": r.url, "headers": headers, "body": r.body.expose(),
        "limits": { "maxBytes": r.limits.max_bytes, "errorBodyBytes": r.limits.error_body_bytes, "timeoutMs": r.limits.timeout_ms, "redirect": Value::Null },
        "pin": { "host": r.pin.host, "address": r.pin.address, "family": r.pin.family, "port": r.pin.port },
    })
}

impl Wire {
    /// From the recorded requests and the script, both already [`joined`].
    pub fn new(expected: &Value, script: &Value) -> Wire {
        Wire {
            expected: expected.as_array().cloned().unwrap_or_default(),
            script: script.as_array().cloned().unwrap_or_default(),
            seen: Mutex::new(0),
            mismatches: Mutex::new(Vec::new()),
            hold: Mutex::new(false),
            released: std::sync::Condvar::new(),
        }
    }

    /// Makes the next requests wait until [`Wire::release`].
    pub fn hold(&self) {
        *self.hold.lock().unwrap() = true;
    }

    /// Lets waiting requests go.
    pub fn release(&self) {
        *self.hold.lock().unwrap() = false;
        self.released.notify_all();
    }

    /// Requests sent so far.
    pub fn count(&self) -> usize {
        *self.seen.lock().unwrap()
    }

    /// Every recorded request was sent, and each matched.
    #[track_caller]
    pub fn finish(&self, what: &str) {
        let m = self.mismatches.lock().unwrap();
        assert!(m.is_empty(), "{what}: requests differ:\n{}", m.join("\n"));
        assert_eq!(
            self.count(),
            self.expected.len(),
            "{what}: number of requests"
        );
    }
}

impl HttpTransport for Wire {
    fn send(&self, request: &WireRequest) -> Result<WireResponse, TransportError> {
        {
            let mut held = self.hold.lock().unwrap();
            while *held {
                held = self.released.wait(held).unwrap();
            }
        }
        let i = {
            let mut s = self.seen.lock().unwrap();
            *s += 1;
            *s - 1
        };
        let ours = request_json(request);
        match self.expected.get(i) {
            Some(theirs) if same(&ours, theirs) => {}
            Some(theirs) => self
                .mismatches
                .lock()
                .unwrap()
                .push(format!("#{i}\n  rust: {ours}\n  ts:   {theirs}")),
            None => self
                .mismatches
                .lock()
                .unwrap()
                .push(format!("#{i} not recorded: {ours}")),
        }
        let Some(s) = self.script.get(i) else {
            return Err(TransportError::Failed);
        };
        match s.get("fail").and_then(Value::as_str) {
            Some("hang") => Err(TransportError::Timeout),
            Some("error") => Err(TransportError::Failed),
            Some("too-large") => Err(TransportError::TooLarge),
            Some("unsupported-type") => Err(TransportError::UnsupportedType),
            Some(_) => Err(TransportError::Refused),
            None => Ok(WireResponse {
                status: s["status"].as_u64().unwrap() as u16,
                headers: s
                    .get("headers")
                    .and_then(Value::as_object)
                    .map(|m| {
                        m.iter()
                            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_owned()))
                            .collect()
                    })
                    .unwrap_or_default(),
                body: text(&s["body"]).into_bytes(),
            }),
        }
    }
}
