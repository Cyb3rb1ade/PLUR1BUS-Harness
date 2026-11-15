//! Replay of `fixtures/parity/secrets-store/keyring-backend.json` (`scripts/parity/export-secrets-store.ts`): the keyring
//! backend over a fake keyring, step by step: the answer, the values handed to `register`, every call made on the keyring
//! in its order, and what the step changed in it. The two scenarios with a `note` are the places where Rust differs on
//! purpose (P4D-32); each has a test of its own that says how.
use super::backend::SecretBackend;
use super::error::SecretError;
use super::keyring_backend::{
    Keyring, KeyringBackend, KeyringEntry, KeyringFailure, INDEX_ACCOUNT, INDEX_SCHEMA,
    PROBE_ACCOUNT,
};
use super::types::SecretMeta;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

pub(crate) fn load() -> Value {
    let path = format!(
        "{}/../../fixtures/parity/secrets-store/keyring-backend.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// One scripted failure (`["fail", op, account | null, code | null, skip]`).
struct Scripted {
    op: String,
    account: Option<String>,
    code: Option<String>,
    skip: u64,
}

#[derive(Default)]
pub(crate) struct State {
    service: String,
    items: BTreeMap<String, String>,
    calls: Vec<String>,
    fails: Vec<Scripted>,
}

impl State {
    /// The exporter's `hit`: the first scripted failure for this call either lets it pass (`skip`) or fails it.
    fn hit(&mut self, op: &str, account: &str) -> Result<(), KeyringFailure> {
        let Some(at) = self
            .fails
            .iter()
            .position(|f| f.op == op && f.account.as_deref().is_none_or(|a| a == account))
        else {
            return Ok(());
        };
        if self.fails[at].skip > 0 {
            self.fails[at].skip -= 1;
            return Ok(());
        }
        Err(KeyringFailure {
            code: self.fails.remove(at).code,
        })
    }
}

/// The fake keyring of the exporter: items of one service, every call recorded, failures on request.
#[derive(Clone, Default)]
pub(crate) struct Fake(Arc<Mutex<State>>);

impl Fake {
    pub(crate) fn of(service: &str) -> Fake {
        let fake = Fake::default();
        fake.0.lock().unwrap().service = service.to_owned();
        fake
    }
}

struct FakeEntry {
    state: Arc<Mutex<State>>,
    account: String,
}

impl Keyring for Fake {
    fn entry(&self, service: &str, account: &str) -> Result<Box<dyn KeyringEntry>, KeyringFailure> {
        let mut state = self.0.lock().unwrap();
        assert_eq!(
            service, state.service,
            "the backend asks for its own service"
        );
        // A failing loader: the constructor is never reached, so no call is recorded.
        state.hit("load", "")?;
        state.calls.push(format!("new:{account}"));
        state.hit("new", account)?;
        Ok(Box::new(FakeEntry {
            state: self.0.clone(),
            account: account.to_owned(),
        }))
    }
}

impl KeyringEntry for FakeEntry {
    fn get_password(&mut self) -> Result<Option<String>, KeyringFailure> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(format!("get:{}", self.account));
        state.hit("get", &self.account)?;
        Ok(state.items.get(&self.account).cloned())
    }

    fn set_password(&mut self, password: &str) -> Result<(), KeyringFailure> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(format!("set:{}", self.account));
        state.hit("set", &self.account)?;
        state
            .items
            .insert(self.account.clone(), password.to_owned());
        Ok(())
    }

    fn delete_password(&mut self) -> Result<bool, KeyringFailure> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(format!("delete:{}", self.account));
        state.hit("delete", &self.account)?;
        Ok(state.items.remove(&self.account).is_some())
    }
}

/// What one replayed step gave.
pub(crate) struct Outcome {
    pub(crate) answer: Value,
    pub(crate) registered: Vec<String>,
    pub(crate) calls: String,
    /// `[account, text | null]` for every item the step changed, sorted by account.
    pub(crate) items: Value,
}

fn answer<T>(result: Result<T, SecretError>, ok: impl FnOnce(T) -> Value) -> Value {
    match result {
        Ok(value) => json!({ "ok": ok(value) }),
        // V8 throws a `RangeError` where Rust has a `storage` error with V8's text.
        Err(e) if e == SecretError::invalid_time() => json!({ "throw": "RangeError" }),
        Err(e) => json!({ "err": e.to_json() }),
    }
}

/// Runs one recorded step (`op`) against `backend` and `fake`.
pub(crate) fn run(backend: &mut dyn SecretBackend, fake: &Fake, op: &Value) -> Outcome {
    let op = op.as_array().unwrap();
    let text = |n: usize| op[n].as_str().unwrap();
    let ms = |n: usize| op[n].as_f64().unwrap() as i64;
    let before = {
        let mut state = fake.0.lock().unwrap();
        state.calls.clear();
        state.items.clone()
    };
    let mut registered: Vec<String> = Vec::new();
    let mut register = |value: &str| registered.push(value.to_owned());
    let answer = match text(0) {
        "probe" => answer(backend.probe(), |p| match p.reason {
            Some(reason) => json!({ "available": p.available, "reason": reason }),
            None => json!({ "available": p.available }),
        }),
        "get" => answer(backend.get(text(1)), |value| json!(value)),
        "list" => answer(backend.list(), |metas| {
            Value::Array(metas.iter().map(SecretMeta::to_json).collect())
        }),
        "delete" => answer(backend.delete(text(1), None), |removed| json!(removed)),
        "put" => answer(
            backend.put(
                text(1),
                text(2),
                ms(3),
                op[4].as_str(),
                op[5].as_str(),
                Some(&mut register),
            ),
            |meta| meta.to_json(),
        ),
        "describe" => answer(
            backend.describe(text(1), text(2), ms(3), op[4].as_str(), Some(&mut register)),
            |meta| meta.to_json(),
        ),
        "seed" => {
            let mut state = fake.0.lock().unwrap();
            match op[2].as_str() {
                Some(content) => state.items.insert(text(1).to_owned(), content.to_owned()),
                None => state.items.remove(text(1)),
            };
            json!({ "ok": null })
        }
        "fail" => {
            fake.0.lock().unwrap().fails.push(Scripted {
                op: text(1).to_owned(),
                account: op[2].as_str().map(str::to_owned),
                code: op[3].as_str().map(str::to_owned),
                skip: op[4].as_u64().unwrap(),
            });
            json!({ "ok": null })
        }
        other => panic!("unknown step {other}"),
    };
    let state = fake.0.lock().unwrap();
    let mut changed = Vec::new();
    let accounts: std::collections::BTreeSet<&String> =
        before.keys().chain(state.items.keys()).collect();
    for account in accounts {
        if before.get(account) != state.items.get(account) {
            changed.push(json!([account, state.items.get(account)]));
        }
    }
    Outcome {
        answer,
        registered,
        calls: state.calls.join(" "),
        items: Value::Array(changed),
    }
}

fn scenario<'a>(file: &'a Value, name: &str) -> &'a Value {
    file["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == json!(name))
        .unwrap_or_else(|| panic!("no scenario {name}"))
}

/// The recorded change of a step (`items` is absent when nothing changed).
pub(crate) fn recorded_items(step: &Value) -> Value {
    step.get("items").cloned().unwrap_or_else(|| json!([]))
}

#[test]
fn the_keyring_backend_replays_the_recorded_scenarios() {
    let file = load();
    assert_eq!(file["schema"], json!(INDEX_SCHEMA));
    assert_eq!(file["indexAccount"], json!(INDEX_ACCOUNT));
    assert_eq!(file["probeAccount"], json!(PROBE_ACCOUNT));
    let service = file["service"].as_str().unwrap();
    let mut bad = Vec::new();
    let (mut total, mut noted) = (0, Vec::new());
    for scenario in file["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        if scenario.get("note").is_some() {
            noted.push(name);
            continue;
        }
        let fake = Fake::of(service);
        let mut backend = KeyringBackend::new(service, Box::new(fake.clone()));
        for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            total += 1;
            let got = run(&mut backend, &fake, &step["op"]);
            let mut differs = Vec::new();
            if got.answer != step["result"] {
                differs.push(format!(
                    "answer {} (recorded {})",
                    got.answer, step["result"]
                ));
            }
            if json!(got.registered) != step["registered"] {
                differs.push(format!(
                    "registered {} values (recorded {})",
                    got.registered.len(),
                    step["registered"].as_array().map_or(0, Vec::len)
                ));
            }
            if json!(got.calls) != step["calls"] {
                differs.push(format!(
                    "calls {:?} (recorded {})",
                    got.calls, step["calls"]
                ));
            }
            if got.items != recorded_items(step) {
                differs.push(format!(
                    "changed {} (recorded {})",
                    got.items,
                    recorded_items(step)
                ));
            }
            if !differs.is_empty() {
                bad.push(format!(
                    "{name} step {i} {}: {}",
                    step["op"],
                    differs.join("; ")
                ));
            }
        }
        assert!(
            fake.0.lock().unwrap().fails.is_empty(),
            "{name}: a scripted failure did not happen"
        );
    }
    assert_eq!(
        noted,
        ["foreign-members-in-an-answer", "a-time-no-date-can-hold"],
        "the noted scenarios each have a test of their own"
    );
    assert!(total > 250, "the grid shrank: {total} steps");
    assert!(
        bad.is_empty(),
        "{} of {total} steps differ:\n{}",
        bad.len(),
        bad.iter().take(5).cloned().collect::<Vec<_>>().join("\n")
    );
}

/// P4D-32, the first noted scenario. TypeScript spreads the whole index entry into the answer of `list`: a `name` or a
/// `backend` member written into the index from outside replaces the real one, and every other member shows. Rust answers
/// with the known members; the name is the key of the entry.
#[test]
fn list_answers_with_the_known_members_of_an_entry() {
    let file = load();
    let service = file["service"].as_str().unwrap();
    let steps = scenario(&file, "foreign-members-in-an-answer")["steps"]
        .as_array()
        .unwrap();
    let fake = Fake::of(service);
    let mut backend = KeyringBackend::new(service, Box::new(fake.clone()));
    run(&mut backend, &fake, &steps[0]["op"]);
    let got = run(&mut backend, &fake, &steps[1]["op"]);
    // What TypeScript answered, as recorded: the entry `api` under another name and backend, with a number as `updatedBy`.
    let recorded = &steps[1]["result"]["ok"];
    assert_eq!(recorded[0]["name"], json!("another-name"));
    assert_eq!(recorded[0]["backend"], json!("file"));
    assert_eq!(recorded[0]["extra"], json!(1));
    assert_eq!(recorded[0]["updatedBy"], json!(5));
    // Rust: the entry under its key, of this backend, with the members a `SecretMeta` has.
    let at = recorded[0]["createdAt"].clone();
    assert_eq!(
        got.answer,
        json!({ "ok": [
            { "name": "api", "backend": "keyring", "createdAt": at, "updatedAt": at },
            { "name": "plain", "backend": "keyring", "createdAt": at, "updatedAt": at, "updatedBy": "" },
        ] })
    );
    assert_eq!(
        got.answer["ok"][1], recorded[1],
        "an entry without foreign members is answered alike"
    );
    assert_eq!(json!(got.calls), steps[1]["calls"]);
}

/// P4D-32, the second noted scenario. With a time no date can hold, TypeScript writes the value and then throws at
/// `toISOString`: the keyring holds a value its index does not know (or, for a name that exists, another value than the
/// index describes). Rust refuses before the write.
#[test]
fn a_put_with_a_time_no_date_can_hold_writes_nothing() {
    let file = load();
    let service = file["service"].as_str().unwrap();
    let steps = scenario(&file, "a-time-no-date-can-hold")["steps"]
        .as_array()
        .unwrap();
    let fake = Fake::of(service);
    let mut backend = KeyringBackend::new(service, Box::new(fake.clone()));
    let first = run(&mut backend, &fake, &steps[0]["op"]);
    assert_eq!(first.answer, steps[0]["result"]);
    let first_value = steps[0]["op"][2].clone();

    // An existing name: TypeScript replaced the value (recorded); Rust left it.
    assert_eq!(steps[1]["result"], json!({ "throw": "RangeError" }));
    assert_eq!(steps[1]["items"], json!([["api", steps[1]["op"][2]]]));
    let got = run(&mut backend, &fake, &steps[1]["op"]);
    assert_eq!(got.answer, json!({ "throw": "RangeError" }));
    assert_eq!(got.items, json!([]));
    assert_eq!(
        got.calls,
        format!("new:{INDEX_ACCOUNT} get:{INDEX_ACCOUNT} new:api get:api")
    );
    assert_eq!(
        json!(got.registered),
        steps[1]["registered"],
        "the replaced value is masked either way"
    );
    assert_eq!(
        run(&mut backend, &fake, &steps[2]["op"]).answer,
        json!({ "ok": first_value })
    );
    assert_eq!(
        run(&mut backend, &fake, &steps[3]["op"]).answer,
        steps[3]["result"]
    );

    // A new name: TypeScript left a value the index does not know (recorded); Rust wrote nothing.
    assert_eq!(steps[4]["items"], json!([["fresh", steps[4]["op"][2]]]));
    let got = run(&mut backend, &fake, &steps[4]["op"]);
    assert_eq!(got.answer, json!({ "throw": "RangeError" }));
    assert_eq!(got.items, json!([]));
    assert_eq!(
        run(&mut backend, &fake, &steps[5]["op"]).answer,
        json!({ "ok": null })
    );
    assert_eq!(
        run(&mut backend, &fake, &steps[6]["op"]).answer,
        steps[6]["result"]
    );
}

/// Two services on one keyring do not see each other's secrets or index.
#[test]
fn two_services_on_one_keyring_do_not_meet() {
    struct Shared(Arc<Mutex<BTreeMap<(String, String), String>>>);
    struct Entry(
        Arc<Mutex<BTreeMap<(String, String), String>>>,
        (String, String),
    );
    impl Keyring for Shared {
        fn entry(
            &self,
            service: &str,
            account: &str,
        ) -> Result<Box<dyn KeyringEntry>, KeyringFailure> {
            Ok(Box::new(Entry(
                self.0.clone(),
                (service.to_owned(), account.to_owned()),
            )))
        }
    }
    impl KeyringEntry for Entry {
        fn get_password(&mut self) -> Result<Option<String>, KeyringFailure> {
            Ok(self.0.lock().unwrap().get(&self.1).cloned())
        }
        fn set_password(&mut self, password: &str) -> Result<(), KeyringFailure> {
            self.0
                .lock()
                .unwrap()
                .insert(self.1.clone(), password.to_owned());
            Ok(())
        }
        fn delete_password(&mut self) -> Result<bool, KeyringFailure> {
            Ok(self.0.lock().unwrap().remove(&self.1).is_some())
        }
    }
    let items: Arc<Mutex<BTreeMap<(String, String), String>>> = Arc::default();
    let mut one = KeyringBackend::new("plur1bus:one", Box::new(Shared(items.clone())));
    let mut two = KeyringBackend::new("plur1bus:two", Box::new(Shared(items.clone())));
    one.put("api", "the value of the first home", 0, None, None, None)
        .unwrap();
    assert_eq!(two.get("api").unwrap(), None);
    assert!(two.list().unwrap().is_empty());
    two.put("api", "the value of the second home", 0, None, None, None)
        .unwrap();
    assert_eq!(
        one.get("api").unwrap().as_deref(),
        Some("the value of the first home")
    );
    assert!(two.delete("api", None).unwrap());
    assert_eq!(one.list().unwrap().len(), 1);
    let left: Vec<(String, String)> = items.lock().unwrap().keys().cloned().collect();
    assert_eq!(
        left,
        [
            ("plur1bus:one".to_owned(), INDEX_ACCOUNT.to_owned()),
            ("plur1bus:one".to_owned(), "api".to_owned()),
            ("plur1bus:two".to_owned(), INDEX_ACCOUNT.to_owned()),
        ],
        "the first home's value and index, and the second home's emptied index"
    );
}
