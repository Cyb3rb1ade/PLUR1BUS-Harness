//! Replay of the sequences recorded from the TypeScript admin store and desktop attach store
//! (`scripts/parity/export-identity-admin.ts`, `fixtures/parity/identity-admin/`): every step's result or error, the calls of
//! `beforeCommit`, the audit events, the random draws and every table afterwards. Recorded, never edited by hand.
use super::admin_store::{AdminError, AdminStore, InviteRow, NewInvite, StoredNotice};
use super::desktop_attach::{
    AttachError, DesktopAttach, DesktopAttachOptions, Device, DeviceErrorCode, DeviceStore,
    PairDevice,
};
use super::service_vectors::{master, pragma, Draws};
use crate::rbac::audit::AuditEvent;
use crate::rbac::types::{AgentRight, Principal, PrincipalKind, Role};
use plur1bus_store::rusqlite::{self, types::ValueRef, Connection};
use serde_json::{json, Map, Value};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::rc::Rc;

const ADMIN_TABLES: [&str; 5] = [
    "admin_roles",
    "admin_rights",
    "admin_notices",
    "admin_invites",
    "attempts",
];
const ATTACH_TABLES: [&str; 2] = ["codes", "credentials"];
const OLDER_ROLES: &str = "CREATE TABLE admin_roles (user_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','member','viewer'))) STRICT;";
const OLDER_CODES: &str = "CREATE TABLE codes (hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,person_version INTEGER NOT NULL,expires_at INTEGER NOT NULL) STRICT;";

fn load(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/parity/identity-admin/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn dump(conn: &Connection, table: &str) -> Value {
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {table} ORDER BY 1, 2"))
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

fn sqlite_code(e: &rusqlite::Error) -> Value {
    match e {
        rusqlite::Error::SqliteFailure(code, _) => json!({ "sqlite": code.extended_code }),
        other => json!({ "sqlite": other.to_string() }),
    }
}

fn principal_of(v: &Value) -> Principal {
    let mut p = Principal::new(
        v["userId"].as_str().unwrap(),
        Role::parse(v["role"].as_str().unwrap()).unwrap(),
    );
    p.kind = v
        .get("kind")
        .map(|k| PrincipalKind::parse(k.as_str().unwrap()).unwrap());
    p.agent_rights = v.get("agentRights").map(|r| {
        r.as_object()
            .unwrap()
            .iter()
            .map(|(agent, right)| {
                (
                    agent.clone(),
                    if right == "manage" {
                        AgentRight::Manage
                    } else {
                        AgentRight::Use
                    },
                )
            })
            .collect()
    });
    p.token_scopes = v.get("tokenScopes").map(|s| {
        s.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_owned())
            .collect()
    });
    p
}

fn principal_json(p: &Principal) -> Value {
    let mut out = Map::new();
    out.insert("userId".into(), json!(p.user_id));
    out.insert("role".into(), json!(p.role.as_str()));
    if let Some(kind) = p.kind {
        out.insert("kind".into(), json!(kind.as_str()));
    }
    if let Some(rights) = &p.agent_rights {
        out.insert(
            "agentRights".into(),
            Value::Object(
                rights
                    .iter()
                    .map(|(a, r)| (a.clone(), json!(r.as_str())))
                    .collect(),
            ),
        );
    }
    if let Some(scopes) = &p.token_scopes {
        out.insert("tokenScopes".into(), json!(scopes));
    }
    Value::Object(out)
}

/// Runs the steps of one scenario; `call` answers a step with its `out` and what else the step recorded (`hooks`,
/// `audit`, `draws` left over), `conn` gives the connection for the dumps when the store is open.
fn replay(
    name: &str,
    scenario: &Value,
    tables: &[&'static str],
    mut call: impl FnMut(&Value) -> (Value, Vec<String>),
    mut dumps: impl FnMut(&str) -> Option<Value>,
) -> (usize, Option<String>) {
    let mut expected: BTreeMap<&str, Value> = tables.iter().map(|t| (*t, json!([]))).collect();
    let steps = scenario["steps"].as_array().unwrap();
    for (index, line) in steps.iter().enumerate() {
        let step: Value = serde_json::from_str(line.as_str().unwrap()).unwrap();
        let (out, mut wrong) = call(&step);
        if out != step["out"] {
            wrong.push(format!("out {out} instead of {}", step["out"]));
        }
        if let Some(changed) = step.get("tables") {
            for (table, rows) in changed.as_object().unwrap() {
                *expected
                    .get_mut(table.as_str())
                    .unwrap_or_else(|| panic!("table {table}")) = rows.clone();
            }
        }
        for table in tables {
            if let Some(actual) = dumps(table) {
                if actual != expected[table] {
                    wrong.push(format!(
                        "table {table} is {actual} instead of {}",
                        expected[table]
                    ));
                }
            }
        }
        if !wrong.is_empty() {
            return (
                index + 1,
                Some(format!(
                    "{name} step {index} ({} {}): {}",
                    step["op"],
                    step["args"],
                    wrong.join("; ")
                )),
            );
        }
    }
    (steps.len(), None)
}

fn admin_error(e: &AdminError) -> Value {
    match e {
        AdminError::Rpc {
            code,
            message,
            reason,
        } => {
            let mut out = json!({ "rpc": code, "message": message });
            if let Some(reason) = reason {
                out["reason"] = json!(reason);
            }
            out
        }
        AdminError::Hook(_) => json!({ "hook": true }),
        AdminError::Sqlite(e) => sqlite_code(e),
        AdminError::Storage(e) => json!({ "storage": e }),
    }
}

fn admin_call(
    store: &mut Option<AdminStore>,
    file: &Path,
    hooks: &RefCell<Vec<Value>>,
    op: &str,
    a: &Value,
) -> Result<Value, AdminError> {
    let s = |key: &str| {
        a[key]
            .as_str()
            .unwrap_or_else(|| panic!("{op}: no string {key} in {a}"))
    };
    let fail = a.get("hook").is_some_and(|h| h == "fail");
    let mut hook = || {
        hooks.borrow_mut().push(Value::Null);
        if fail {
            Err("hook failed".to_owned())
        } else {
            Ok(())
        }
    };
    match op {
        "open" => {
            *store = None;
            *store = Some(AdminStore::open(file, s("ownerId"), &|_| {})?);
            return Ok(Value::Null);
        }
        "raw" => {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            Connection::open(file).unwrap().execute_batch(s("text"))?;
            return Ok(Value::Null);
        }
        "close" => {
            *store = None;
            return Ok(Value::Null);
        }
        _ => {}
    }
    let st = store
        .as_mut()
        .unwrap_or_else(|| panic!("{op} without an open store"));
    Ok(match op {
        "sql" => {
            st.conn().execute_batch(s("text"))?;
            Value::Null
        }
        "role" => json!(st
            .role(
                s("id"),
                a.get("fallback")
                    .map_or(Role::Member, |f| Role::parse(f.as_str().unwrap()).unwrap())
            )?
            .as_str()),
        "users" => Value::Array(st.users()?.iter().map(|u| u.to_json()).collect()),
        "person" => st.person(s("id"))?.map_or(Value::Null, |p| {
            let mut v = principal_json(&p.principal);
            v["disabled"] = json!(p.disabled);
            v["version"] = json!(p.version);
            v
        }),
        "resolvePerson" => st
            .resolve_person(s("id"))?
            .map_or(Value::Null, |p| principal_json(&p)),
        "setDisabled" => st
            .set_disabled(
                s("id"),
                a["disabled"].as_bool().unwrap(),
                s("by"),
                a["now"].as_i64().unwrap(),
                &mut hook,
            )
            .map(|()| Value::Null)?,
        "validateInvite" => st
            .validate_invite(a["hash"].as_str(), a["now"].as_i64().unwrap())?
            .map_or(Value::Null, |i| i.to_json()),
        "setRole" => st
            .set_role(s("id"), s("role"), &mut hook)
            .map(|()| Value::Null)?,
        "rights" => Value::Array(
            st.rights(s("agentId"))?
                .iter()
                .map(|(user, right)| json!({ "userId": user, "right": right }))
                .collect(),
        ),
        "setRight" => st
            .set_right(s("agentId"), s("userId"), a["right"].as_str())
            .map(|()| Value::Null)?,
        "resolve" => principal_json(&st.resolve(&principal_of(&a["principal"]))?),
        "invite" => {
            let i = &a["invite"];
            let text = |key: &str| i[key].as_str().unwrap().to_owned();
            st.invite(&NewInvite {
                id: text("id"),
                user_id: text("userId"),
                role: text("role"),
                channel: text("channel"),
                expires_at: i["expiresAt"].as_i64().unwrap(),
                created_at: i["createdAt"].as_i64().unwrap(),
                created_by: text("createdBy"),
                token_hash: i.get("tokenHash").map(|t| t.as_str().unwrap().to_owned()),
            })
            .map(|()| Value::Null)?
        }
        "notice" => {
            let n = &a["notice"];
            let text = |key: &str| n[key].as_str().unwrap().to_owned();
            assert_eq!(n["kind"], "granted");
            st.notice(&StoredNotice {
                user_id: text("userId"),
                grant_id: text("grantId"),
                holder_user_id: text("holderUserId"),
                reason: text("reason"),
                expires_at: n["expiresAt"].as_i64().unwrap(),
            })
            .map(|()| Value::Null)?
        }
        "notices" => Value::Array(st.notices(s("userId"))?),
        "allNotices" => Value::Array(st.all_notices()?),
        "invites" => Value::Array(st.invites()?.iter().map(InviteRow::to_json).collect()),
        "revoke" => st.revoke(s("id")).map(|()| Value::Null)?,
        "redeem" => {
            let mut hook = |invite: &InviteRow| {
                hooks.borrow_mut().push(invite.to_json());
                if fail {
                    Err("hook failed".to_owned())
                } else {
                    Ok(())
                }
            };
            st.redeem(
                a["tokenHash"].as_str(),
                a["now"].as_i64().unwrap(),
                s("source"),
                &mut hook,
            )?
            .to_json()
        }
        other => panic!("unknown op {other}"),
    })
}

#[test]
fn every_recorded_admin_sequence_replays_step_for_step() {
    let fixture = load("admin");
    let scenarios = fixture["scenarios"].as_array().unwrap();
    assert!(scenarios.len() >= 7);
    let (mut steps, mut failures) = (0, Vec::new());
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state").join("admin.sqlite");
        let store: RefCell<Option<AdminStore>> = RefCell::new(None);
        let hooks: RefCell<Vec<Value>> = RefCell::default();
        let (ran, failure) = replay(
            name,
            scenario,
            &ADMIN_TABLES,
            |step| {
                hooks.borrow_mut().clear();
                let out = match admin_call(
                    &mut store.borrow_mut(),
                    &file,
                    &hooks,
                    step["op"].as_str().unwrap(),
                    &step["args"],
                ) {
                    Ok(v) => json!({ "ok": v }),
                    Err(e) => json!({ "err": admin_error(&e) }),
                };
                let seen = Value::Array(hooks.borrow().clone());
                let recorded = step.get("hooks").cloned().unwrap_or_else(|| json!([]));
                let wrong = if seen == recorded {
                    Vec::new()
                } else {
                    vec![format!("hook calls {seen} instead of {recorded}")]
                };
                (out, wrong)
            },
            |table| store.borrow().as_ref().map(|s| dump(s.conn(), table)),
        );
        steps += ran;
        failures.extend(failure);
    }
    assert!(steps >= 160, "{steps} steps");
    assert!(
        failures.is_empty(),
        "{} sequences differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// The stub the TypeScript recording used for the device store: numbered devices, one refused key.
struct Devices {
    list: Rc<RefCell<Vec<Device>>>,
    clock: Rc<Cell<i64>>,
}

impl DeviceStore for Devices {
    fn record_pairing(&mut self, input: &PairDevice) -> Result<Device, DeviceErrorCode> {
        if input.public_key == "refuse" {
            return Err(DeviceErrorCode::Conflict);
        }
        let n = self.list.borrow().len() + 1;
        let d = Device {
            id: format!("dev-{n}"),
            name: input.name.clone(),
            platform: input.platform.clone(),
            public_key: input.public_key.clone(),
            fingerprint: format!("fp-{n}"),
            paired_at: self.clock.get(),
            last_seen_at: self.clock.get(),
            paired_by: input.paired_by.clone(),
            scope: input.scope.clone(),
            revoked: false,
            revoked_at: None,
            revoked_by: None,
        };
        self.list.borrow_mut().push(d.clone());
        Ok(d)
    }
    fn get(&self, id: &str) -> Result<Device, DeviceErrorCode> {
        self.list
            .borrow()
            .iter()
            .find(|d| d.id == id)
            .cloned()
            .ok_or(DeviceErrorCode::NotFound)
    }
}

struct AttachWorld {
    file: PathBuf,
    clock: Rc<Cell<i64>>,
    devices: Rc<RefCell<Vec<Device>>>,
    versions: Rc<RefCell<HashMap<String, Option<i64>>>>,
    sink_down: Rc<Cell<bool>>,
    events: Rc<RefCell<Vec<Value>>>,
    draws: Rc<RefCell<VecDeque<Value>>>,
    attach: Option<DesktopAttach>,
}

fn attach_error(e: &AttachError) -> Value {
    match e {
        AttachError::Device(code) => json!({ "device": code.as_str() }),
        AttachError::Audit(_) => json!({ "audit": true }),
        AttachError::Sqlite(e) => sqlite_code(e),
        AttachError::Io(e) => json!({ "io": e }),
    }
}

impl AttachWorld {
    fn new(file: PathBuf) -> AttachWorld {
        AttachWorld {
            file,
            clock: Rc::default(),
            devices: Rc::default(),
            versions: Rc::default(),
            sink_down: Rc::default(),
            events: Rc::default(),
            draws: Rc::default(),
            attach: None,
        }
    }

    fn open(&mut self, versioned: bool) -> Result<(), AttachError> {
        self.attach = None;
        let (clock, events, down, versions) = (
            self.clock.clone(),
            self.events.clone(),
            self.sink_down.clone(),
            self.versions.clone(),
        );
        self.attach = Some(DesktopAttach::open(DesktopAttachOptions {
            file: self.file.clone(),
            devices: Box::new(Devices {
                list: self.devices.clone(),
                clock: self.clock.clone(),
            }),
            now: Box::new(move || clock.get()),
            audit: Box::new(move |e: &AuditEvent| {
                if down.get() {
                    return Err("sink down".to_owned());
                }
                events.borrow_mut().push(e.to_json());
                Ok(())
            }),
            secure_path: Box::new(|_| {}),
            person_version: versioned.then(|| {
                Box::new(move |id: &str| versions.borrow().get(id).copied().unwrap_or(Some(1)))
                    as super::desktop_attach::PersonVersion
            }),
            random: Box::new(Draws(self.draws.clone())),
        })?);
        Ok(())
    }

    fn call(&mut self, op: &str, a: &Value) -> Result<Value, AttachError> {
        let s = |key: &str| {
            a[key]
                .as_str()
                .unwrap_or_else(|| panic!("{op}: no string {key} in {a}"))
        };
        let flag = |key: &str| a.get(key).and_then(Value::as_bool).unwrap_or(false);
        match op {
            "open" => {
                return self
                    .open(a.get("personVersion") != Some(&json!(false)))
                    .map(|()| Value::Null)
            }
            "raw" => {
                std::fs::create_dir_all(self.file.parent().unwrap()).unwrap();
                Connection::open(&self.file)
                    .unwrap()
                    .execute_batch(s("text"))?;
                return Ok(Value::Null);
            }
            "close" => {
                self.attach = None;
                return Ok(Value::Null);
            }
            "device" => {
                let mut list = self.devices.borrow_mut();
                let d = list.iter_mut().find(|d| d.id == s("id")).unwrap();
                for (key, value) in a["set"].as_object().unwrap() {
                    match key.as_str() {
                        "scope" => {
                            d.scope = value
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|x| x.as_str().unwrap().to_owned())
                                .collect()
                        }
                        "platform" => d.platform = value.as_str().unwrap().to_owned(),
                        "revoked" => d.revoked = value.as_bool().unwrap(),
                        other => panic!("device field {other}"),
                    }
                }
                return Ok(Value::Null);
            }
            "person" => {
                self.versions
                    .borrow_mut()
                    .insert(s("id").to_owned(), a["version"].as_i64());
                return Ok(Value::Null);
            }
            "sink" => {
                self.sink_down.set(a["down"].as_bool().unwrap());
                return Ok(Value::Null);
            }
            _ => {}
        }
        let at = self
            .attach
            .as_mut()
            .unwrap_or_else(|| panic!("{op} without an open store"));
        Ok(match op {
            "sql" => {
                at.conn().execute_batch(s("text"))?;
                Value::Null
            }
            "issue" => at
                .issue(s("userId"), s("kind"), flag("extensions"), flag("imports"))?
                .to_json(),
            "redeem" => at
                .redeem(s("code"), s("kind"), s("name"), s("publicKey"))?
                .to_json(),
            "authenticate" => at.authenticate(s("token"))?.to_json(),
            "resolve" => at.resolve(s("deviceId"))?.to_json(),
            other => panic!("unknown op {other}"),
        })
    }
}

#[test]
fn every_recorded_desktop_attach_sequence_replays_step_for_step() {
    let fixture = load("attach");
    let scenarios = fixture["scenarios"].as_array().unwrap();
    assert!(scenarios.len() >= 4);
    let (mut steps, mut failures) = (0, Vec::new());
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let world = RefCell::new(AttachWorld::new(
            dir.path().join("state").join("desktop-attach.db"),
        ));
        let (ran, failure) = replay(
            name,
            scenario,
            &ATTACH_TABLES,
            |step| {
                let mut w = world.borrow_mut();
                w.clock.set(step["at"].as_i64().unwrap());
                w.events.borrow_mut().clear();
                *w.draws.borrow_mut() = step
                    .get("draws")
                    .map(|d| d.as_array().unwrap().iter().cloned().collect())
                    .unwrap_or_default();
                let out = match w.call(step["op"].as_str().unwrap(), &step["args"]) {
                    Ok(v) => json!({ "ok": v }),
                    Err(e) => json!({ "err": attach_error(&e) }),
                };
                let mut wrong = Vec::new();
                let audit = Value::Array(w.events.borrow().clone());
                let recorded = step.get("audit").cloned().unwrap_or_else(|| json!([]));
                if audit != recorded {
                    wrong.push(format!("audit {audit} instead of {recorded}"));
                }
                if !w.draws.borrow().is_empty() {
                    wrong.push(format!(
                        "{} recorded draws not consumed",
                        w.draws.borrow().len()
                    ));
                }
                (out, wrong)
            },
            |table| {
                world
                    .borrow()
                    .attach
                    .as_ref()
                    .map(|a| dump(a.conn(), table))
            },
        );
        steps += ran;
        failures.extend(failure);
    }
    assert!(steps >= 85, "{steps} steps");
    assert!(
        failures.is_empty(),
        "{} sequences differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

fn columns(conn: &Connection, table: &str) -> Value {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap();
    let names: Vec<String> = stmt
        .query_map([], |row| row.get(1))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    json!(names)
}

#[test]
fn both_stores_have_the_schema_of_the_typescript_stores_fresh_and_after_an_older_file() {
    let schema = load("schema");
    let dir = tempfile::tempdir().unwrap();
    for (key, before) in [("admin", None), ("admin-older", Some(OLDER_ROLES))] {
        let file = dir.path().join(format!("{key}.sqlite"));
        if let Some(sql) = before {
            Connection::open(&file).unwrap().execute_batch(sql).unwrap();
        }
        let store = AdminStore::open(&file, "owner-1", &|_| {}).unwrap();
        let expected = &schema[key];
        assert_eq!(
            master(store.conn(), "sqlite_master"),
            expected["master"],
            "{key}"
        );
        for (name, value) in expected["pragmas"].as_object().unwrap() {
            assert_eq!(&pragma(store.conn(), name), value, "{key}: PRAGMA {name}");
        }
        for (table, names) in expected["columns"].as_object().unwrap() {
            assert_eq!(
                &columns(store.conn(), table),
                names,
                "{key}: columns of {table}"
            );
        }
    }
    for (key, before) in [("attach", None), ("attach-older", Some(OLDER_CODES))] {
        let file = dir.path().join(format!("{key}.db"));
        if let Some(sql) = before {
            Connection::open(&file).unwrap().execute_batch(sql).unwrap();
        }
        let mut world = AttachWorld::new(file.clone());
        world.open(true).unwrap();
        let conn = world.attach.as_ref().unwrap().conn();
        // The TypeScript store sets only the busy timeout: foreign keys are what node:sqlite has on an untouched connection.
        assert_eq!(
            pragma(conn, "foreign_keys"),
            schema["node-default"]["foreign_keys"],
            "{key}"
        );
        assert_eq!(
            schema["node-default"]["foreign_keys"],
            json!(1),
            "node:sqlite enforces foreign keys by default"
        );
        assert_eq!(pragma(conn, "busy_timeout"), json!(5000), "{key}");
        let expected = &schema[key];
        assert_eq!(master(conn, "sqlite_master"), expected["master"], "{key}");
        for (name, value) in expected["file"].as_object().unwrap() {
            assert_eq!(&pragma(conn, name), value, "{key}: PRAGMA {name}");
        }
        for (table, names) in expected["columns"].as_object().unwrap() {
            assert_eq!(&columns(conn, table), names, "{key}: columns of {table}");
        }
    }
}

#[test]
fn a_path_that_is_not_a_regular_file_is_refused_as_storage() {
    let dir = tempfile::tempdir().unwrap();
    let as_dir = dir.path().join("a-directory");
    std::fs::create_dir(&as_dir).unwrap();
    let mut world = AttachWorld::new(as_dir);
    assert!(matches!(
        world.open(true),
        Err(AttachError::Device(DeviceErrorCode::Storage))
    ));
    #[cfg(unix)]
    {
        let real = dir.path().join("real.db");
        std::fs::write(&real, b"").unwrap();
        let link = dir.path().join("link.db");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let mut world = AttachWorld::new(link);
        assert!(
            matches!(
                world.open(true),
                Err(AttachError::Device(DeviceErrorCode::Storage))
            ),
            "a symbolic link, even to a regular file"
        );
        assert_eq!(
            std::fs::metadata(&real).unwrap().len(),
            0,
            "the target was not opened"
        );
    }
}
