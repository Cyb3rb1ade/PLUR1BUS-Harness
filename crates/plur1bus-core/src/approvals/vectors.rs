//! Replay of `fixtures/parity/approvals/*.json` (`scripts/parity/export-approvals.ts`): the canonical MAC text and the HMAC,
//! the head tag, the binding tuple and JSON re-serialisation; Ed25519 signing (byte-equal signatures), verification over
//! altered bytes and Node's lenient decoders, the PKCS #8 and chain-key reads; the semantic rules over appends a key holder
//! could make; the main scenario (approvals and grants on one chain, every row byte-equal to TypeScript's, every audit line,
//! the verified views after), the tamper cases over that file, and the grant rules.
use super::chain::{ApprovalChain, ChainEntry, ChainError};
use super::js_json::{num_value, J};
use super::keys::KeyError;
use super::node_codec::{base64_decode, hex_decode};
use super::signing::{verify_decision_signature, DecisionSigner, Ed25519Signer};
use super::store::{ApprovalStore, Status};
use super::{AuditPort, Clock, OsRandom};
use crate::grants::store::{CreateGrantInput, GrantError, GrantMatch, GrantStore};
use plur1bus_store::rusqlite::types::Value as SqlValue;
use plur1bus_store::rusqlite::Connection;
use plur1bus_store::Store;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

fn fixture(name: &str) -> Value {
    let text = match name {
        "canonical" => include_str!("../../../../fixtures/parity/approvals/canonical.json"),
        "chain" => include_str!("../../../../fixtures/parity/approvals/chain.json"),
        "rules" => include_str!("../../../../fixtures/parity/approvals/rules.json"),
        "semantic" => include_str!("../../../../fixtures/parity/approvals/semantic.json"),
        "signing" => include_str!("../../../../fixtures/parity/approvals/signing.json"),
        _ => unreachable!(),
    };
    serde_json::from_str(text).unwrap()
}

/// A string, or `{ parts: [...] }` (key material is stored in pieces).
fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Object(o) => o["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect(),
        other => panic!("not a text: {other}"),
    }
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

/// A clock the replay sets (the TypeScript `FakeClock` with `t`).
pub(crate) struct SetClock(AtomicI64);

impl SetClock {
    pub(crate) fn at(t: i64) -> Self {
        SetClock(AtomicI64::new(t))
    }
    pub(crate) fn set(&self, t: i64) {
        self.0.store(t, Ordering::SeqCst);
    }
    pub(crate) fn get(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

impl Clock for SetClock {
    fn now(&self) -> i64 {
        self.get()
    }
}

/// `{ now: () => t++ }`.
struct Ticking(AtomicI64);

impl Clock for Ticking {
    fn now(&self) -> i64 {
        self.0.fetch_add(1, Ordering::SeqCst)
    }
}

#[derive(Default)]
pub(super) struct Recorded(pub(super) Vec<(String, Value)>);

impl AuditPort for Recorded {
    fn record(&mut self, action: &str, fields: &Value) -> Result<(), String> {
        self.0.push((action.to_owned(), fields.clone()));
        Ok(())
    }
}

fn fresh() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = super::db::open(&dir.path().join("approvals.sqlite"), &Default::default()).unwrap();
    (dir, store)
}

fn entry_json(e: &ChainEntry) -> Value {
    json!({ "seq": num_value(e.seq), "ts": num_value(e.ts), "kind": e.kind, "refId": e.ref_id, "nonce": e.nonce,
        "payload": e.payload, "prevMac": e.prev_mac, "mac": e.mac })
}

const TABLES: [(&str, &str); 5] = [
    (
        "approval_chain",
        "SELECT * FROM approval_chain ORDER BY seq",
    ),
    ("chain_head", "SELECT * FROM chain_head"),
    (
        "approval_signatures",
        "SELECT * FROM approval_signatures ORDER BY seq",
    ),
    ("grants", "SELECT * FROM grants ORDER BY id"),
    ("approvals", "SELECT * FROM approvals ORDER BY id"),
];

fn dump(conn: &Connection) -> Value {
    let mut out = Map::new();
    for (table, sql) in TABLES {
        let mut stmt = conn.prepare(sql).unwrap();
        let names: Vec<String> = stmt.column_names().map(str::to_owned).collect();
        let rows: Vec<Value> = stmt
            .query_map([], |r| {
                let mut o = Map::new();
                for (i, n) in names.iter().enumerate() {
                    let v = match r.get::<_, SqlValue>(i)? {
                        SqlValue::Null => Value::Null,
                        SqlValue::Integer(i) => json!(i),
                        SqlValue::Real(f) => num_value(f),
                        SqlValue::Text(t) => json!(t),
                        SqlValue::Blob(_) => json!("<blob>"),
                    };
                    o.insert(n.clone(), v);
                }
                Ok(Value::Object(o))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        out.insert(table.to_owned(), Value::Array(rows));
    }
    Value::Object(out)
}

fn load(conn: &Connection, rows: &Value) {
    for (table, _) in TABLES {
        for r in rows[table].as_array().unwrap() {
            let o = r.as_object().unwrap();
            let cols: Vec<&String> = o.keys().collect();
            let sql = format!(
                "INSERT INTO {table} ({}) VALUES ({})",
                cols.iter()
                    .map(|c| c.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
                cols.iter().map(|_| "?").collect::<Vec<_>>().join(", ")
            );
            let vals: Vec<SqlValue> = cols
                .iter()
                .map(|c| match &o[*c] {
                    Value::Null => SqlValue::Null,
                    Value::Number(n) if n.is_i64() => SqlValue::Integer(n.as_i64().unwrap()),
                    Value::Number(n) => SqlValue::Real(n.as_f64().unwrap()),
                    Value::String(s) => SqlValue::Text(s.clone()),
                    other => panic!("{other}"),
                })
                .collect();
            conn.execute(&sql, plur1bus_store::rusqlite::params_from_iter(vals))
                .unwrap();
        }
    }
}

fn key_of(v: &Value) -> Vec<u8> {
    hex_decode(&text(v))
}

fn signer_of(v: &Value) -> Arc<dyn DecisionSigner> {
    Arc::new(Ed25519Signer::from_pkcs8(&base64_decode(&text(v))).unwrap())
}

fn chain_error_name(e: &ChainError) -> &'static str {
    match e {
        ChainError::Broken { .. } => "ApprovalChainError",
        _ => "Error",
    }
}

#[test]
fn canonical_text_hmac_tag_tuple_and_json() {
    let f = fixture("canonical");
    let chain = ApprovalChain::new(&key_of(&f["key"]), Arc::new(SetClock::at(0)), None).unwrap();
    for c in f["mac"].as_array().unwrap() {
        let nonce = c["nonce"].as_str();
        let (seq, ts) = (c["seq"].as_f64().unwrap(), c["ts"].as_f64().unwrap());
        let input = ApprovalChain::mac_input(
            s(&c["prev"]),
            seq,
            ts,
            s(&c["kind"]),
            s(&c["ref"]),
            nonce,
            s(&c["payload"]),
        );
        assert_eq!(input, s(&c["text"]), "{c}");
        assert_eq!(
            chain.mac(
                s(&c["prev"]),
                seq,
                ts,
                s(&c["kind"]),
                s(&c["ref"]),
                nonce,
                s(&c["payload"])
            ),
            s(&c["mac"])
        );
    }
    for c in f["tag"].as_array().unwrap() {
        assert_eq!(
            chain.tag(c["seq"].as_f64().unwrap(), s(&c["mac"])),
            s(&c["tag"]),
            "{c}"
        );
    }
    for c in f["tuples"].as_array().unwrap() {
        let input = J::parse(s(&c["inputJson"])).unwrap();
        assert_eq!(
            super::chain::binding_tuple(Some(&input))
                .map(Value::String)
                .unwrap_or(Value::Null),
            c["tuple"],
            "{c}"
        );
    }
    for c in f["restringify"].as_array().unwrap() {
        assert_eq!(
            J::parse(s(&c["text"])).unwrap().stringify(),
            s(&c["out"]),
            "{c}"
        );
    }
}

#[test]
fn signatures_keys_and_lenient_decoding() {
    let f = fixture("signing");
    let signer = Ed25519Signer::from_pkcs8(&base64_decode(&text(&f["signing"]))).unwrap();
    assert_eq!(signer.public_key(), s(&f["publicKey"]));
    for c in f["sign"].as_array().unwrap() {
        assert_eq!(
            signer.sign(s(&c["mac"])).signature,
            s(&c["signature"]),
            "Ed25519 is deterministic: {c}"
        );
    }
    for c in f["verify"].as_array().unwrap() {
        let got = verify_decision_signature(s(&c["mac"]), s(&c["publicKey"]), s(&c["signature"]));
        assert_eq!(got, c["ok"].as_bool().unwrap(), "{}", c["name"]);
    }
    for c in f["keys"].as_array().unwrap() {
        let bytes = base64_decode(&text(&c["value"]));
        let got = if bytes.len() < 16 {
            json!({ "error": "corrupt" })
        } else {
            match Ed25519Signer::from_pkcs8(&bytes) {
                Ok(s) => json!({ "publicKey": s.public_key() }),
                Err(KeyError::Corrupt(_)) => json!({ "error": "corrupt" }),
                Err(e) => json!({ "error": e.to_string() }),
            }
        };
        assert_eq!(got, c["result"], "{}", c["name"]);
    }
    for c in f["chainKeys"].as_array().unwrap() {
        let bytes = base64_decode(&text(&c["value"]));
        assert_eq!(bytes.len() as u64, c["bytes"].as_u64().unwrap());
        assert_eq!(super::node_codec::hex_encode(&bytes), text(&c["hex"]));
        assert_eq!(
            super::keys::assert_key(&bytes).is_err(),
            c["corrupt"].as_bool().unwrap()
        );
    }
}

#[test]
fn semantic_rules_over_appends_a_key_holder_could_make() {
    let f = fixture("semantic");
    let key = key_of(&fixture("chain")["key"]);
    let signer = signer_of(&fixture("chain")["signing"]);
    let now = fixture("chain")["now"].as_i64().unwrap();
    for c in f.as_array().unwrap() {
        let (_dir, mut store) = fresh();
        let signed = c["signed"].as_bool().unwrap();
        let chain = ApprovalChain::new(
            &key,
            Arc::new(Ticking(AtomicI64::new(now))),
            signed.then(|| Arc::clone(&signer)),
        )
        .unwrap();
        let mut appended = Vec::new();
        for a in c["appends"].as_array().unwrap() {
            let payload = J::parse(s(&a["payloadJson"])).unwrap();
            let r: Result<ChainEntry, ChainError> = store.write_with(|tx| {
                chain.append(
                    tx,
                    s(&a["kind"]),
                    s(&a["ref"]),
                    &payload,
                    a["nonce"].as_str(),
                )
            });
            appended.push(match r {
                Ok(_) => json!("ok"),
                Err(e) => json!({ "error": chain_error_name(&e) }),
            });
        }
        assert_eq!(Value::Array(appended), c["appended"], "{}", c["name"]);
        assert_eq!(
            dump(store.conn()),
            c["rows"],
            "{}: the rows are TypeScript's, byte for byte",
            c["name"]
        );
        assert_eq!(
            chain.verify(store.conn()).unwrap().json(),
            c["verify"],
            "{}",
            c["name"]
        );
    }
}

fn grant_input(v: &Value, non_finite: Option<&Value>) -> CreateGrantInput {
    let o = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    let m = &v["match"];
    let r#match = match s(&m["kind"]) {
        "action" => GrantMatch::Action,
        "capability" => GrantMatch::Capability,
        _ => GrantMatch::Path {
            path: s(&m["path"]).to_owned(),
            access: s(&m["access"]).to_owned(),
            recursive: m["recursive"].as_bool().unwrap(),
        },
    };
    let mut i = CreateGrantInput::new(
        s(&v["capability"]),
        s(&v["person"]),
        s(&v["agent"]),
        s(&v["scope"]),
        r#match,
        s(&v["createdBy"]),
        v["surface"].as_u64().unwrap() as u8,
    );
    i.id = o("id");
    i.effect = o("effect");
    i.action_hash = o("actionHash");
    i.task_id = o("taskId");
    i.session_id = o("sessionId");
    i.project_id = o("projectId");
    i.job_id = o("jobId");
    i.attested_via = o("attestedVia");
    i.delegable = v["delegable"] == json!(true);
    i.acknowledged_unsandboxed = v["acknowledgedUnsandboxed"] == json!(true);
    i.expires_at = match non_finite
        .and_then(|n| n.get("expiresAt"))
        .and_then(Value::as_str)
    {
        Some("NaN") => Some(f64::NAN),
        Some("Infinity") => Some(f64::INFINITY),
        Some(other) => panic!("{other}"),
        None => v.get("expiresAt").and_then(Value::as_f64),
    };
    i
}

fn grant_result(r: Result<Value, GrantError>) -> Value {
    match r {
        Ok(g) => g,
        Err(GrantError::Refused { code, message }) => {
            json!({ "error": code.as_str(), "message": message })
        }
        Err(e) => panic!("{e}"),
    }
}

#[test]
fn the_main_scenario_writes_typescripts_rows_and_reads_them_the_same_way() {
    let f = fixture("chain");
    let key = key_of(&f["key"]);
    let signer = signer_of(&f["signing"]);
    // The vectors hold POSIX spellings, recorded on POSIX: the POSIX rules apply on every system.
    let platform = "darwin";
    let clock = Arc::new(SetClock::at(f["now"].as_i64().unwrap()));
    let (_dir, mut store) = fresh();
    let chain = ApprovalChain::new(&key, clock.clone(), Some(Arc::clone(&signer))).unwrap();
    let grants = GrantStore::new(
        clock.clone(),
        Arc::new(OsRandom),
        None,
        Some(s(&f["home"]).to_owned()),
    )
    .with_platform(platform);
    for op in f["ops"].as_array().unwrap() {
        clock.set(op["at"].as_i64().unwrap());
        let mut audit = Recorded::default();
        let result: Value = match s(&op["op"]) {
            "append" => {
                let payload = J::parse(s(&op["payloadJson"])).unwrap();
                let e = store
                    .write_with(|tx| {
                        chain.append(
                            tx,
                            s(&op["kind"]),
                            s(&op["ref"]),
                            &payload,
                            op["nonce"].as_str(),
                        )
                    })
                    .unwrap();
                entry_json(&e)
            }
            "grant" => grant_result(store.write_with(|tx| {
                grants.create(tx, &chain, &mut audit, &grant_input(&op["input"], None))
            })),
            "markUsed" => {
                store
                    .write_with(|tx| grants.mark_used(tx, &chain, &mut audit, s(&op["id"])))
                    .unwrap();
                Value::Null
            }
            "revoke" => json!(store
                .write_with(|tx| grants.revoke(
                    tx,
                    &chain,
                    &mut audit,
                    s(&op["id"]),
                    s(&op["by"]),
                    s(&op["reason"])
                ))
                .unwrap()),
            "consumeOnce" => json!(store
                .write_with(|tx| grants.consume_once(
                    tx,
                    &chain,
                    &mut audit,
                    s(&op["id"]),
                    s(&op["person"]),
                    s(&op["agent"]),
                    s(&op["actionHash"])
                ))
                .unwrap()),
            "endTask" => json!(store
                .write_with(|tx| grants.end_task(tx, &chain, &mut audit, s(&op["taskId"]), "core"))
                .unwrap()),
            other => panic!("{other}"),
        };
        assert_eq!(result, op["result"], "{op}");
        let lines: Vec<Value> = audit
            .0
            .iter()
            .map(|(a, fields)| json!({ "action": a, "fields": fields }))
            .collect();
        assert_eq!(Value::Array(lines), op["audit"], "the audit lines of {op}");
    }
    assert_eq!(
        dump(store.conn()),
        f["rows"],
        "every row is TypeScript's, byte for byte"
    );

    let after = &f["after"];
    clock.set(after["at"].as_i64().unwrap());
    assert_eq!(chain.verify(store.conn()).unwrap().json(), after["verify"]);
    let inspect: Vec<Value> = grants
        .inspect(store.conn(), &chain, None, None)
        .unwrap()
        .into_iter()
        .map(|v| json!({ "grant": v.grant, "state": v.state.as_str() }))
        .collect();
    assert_eq!(Value::Array(inspect), after["inspect"]);
    assert_eq!(
        Value::Array(
            grants
                .list(store.conn(), &chain, "christian", "bernd", "fs.read")
                .unwrap()
        ),
        after["listCap"]
    );
    let approvals = ApprovalStore::new(chain, clock.clone(), Arc::new(OsRandom), None);
    let list: Vec<Value> = approvals
        .list(store.conn(), None, None)
        .unwrap()
        .iter()
        .map(|r| r.json())
        .collect();
    assert_eq!(Value::Array(list), after["approvals"]);
    let pending = approvals
        .list(store.conn(), Some(Status::Pending), Some("christian"))
        .unwrap();
    assert_eq!(pending.len(), 1);
}

#[test]
fn a_rolled_back_append_leaves_no_phantom_entry_k3_d2() {
    let f = fixture("chain");
    let ts = &f["phantomAfterRollback"];
    assert_eq!(ts["divergence"], "K3-D2");
    // What TypeScript recorded: the view keeps the rolled-back entry, and the next append breaks the chain.
    assert_eq!(
        (
            ts["rowsAfterRollback"].as_u64(),
            ts["verifyAfterRollback"]["entries"].as_u64()
        ),
        (Some(1), Some(2))
    );
    assert_eq!(ts["seqsAfterNextAppend"], json!([1, 3]));
    assert_eq!(ts["verifyAfterNextAppend"]["reason"], "seq-gap");
    // Rust: the view after the rollback is the file's, and the chain stays whole.
    let (_dir, mut store) = fresh();
    let chain = ApprovalChain::new(
        &key_of(&f["key"]),
        Arc::new(Ticking(AtomicI64::new(f["now"].as_i64().unwrap()))),
        None,
    )
    .unwrap();
    let note = |i: f64| J::obj([("i", J::Num(i))]);
    store
        .write_with(|tx| chain.append(tx, "note", "a", &note(1.0), None))
        .unwrap();
    let refused: Result<(), ChainError> = store.write_with(|tx| {
        chain.append(tx, "note", "b", &note(2.0), None)?;
        chain.snapshot(tx)?;
        Err(ChainError::Unreadable("refused after the append".into()))
    });
    assert!(refused.is_err());
    assert_eq!(chain.verify(store.conn()).unwrap().json()["entries"], 1);
    store
        .write_with(|tx| chain.append(tx, "note", "c", &note(3.0), None))
        .unwrap();
    let seqs: Vec<i64> = store
        .conn()
        .prepare("SELECT seq FROM approval_chain ORDER BY seq")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(seqs, [1, 2]);
    assert!(chain.verify(store.conn()).unwrap().ok());
}

#[test]
fn every_tamper_case_is_judged_as_typescript_judges_it() {
    let f = fixture("chain");
    let key = key_of(&f["key"]);
    let signer = signer_of(&f["signing"]);
    let other = Ed25519Signer::from_pkcs8(&base64_decode(&text(
        &fixture("signing")["keys"][1]["value"],
    )))
    .unwrap();
    let rows = &f["rows"];
    let second_mac = s(&rows["approval_chain"][1]["mac"]).to_owned();
    let other_sig = other.sign(&second_mac).signature;
    let now = f["now"].as_i64().unwrap() + 90 * 60_000;
    let mut played = 0;
    for t in f["tampers"].as_array().unwrap() {
        let (_dir, store) = fresh();
        load(store.conn(), rows);
        for sql in t["sql"].as_array().unwrap() {
            let sql = s(sql)
                .replace("$OTHER_PUBLIC_KEY", other.public_key())
                .replace("$OTHER_SIGNATURE", &other_sig);
            store.conn().execute_batch(&sql).unwrap();
        }
        let clock = Arc::new(SetClock::at(now));
        let name = s(&t["name"]);
        if name == "other-key" {
            let chain = ApprovalChain::new(&key_of(&t["otherKey"]), clock, None).unwrap();
            assert_eq!(
                chain.verify(store.conn()).unwrap().json(),
                t["verifyUnsigned"]
            );
            played += 1;
            continue;
        }
        let signed = ApprovalChain::new(&key, clock.clone(), Some(Arc::clone(&signer))).unwrap();
        assert_eq!(
            signed.verify(store.conn()).unwrap().json(),
            t["verifySigned"],
            "{name}, with the signer"
        );
        let unsigned = ApprovalChain::new(&key, clock.clone(), None).unwrap();
        assert_eq!(
            unsigned.verify(store.conn()).unwrap().json(),
            t["verifyUnsigned"],
            "{name}, without the signer"
        );
        let grants = GrantStore::new(
            clock.clone(),
            Arc::new(OsRandom),
            None,
            Some(s(&f["home"]).to_owned()),
        );
        let states: Vec<Value> = grants
            .inspect(store.conn(), &unsigned, None, None)
            .unwrap()
            .into_iter()
            .map(|v| {
                let g = &v.grant;
                json!([
                    g["id"],
                    v.state.as_str(),
                    g.get("revoked") == Some(&json!(true)),
                    g.get("consumedAt").cloned().unwrap_or(Value::Null),
                    g.get("lastUsedAt").cloned().unwrap_or(Value::Null)
                ])
            })
            .collect();
        assert_eq!(
            Value::Array(states),
            t["states"],
            "{name}: the grant states"
        );
        let approvals = ApprovalStore::new(unsigned, clock, Arc::new(OsRandom), None);
        let listed = match approvals.list(store.conn(), None, None) {
            Ok(list) => Value::Array(
                list.iter()
                    .map(|r| json!([r.id, r.status.as_str()]))
                    .collect(),
            ),
            Err(super::ApprovalError::Integrity { .. }) => json!({ "error": "ApprovalChainError" }),
            Err(e) => panic!("{name}: {e}"),
        };
        assert_eq!(listed, t["approvals"], "{name}: the approval list");
        played += 1;
    }
    assert_eq!(played, f["tampers"].as_array().unwrap().len());
}

#[test]
fn the_grant_rules_accept_and_refuse_what_typescript_does() {
    let f = fixture("rules");
    let c = fixture("chain");
    let platform = "darwin";
    let (_dir, mut store) = fresh();
    let clock = Arc::new(SetClock::at(c["now"].as_i64().unwrap()));
    let chain = ApprovalChain::new(&key_of(&c["key"]), clock.clone(), None).unwrap();
    let grants = GrantStore::new(
        clock,
        Arc::new(OsRandom),
        None,
        Some(s(&c["home"]).to_owned()),
    )
    .with_platform(platform);
    for (i, r) in f.as_array().unwrap().iter().enumerate() {
        let mut input = grant_input(&r["input"], r.get("nonFinite"));
        input.id = Some(format!("grt_rule_{i}"));
        if let Some(id) = r["input"].get("id").and_then(Value::as_str) {
            input.id = Some(id.to_owned());
        }
        let got = grant_result(
            store.write_with(|tx| grants.create(tx, &chain, &mut super::NoAudit, &input)),
        );
        let want = r["result"]
            .get("grant")
            .cloned()
            .unwrap_or_else(|| r["result"].clone());
        assert_eq!(got, want, "{}", r["name"]);
    }
}
