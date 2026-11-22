//! Test doubles of the hand-off ports, driven by the "world" of a recorded scenario (`scripts/parity/export-handoff.ts`):
//! one shared state the clock, the identity lookup, the principal lookup, the audit sink and the session store all read, so
//! a scenario can change a link, a right or a session between two calls.
use super::{HumanLookup, MessageRecord, PrincipalLookup, SessionPort, SessionRecord};
use crate::approvals::Random;
use crate::budget::Clock;
use crate::identity::principals::derive_user_principal;
use crate::rbac::audit::{AuditEvent, AuditSink};
use crate::rbac::types::{AgentRight, Principal, PrincipalKind, Role};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub(crate) struct Sess {
    pub id: String,
    pub kind: String,
    pub owner: String,
    pub chat_key: Option<String>,
    pub agent_id: String,
    pub title: Option<String>,
    pub updated_at: i64,
    pub archived: bool,
    pub messages: Vec<MessageRecord>,
    /// `(text, fromSeq, toSeq)`.
    pub summaries: Vec<(String, i64, i64)>,
    /// `(hiddenFromSeq, hiddenToSeq, undone)`.
    pub rewinds: Vec<(i64, i64, bool)>,
}

pub(crate) struct World {
    pub now: i64,
    pub base_url: String,
    pub agent_id: String,
    /// `(channel, accountId, userId, human)`.
    pub links: Vec<(String, String, String, String)>,
    pub principals: Vec<(String, Value)>,
    pub sessions: Vec<Sess>,
    pub store_available: bool,
    pub created: usize,
    pub continued: usize,
    pub audit: Vec<AuditEvent>,
    pub audit_fail: bool,
}

pub(crate) type Shared = Arc<Mutex<World>>;

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_owned()
}

pub(crate) fn sess_of(v: &Value) -> Sess {
    Sess {
        id: s(&v["id"]),
        kind: s(&v["kind"]),
        owner: derive_user_principal(v["ownerPerson"].as_str().unwrap_or_default())
            .unwrap_or_default(),
        chat_key: v["chatKey"].as_str().map(str::to_owned),
        agent_id: s(&v["agentId"]),
        title: v["title"].as_str().map(str::to_owned),
        updated_at: v["updatedAt"].as_i64().unwrap_or(0),
        archived: v["archived"].as_bool().unwrap_or(false),
        messages: v["messages"]
            .as_array()
            .map(|a| a.iter().map(message_of).collect())
            .unwrap_or_default(),
        summaries: v["summaries"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|x| {
                        (
                            s(&x["text"]),
                            x["fromSeq"].as_i64().unwrap_or(0),
                            x["toSeq"].as_i64().unwrap_or(0),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default(),
        rewinds: v["rewinds"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|x| {
                        (
                            x["hiddenFromSeq"].as_i64().unwrap_or(0),
                            x["hiddenToSeq"].as_i64().unwrap_or(0),
                            !x["undoneAt"].is_null(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

pub(crate) fn message_of(v: &Value) -> MessageRecord {
    MessageRecord {
        role: s(&v["role"]),
        text: s(&v["text"]),
        created_at: v["createdAt"].as_i64().unwrap_or(0),
    }
}

pub(crate) fn link_of(v: &Value) -> (String, String, String, String) {
    (
        s(&v["channel"]),
        s(&v["accountId"]),
        s(&v["userId"]),
        s(&v["human"]),
    )
}

impl World {
    pub fn from_json(w: &Value) -> World {
        World {
            now: w["now"].as_i64().unwrap_or(0),
            base_url: s(&w["baseUrl"]),
            agent_id: s(&w["agentId"]),
            links: w["links"]
                .as_array()
                .map(|a| a.iter().map(link_of).collect())
                .unwrap_or_default(),
            principals: w["principals"]
                .as_object()
                .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default(),
            sessions: w["sessions"]
                .as_array()
                .map(|a| a.iter().map(sess_of).collect())
                .unwrap_or_default(),
            store_available: w["storeAvailable"].as_bool().unwrap_or(true),
            created: 0,
            continued: 0,
            audit: Vec::new(),
            audit_fail: false,
        }
    }

    /// The person a derived owner principal belongs to, among the names a scenario uses.
    pub fn person_of(&self, owner: &str) -> String {
        self.principals
            .iter()
            .map(|(k, _)| k.as_str())
            .chain(["alice", "bob", "vera"])
            .find(|p| derive_user_principal(p).is_ok_and(|d| d == owner))
            .unwrap_or(owner)
            .to_owned()
    }
}

pub(crate) fn principal_of(id: &str, spec: &Value) -> Principal {
    let mut p = Principal::new(
        id,
        Role::parse(spec["role"].as_str().unwrap_or("")).unwrap_or(Role::Viewer),
    );
    p.kind = match spec["kind"].as_str() {
        Some("person") => Some(PrincipalKind::Person),
        Some("agent") => Some(PrincipalKind::Agent),
        _ => None,
    };
    if let Some(o) = spec["agentRights"].as_object() {
        p.agent_rights = Some(
            o.iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        if v == "manage" {
                            AgentRight::Manage
                        } else {
                            AgentRight::Use
                        },
                    )
                })
                .collect(),
        );
    }
    p
}

pub(crate) struct WorldClock(pub Shared);
impl Clock for WorldClock {
    fn now(&self) -> i64 {
        self.0.lock().unwrap().now
    }
}

pub(crate) struct WorldIdentity(pub Shared);
impl HumanLookup for WorldIdentity {
    fn human_of(&self, channel: &str, account_id: &str, user_id: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .links
            .iter()
            .find(|l| l.0 == channel && l.1 == account_id && l.2 == user_id)
            .map(|l| l.3.clone())
    }
}

pub(crate) fn world_principals(w: &Shared) -> PrincipalLookup {
    let w = w.clone();
    Box::new(move |id| {
        w.lock()
            .unwrap()
            .principals
            .iter()
            .find(|(k, _)| k == id)
            .map(|(k, v)| principal_of(k, v))
    })
}

pub(crate) struct WorldAudit(pub Shared);
impl AuditSink for WorldAudit {
    fn append(&mut self, e: &AuditEvent) -> Result<(), String> {
        let mut w = self.0.lock().unwrap();
        if w.audit_fail {
            return Err("audit unavailable".into());
        }
        w.audit.push(e.clone());
        Ok(())
    }
}

/// The scripted randomness of `k3b-support.ts`: draw k is the SHA-256 of `draw:k`, cut to the length asked for.
#[derive(Default)]
pub(crate) struct ScriptedRandom(pub AtomicU64);
impl Random for ScriptedRandom {
    fn fill(&self, buf: &mut [u8]) {
        let k = self.0.fetch_add(1, Ordering::SeqCst) + 1;
        let d = Sha256::digest(format!("draw:{k}").as_bytes());
        buf.copy_from_slice(&d[..buf.len()]);
    }
}

pub(crate) struct WorldSessions(pub Shared);

fn record(x: &Sess) -> SessionRecord {
    SessionRecord {
        id: x.id.clone(),
        kind: x.kind.clone(),
        owner: x.owner.clone(),
        chat_key: x.chat_key.clone(),
        agent_id: x.agent_id.clone(),
        title: x.title.clone(),
        updated_at: x.updated_at,
    }
}

impl SessionPort for WorldSessions {
    fn available(&self) -> bool {
        self.0.lock().unwrap().store_available
    }
    fn get_session(&self, id: &str) -> Result<Option<SessionRecord>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .sessions
            .iter()
            .find(|x| x.id == id)
            .map(record))
    }
    fn has_messages(&self, id: &str) -> Result<bool, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .sessions
            .iter()
            .find(|x| x.id == id)
            .is_some_and(|x| !x.messages.is_empty()))
    }
    fn last_messages(&self, id: &str) -> Result<Vec<MessageRecord>, String> {
        let w = self.0.lock().unwrap();
        let m = w
            .sessions
            .iter()
            .find(|x| x.id == id)
            .map(|x| x.messages.clone())
            .unwrap_or_default();
        Ok(m[m.len().saturating_sub(200)..].to_vec())
    }
    fn active_for_chat(&self, chat_key: &str) -> Result<Option<SessionRecord>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .sessions
            .iter()
            .find(|x| x.chat_key.as_deref() == Some(chat_key) && !x.archived)
            .map(record))
    }
    fn create_channel_session(
        &mut self,
        agent_id: &str,
        owner: &str,
        chat_key: &str,
        title: &str,
    ) -> Result<SessionRecord, String> {
        let mut w = self.0.lock().unwrap();
        w.created += 1;
        let x = Sess {
            id: format!("new-{}", w.created),
            kind: "channel".into(),
            owner: owner.to_owned(),
            chat_key: Some(chat_key.to_owned()),
            agent_id: agent_id.to_owned(),
            title: Some(title.to_owned()),
            updated_at: w.now,
            archived: false,
            messages: Vec::new(),
            summaries: Vec::new(),
            rewinds: Vec::new(),
        };
        let r = record(&x);
        w.sessions.push(x);
        Ok(r)
    }
    fn active_summary_texts(&self, id: &str) -> Result<Vec<String>, String> {
        let w = self.0.lock().unwrap();
        let Some(x) = w.sessions.iter().find(|x| x.id == id) else {
            return Ok(Vec::new());
        };
        // `activeSummaries`: a summary whose range overlaps a live rewind is hidden.
        Ok(x.summaries
            .iter()
            .filter(|(_, from, to)| {
                !x.rewinds
                    .iter()
                    .any(|(hf, ht, undone)| !undone && from <= ht && to >= hf)
            })
            .map(|(t, _, _)| t.clone())
            .collect())
    }
    fn context_messages(&self, id: &str) -> Result<Vec<MessageRecord>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .sessions
            .iter()
            .find(|x| x.id == id)
            .map(|x| x.messages.clone())
            .unwrap_or_default())
    }
    fn create_continuation(
        &mut self,
        agent_id: &str,
        owner: &str,
        title: &str,
        context: &str,
    ) -> Result<String, String> {
        let mut w = self.0.lock().unwrap();
        w.continued += 1;
        let id = format!("cont-{}", w.continued);
        let now = w.now;
        w.sessions.push(Sess {
            id: id.clone(),
            kind: "direct".into(),
            owner: owner.to_owned(),
            chat_key: None,
            agent_id: agent_id.to_owned(),
            title: Some(title.to_owned()),
            updated_at: now,
            archived: false,
            messages: vec![MessageRecord {
                role: "user".into(),
                text: context.to_owned(),
                created_at: now,
            }],
            summaries: Vec::new(),
            rewinds: Vec::new(),
        });
        Ok(id)
    }
}

/// Every row of the tables in `rowid` order as JSON arrays; the columns named in `json` are parsed.
pub(crate) fn dump_tables(path: &std::path::Path, tables: &[(&str, &[&str])]) -> Value {
    use plur1bus_store::rusqlite::{types::ValueRef, Connection};
    let conn = Connection::open(path).unwrap();
    let mut out = serde_json::Map::new();
    for (t, json_cols) in tables {
        let mut st = conn
            .prepare(&format!("SELECT * FROM {t} ORDER BY rowid"))
            .unwrap();
        let names: Vec<String> = st.column_names().map(str::to_owned).collect();
        let rows: Vec<Value> = st
            .query_map([], |r| {
                let mut cells = Vec::new();
                for (i, n) in names.iter().enumerate() {
                    cells.push(match r.get_ref(i)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(v) => json!(v),
                        ValueRef::Real(v) => json!(v),
                        ValueRef::Text(b) => {
                            let t = String::from_utf8_lossy(b).into_owned();
                            if json_cols.contains(&n.as_str()) {
                                serde_json::from_str(&t).unwrap()
                            } else {
                                Value::String(t)
                            }
                        }
                        ValueRef::Blob(_) => Value::Null,
                    });
                }
                Ok(Value::Array(cells))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        out.insert((*t).to_owned(), Value::Array(rows));
    }
    Value::Object(out)
}

/// `sqlite_master` rows as `schemaOf` in `k3b-support.ts` lists them.
pub(crate) fn schema_of(path: &std::path::Path) -> Value {
    use plur1bus_store::rusqlite::Connection;
    let conn = Connection::open(path).unwrap();
    let mut st = conn
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
        .unwrap();
    let rows: Vec<Value> = st
        .query_map([], |r| Ok(json!({"type": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "tbl_name": r.get::<_, String>(2)?, "sql": r.get::<_, Option<String>>(3)?})))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    Value::Array(rows)
}

/// A hand-off service over a temporary store and a world.
pub(crate) struct Rig {
    pub w: Shared,
    pub h: Option<super::ChannelHandoff>,
    pub path: std::path::PathBuf,
    pub rnd: Arc<ScriptedRandom>,
    _dir: tempfile::TempDir,
}

impl Rig {
    pub fn new(world: &Value) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join("handoff.sqlite");
        let w: Shared = Arc::new(Mutex::new(World::from_json(world)));
        let rnd = Arc::new(ScriptedRandom::default());
        let mut r = Rig {
            w,
            h: None,
            path,
            rnd,
            _dir: dir,
        };
        r.reopen();
        r
    }

    /// Closes the service and opens a new one on the same file (a restart).
    pub fn reopen(&mut self) {
        self.h = None;
        let w = self.w.clone();
        let o = super::HandoffOptions {
            path: self.path.clone(),
            store: Box::new(WorldSessions(w.clone())),
            identity: Box::new(WorldIdentity(w.clone())),
            resolve: world_principals(&w),
            clock: Arc::new(WorldClock(w.clone())),
            audit: Box::new(WorldAudit(w.clone())),
            base_url: {
                let w = w.clone();
                Box::new(move || w.lock().unwrap().base_url.clone())
            },
            agent_id: {
                let w = w.clone();
                Box::new(move || w.lock().unwrap().agent_id.clone())
            },
            random: self.rnd.clone(),
            secure_path: Some(Box::new(|_| true)),
        };
        self.h = Some(super::ChannelHandoff::open(o).unwrap());
    }

    pub fn h(&mut self) -> &mut super::ChannelHandoff {
        self.h.as_mut().unwrap()
    }
}
