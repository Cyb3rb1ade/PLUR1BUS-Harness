//! Replay of the sequences recorded from the TypeScript identity store and service (`scripts/parity/export-identity-store.ts`,
//! `fixtures/parity/identity-store/`): every step's result or error, its audit events, the random draws it consumed and the
//! content of every table afterwards. Recorded, never edited by hand. Plus what the recording cannot hold: file modes, the
//! migration of an older file, an injected policy.
use super::authorization::{AuthorizePort, IdentityAction};
use super::codes::RandomSource;
use super::recall::{create_recall_scope_provider, RecallScopeProvider};
use super::service::{Actor, ChannelIdentity};
use super::service_impl::{
    AuditEvent, BackfillState, IdentityFailure, IdentityOptions, IdentityService,
};
use super::store::{open_store, MIGRATIONS};
use crate::rbac::types::{PrincipalKind, Role};
use plur1bus_store::rusqlite::{self, types::ValueRef, Connection};
use serde_json::{json, Map, Value};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::rc::Rc;

const TABLES: [&str; 5] = ["humans", "identities", "backfills", "attempts", "pairings"];

fn load(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/parity/identity-store/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The recorded draws of one step, handed out in order; a draw of the other kind or a missing one fails the step.
pub(super) struct Draws(pub(super) Rc<RefCell<VecDeque<Value>>>);

impl RandomSource for Draws {
    fn random_int(&mut self, max: u32) -> u32 {
        let d = self
            .0
            .borrow_mut()
            .pop_front()
            .expect("randomInt: no draw recorded");
        assert_eq!(
            d["below"],
            json!(max),
            "randomInt({max}) against the recorded draw {d}"
        );
        d["int"].as_u64().unwrap() as u32
    }
    fn fill_bytes(&mut self, out: &mut [u8]) {
        let d = self
            .0
            .borrow_mut()
            .pop_front()
            .expect("randomBytes: no draw recorded");
        let hex = d["bytes"]
            .as_str()
            .unwrap_or_else(|| panic!("randomBytes against the recorded draw {d}"));
        assert_eq!(
            hex.len(),
            out.len() * 2,
            "randomBytes({}) against {d}",
            out.len()
        );
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
        }
    }
}

fn actor_of(v: &Value) -> Actor {
    Actor {
        user: v["user"].as_str().unwrap().to_owned(),
        host: v["host"].as_str().unwrap().to_owned(),
        kind: v
            .get("kind")
            .map(|k| PrincipalKind::parse(k.as_str().unwrap()).unwrap()),
        role: v
            .get("role")
            .map(|r| Role::parse(r.as_str().unwrap()).unwrap()),
        token_scopes: v.get("tokenScopes").map(|s| {
            s.as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap().to_owned())
                .collect()
        }),
    }
}

fn identity_arg(v: &Value) -> ChannelIdentity {
    ChannelIdentity {
        channel: v["channel"].as_str().unwrap().to_owned(),
        account_id: v["accountId"].as_str().unwrap().to_owned(),
        user_id: v["userId"].as_str().unwrap().to_owned(),
        display_name: v.get("displayName").map(|d| d.as_str().unwrap().to_owned()),
    }
}

fn failure_json(e: &IdentityFailure) -> Value {
    match e {
        IdentityFailure::Refused(e) => {
            let mut out = Map::new();
            out.insert("code".into(), json!(e.code.as_str()));
            out.insert("message".into(), json!(e.message));
            if let Some(field) = &e.field {
                out.insert("field".into(), json!(field));
            }
            if let Some(ms) = e.retry_after_ms {
                out.insert("retryAfterMs".into(), json!(ms));
            }
            Value::Object(out)
        }
        IdentityFailure::Sqlite(rusqlite::Error::SqliteFailure(code, _)) => {
            json!({ "sqlite": code.extended_code })
        }
        IdentityFailure::Sqlite(other) => json!({ "sqlite": other.to_string() }),
    }
}

fn dump(conn: &Connection, table: &str) -> Value {
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
        .unwrap();
    let width = stmt.column_count();
    let rows = stmt
        .query_map([], |row| {
            let mut out = Vec::with_capacity(width);
            for i in 0..width {
                out.push(match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(f) => json!(f),
                    ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                    ValueRef::Blob(b) => json!(b),
                });
            }
            Ok(Value::Array(out))
        })
        .unwrap();
    Value::Array(rows.map(Result::unwrap).collect())
}

struct World {
    file: PathBuf,
    clock: Rc<Cell<i64>>,
    draws: Rc<RefCell<VecDeque<Value>>>,
    events: Rc<RefCell<Vec<Value>>>,
    sink_down: Rc<Cell<bool>>,
    service: Option<IdentityService>,
}

impl World {
    fn new(file: PathBuf) -> World {
        World {
            file,
            clock: Rc::new(Cell::new(0)),
            draws: Rc::default(),
            events: Rc::default(),
            sink_down: Rc::default(),
            service: None,
        }
    }

    fn open(&mut self, code_ttl_ms: Option<i64>) -> Result<(), IdentityFailure> {
        self.service = None;
        let (clock, events, down) = (
            self.clock.clone(),
            self.events.clone(),
            self.sink_down.clone(),
        );
        self.service = Some(IdentityService::create(IdentityOptions {
            db_path: self.file.clone(),
            clock: Box::new(move || clock.get()),
            audit: Box::new(move |e: &AuditEvent| {
                if down.get() {
                    return Err("audit sink down".to_owned());
                }
                events.borrow_mut().push(e.to_json());
                Ok(())
            }),
            random: Box::new(Draws(self.draws.clone())),
            secure_path: Box::new(|_| {}),
            authorize: None,
            code_ttl_ms,
        })?);
        Ok(())
    }

    fn call(&mut self, op: &str, a: &Value) -> Result<Value, IdentityFailure> {
        let s = |key: &str| {
            a[key]
                .as_str()
                .unwrap_or_else(|| panic!("{op}: no string {key} in {a}"))
        };
        if op == "open" {
            return self
                .open(a.get("codeTtlMs").map(|v| v.as_i64().unwrap()))
                .map(|()| Value::Null);
        }
        if op == "sink" {
            self.sink_down.set(a["down"].as_bool().unwrap());
            return Ok(Value::Null);
        }
        if op == "close" {
            self.service = None;
            return Ok(Value::Null);
        }
        let svc = self
            .service
            .as_mut()
            .unwrap_or_else(|| panic!("{op} without an open service"));
        let flag = |key: &str| a.get(key).and_then(Value::as_bool).unwrap_or(false);
        Ok(match op {
            "sql" => {
                svc.conn().execute_batch(s("text"))?;
                Value::Null
            }
            "createHuman" => svc
                .create_human(s("displayName"), &actor_of(&a["actor"]))?
                .to_json(),
            "link" => svc
                .link(
                    s("humanId"),
                    &identity_arg(&a["identity"]),
                    &actor_of(&a["actor"]),
                )?
                .to_json(),
            "revokePairing" => svc
                .revoke_pairing(s("id"), &actor_of(&a["actor"]))
                .map(|()| Value::Null)?,
            "startPairing" => svc
                .start_pairing(
                    s("humanId"),
                    s("channel"),
                    a.get("ttlMs").map(|v| v.as_f64().unwrap()),
                    &actor_of(&a["actor"]),
                )?
                .to_json(),
            "claim" => svc
                .claim(s("code"), &identity_arg(&a["identity"]))?
                .to_json(),
            "confirm" => svc
                .confirm(
                    s("pairingId"),
                    a["approve"].as_bool().unwrap(),
                    &actor_of(&a["actor"]),
                )?
                .to_json(),
            "unlink" => svc.unlink(s("linkId"), &actor_of(&a["actor"]))?.to_json(),
            "list" => svc
                .list(flag("includeRevoked"), flag("includeResolvedPairings"))?
                .to_json(),
            "resolve" => {
                let i = identity_arg(&a["identity"]);
                svc.resolve(&i.channel, &i.account_id, &i.user_id)?
                    .map_or(Value::Null, |r| r.to_json())
            }
            "linkedV1Principals" => json!(svc.linked_v1_principals(s("humanId"))?),
            "jobLink" => svc
                .job_link(s("humanId"))?
                .map_or(Value::Null, |l| l.to_json()),
            "resolvePrincipals" => json!(svc.resolve_principals(s("userV2"))?),
            "getLink" => svc.get_link(s("linkId"))?.to_json(),
            "backfillRecord" => svc
                .backfill_record(s("linkId"))?
                .map_or(Value::Null, |r| r.to_json()),
            "reserveBackfill" => svc
                .reserve_backfill(s("linkId"), s("operationId"), &actor_of(&a["actor"]))
                .map(|()| Value::Null)?,
            "finishBackfill" => svc
                .finish_backfill(
                    s("linkId"),
                    BackfillState::parse(s("state")).unwrap(),
                    a["count"].as_i64().unwrap(),
                    s("receipt"),
                )
                .map(|()| Value::Null)?,
            "authorizeAction" => svc
                .authorize_action(
                    IdentityAction::parse(s("action")).unwrap(),
                    s("user"),
                    &actor_of(&a["actor"]),
                )
                .map(|()| Value::Null)?,
            "emit" => {
                let e = &a["event"];
                let actor = e.get("actor").map(actor_of);
                let detail = e["detail"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.as_str(), v.clone()))
                    .collect();
                svc.emit(
                    e["action"].as_str().unwrap(),
                    e["target"].as_str().unwrap(),
                    detail,
                    actor.as_ref(),
                );
                Value::Null
            }
            other => panic!("unknown op {other}"),
        })
    }
}

#[test]
fn every_recorded_sequence_replays_step_for_step() {
    let fixture = load("scenarios");
    let scenarios = fixture["scenarios"].as_array().unwrap();
    assert!(scenarios.len() >= 14, "{} scenarios", scenarios.len());
    let (mut steps, mut failures) = (0usize, Vec::new());
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let mut w = World::new(dir.path().join("state").join("identity.sqlite"));
        let mut tables: BTreeMap<&str, Value> = TABLES.iter().map(|t| (*t, json!([]))).collect();
        for (index, line) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let step: Value = serde_json::from_str(line.as_str().unwrap()).unwrap();
            let op = step["op"].as_str().unwrap();
            steps += 1;
            w.clock.set(step["at"].as_i64().unwrap());
            w.events.borrow_mut().clear();
            *w.draws.borrow_mut() = step["draws"].as_array().unwrap().iter().cloned().collect();
            let out = match w.call(op, &step["args"]) {
                Ok(v) => json!({ "ok": v }),
                Err(e) => json!({ "err": failure_json(&e) }),
            };
            let mut wrong = Vec::new();
            if out != step["out"] {
                wrong.push(format!("out {out} instead of {}", step["out"]));
            }
            let audit = Value::Array(w.events.borrow().clone());
            if audit != step["audit"] {
                wrong.push(format!("audit {audit} instead of {}", step["audit"]));
            }
            if !w.draws.borrow().is_empty() {
                wrong.push(format!(
                    "{} recorded draws not consumed",
                    w.draws.borrow().len()
                ));
            }
            if let Some(changed) = step.get("tables") {
                for (table, rows) in changed.as_object().unwrap() {
                    let slot = tables
                        .get_mut(table.as_str())
                        .unwrap_or_else(|| panic!("table {table}"));
                    *slot = rows.clone();
                }
            }
            if let Some(svc) = &w.service {
                for table in TABLES {
                    let actual = dump(svc.conn(), table);
                    if actual != tables[table] {
                        wrong.push(format!(
                            "table {table} is {actual} instead of {}",
                            tables[table]
                        ));
                    }
                }
            }
            if !wrong.is_empty() {
                failures.push(format!(
                    "{name} step {index} ({op} {}): {}",
                    step["args"],
                    wrong.join("; ")
                ));
                break; // the rest of a sequence depends on this step
            }
        }
    }
    assert!(steps >= 600, "{steps} steps");
    assert!(
        failures.is_empty(),
        "{} of {} sequences differ:\n{}",
        failures.len(),
        scenarios.len(),
        failures.join("\n")
    );
}

pub(super) fn master(conn: &Connection, table: &str) -> Value {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT type, name, tbl_name, sql FROM {table} ORDER BY type, name"
        ))
        .unwrap();
    let rows = stmt
        .query_map([], |row| {
            Ok(
                json!({ "type": row.get::<_, String>(0)?, "name": row.get::<_, String>(1)?,
                "tbl_name": row.get::<_, String>(2)?, "sql": row.get::<_, Option<String>>(3)? }),
            )
        })
        .unwrap();
    Value::Array(rows.map(Result::unwrap).collect())
}

pub(super) fn pragma(conn: &Connection, name: &str) -> Value {
    conn.pragma_query_value(None, name, |row| {
        Ok(match row.get_ref(0)? {
            ValueRef::Integer(n) => json!(n),
            ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
            other => panic!("pragma {name}: {other:?}"),
        })
    })
    .unwrap()
}

#[test]
fn a_fresh_store_has_the_schema_and_the_pragmas_of_the_typescript_store() {
    let schema = load("schema");
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(&dir.path().join("identity.sqlite"), &|_| {}).unwrap();
    let conn = store.conn();
    assert_eq!(master(conn, "sqlite_master"), schema["master"]);
    assert_eq!(master(conn, "sqlite_temp_master"), schema["temp"]);
    for (name, value) in schema["pragmas"].as_object().unwrap() {
        assert_eq!(&pragma(conn, name), value, "PRAGMA {name}");
    }
    for (table, columns) in schema["columns"].as_object().unwrap() {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |row| row.get(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(&json!(names), columns, "columns of {table}");
    }
}

#[test]
fn a_file_at_schema_one_is_migrated_and_keeps_its_rows() {
    let schema = load("schema");
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("identity.sqlite");
    let old = Connection::open(&file).unwrap();
    old.execute_batch(MIGRATIONS[0]).unwrap();
    old.execute_batch(
        "INSERT INTO humans VALUES ('h', 'Ada', 1, 'owner');
         INSERT INTO pairings(id, human_id, channel, salt, code_hash, state, created_at, created_by, expires_at) VALUES ('p', 'h', 'telegram', 's', 'c', 'pending', 1, 'owner', 2);
         PRAGMA user_version = 1;",
    )
    .unwrap();
    drop(old);
    let store = open_store(&file, &|_| {}).unwrap();
    assert_eq!(
        master(store.conn(), "sqlite_master"),
        schema["master"],
        "the durable pairings table is gone, backfills is there"
    );
    assert_eq!(
        dump(store.conn(), "humans"),
        json!([["h", "Ada", 1, "owner"]])
    );
    assert_eq!(
        dump(store.conn(), "pairings"),
        json!([]),
        "the connection's own, empty table"
    );
    assert_eq!(pragma(store.conn(), "user_version"), json!(2));
}

#[test]
fn a_newer_file_is_refused_and_left_as_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("identity.sqlite");
    let newer = Connection::open(&file).unwrap();
    newer
        .execute_batch("CREATE TABLE future (x); PRAGMA user_version = 9;")
        .unwrap();
    drop(newer);
    let refused = open_store(&file, &|_| {}).err().unwrap();
    assert_eq!(refused.code.as_str(), "storage");
    assert_eq!(
        refused.message,
        "identity store is schema 9, newer than this harness (2)"
    );
    let conn = Connection::open(&file).unwrap();
    assert_eq!(pragma(&conn, "user_version"), json!(9));
    assert_eq!(pragma(&conn, "journal_mode"), json!("delete"));
    assert_eq!(dump(&conn, "future"), json!([]));
}

#[cfg(unix)]
#[test]
fn the_directory_and_the_file_are_created_private_and_secure_path_sees_the_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a").join("b").join("identity.sqlite");
    let seen: RefCell<Vec<PathBuf>> = RefCell::default();
    let store = open_store(&file, &|p: &Path| seen.borrow_mut().push(p.to_path_buf())).unwrap();
    drop(store);
    assert_eq!(seen.borrow().as_slice(), std::slice::from_ref(&file));
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&file), 0o600);
    assert_eq!(mode(file.parent().unwrap()), 0o700);
    assert_eq!(
        mode(file.parent().unwrap().parent().unwrap()),
        0o700,
        "every directory it had to create"
    );
    // An existing file keeps its mode: only `secure_path` (the host's port) tightens it.
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    drop(open_store(&file, &|_| {}).unwrap());
    assert_eq!(mode(&file), 0o644);
}

fn service(dir: &Path, authorize: Option<Box<dyn AuthorizePort>>) -> IdentityService {
    struct Counter(u8);
    impl RandomSource for Counter {
        fn random_int(&mut self, max: u32) -> u32 {
            self.0 = self.0.wrapping_add(1);
            u32::from(self.0) % max
        }
        fn fill_bytes(&mut self, out: &mut [u8]) {
            for b in out {
                self.0 = self.0.wrapping_add(1);
                *b = self.0;
            }
        }
    }
    IdentityService::create(IdentityOptions {
        db_path: dir.join("identity.sqlite"),
        clock: Box::new(|| 1_760_000_000_000),
        audit: Box::new(|_: &AuditEvent| Ok(())),
        random: Box::new(Counter(0)),
        secure_path: Box::new(|_| {}),
        authorize,
        code_ttl_ms: None,
    })
    .unwrap()
}

fn person(user: &str, role: Role) -> Actor {
    Actor {
        user: user.to_owned(),
        host: "h".to_owned(),
        kind: Some(PrincipalKind::Person),
        role: Some(role),
        token_scopes: None,
    }
}

#[test]
fn an_injected_policy_narrows_and_extends_people_and_never_admits_an_agent() {
    struct OnlyViewers;
    impl AuthorizePort for OnlyViewers {
        fn authorize(&self, actor: &Actor, _: IdentityAction, _: &str) -> bool {
            actor.role == Some(Role::Viewer) || actor.kind == Some(PrincipalKind::Agent)
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let mut svc = service(dir.path(), Some(Box::new(OnlyViewers)));
    let denied = |r: Result<_, IdentityFailure>| matches!(r, Err(IdentityFailure::Refused(e)) if e.code.as_str() == "denied");
    assert!(
        denied(svc.create_human("Ada", &person("o", Role::Owner)).map(drop)),
        "narrowed: the owner is refused"
    );
    let human = svc.create_human("Ada", &person("v", Role::Viewer)).unwrap();
    let agent = Actor {
        kind: Some(PrincipalKind::Agent),
        ..person("v", Role::Viewer)
    };
    assert!(
        denied(svc.create_human("Bo", &agent).map(drop)),
        "the policy says yes, the gate says no"
    );
    let no_kind = Actor {
        kind: None,
        ..person("v", Role::Viewer)
    };
    assert!(denied(
        svc.start_pairing(&human.id, "telegram", None, &no_kind)
            .map(drop)
    ));
}

#[test]
fn the_recall_scope_provider_reads_the_union_from_the_service() {
    let dir = tempfile::tempdir().unwrap();
    let mut svc = service(dir.path(), None);
    let owner = person("o", Role::Owner);
    let human = svc.create_human("Ada", &owner).unwrap();
    let handle = ChannelIdentity {
        channel: "telegram".into(),
        account_id: "bot".into(),
        user_id: "1".into(),
        display_name: None,
    };
    let link = svc.link(&human.id, &handle, &owner).unwrap();
    let v2 = super::principals::derive_user_principal(&human.id).unwrap();
    let provider = create_recall_scope_provider(svc);
    assert_eq!(
        provider.resolve_principals(&v2).unwrap(),
        [v2.clone(), link.v1_principal]
    );
    assert_eq!(provider.capture_principal(&v2).unwrap(), v2);
    let unknown = format!("user:v2:{}", "0".repeat(64));
    assert_eq!(
        provider
            .capture_principal(&unknown)
            .unwrap_err()
            .code
            .as_str(),
        "not-found"
    );
}
