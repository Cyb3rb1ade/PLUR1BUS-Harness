//! Replays `fixtures/parity/sessions/*.json` (mode V, `scripts/parity/export-sessions.ts`): every scenario runs over a real
//! file with a scripted clock and scripted ids, each op must give the answer TypeScript gave, raw `sql` reads must see the
//! bytes TypeScript left, and the pure helpers and the migration texts must match.
use super::overlay::{active_path, failed_edit_cycles, hidden_digest, RewindRange};
use super::store::{patch_from_json, RewindToken, SessionStore};
use super::store_misc::{AuditFn, RewindInput};
use super::tokens::{catalog_window, count, observe, CatalogModel, ContextModel, ReadCatalog};
use super::*;
use crate::approvals::js_json::{num_value, J};
use rusqlite::types::ValueRef;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// `{ "$u16": [units] }`: a string TypeScript cut in the middle of a pair. SQLite stores it as U+FFFD, a Rust string cannot
/// hold the lone half, so the replay expects the lossy form (as in K3-D4).
pub(super) fn revive(v: &Value) -> Value {
    match v {
        Value::Object(o) if o.len() == 1 && o.contains_key("$rep") => {
            let a = o["$rep"].as_array().unwrap();
            Value::String(
                a[0].as_str()
                    .unwrap()
                    .repeat(a[1].as_u64().unwrap() as usize),
            )
        }
        Value::Object(o) if o.len() == 1 && o.contains_key("$cat") => Value::String(
            o["$cat"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| match revive(p) {
                    Value::String(s) => s,
                    other => panic!("bad $cat part {other}"),
                })
                .collect(),
        ),
        Value::Object(o) if o.len() == 1 && o.contains_key("$u16") => {
            let units: Vec<u16> = o["$u16"]
                .as_array()
                .unwrap()
                .iter()
                .map(|u| u.as_u64().unwrap() as u16)
                .collect();
            Value::String(String::from_utf16_lossy(&units))
        }
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), revive(x))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(revive).collect()),
        other => other.clone(),
    }
}

fn fixture(name: &str) -> Value {
    let text = match name {
        "schema" => include_str!("../../../../fixtures/parity/sessions/schema.json"),
        "pure" => include_str!("../../../../fixtures/parity/sessions/pure.json"),
        "sessions" => include_str!("../../../../fixtures/parity/sessions/sessions.json"),
        "turns" => include_str!("../../../../fixtures/parity/sessions/turns.json"),
        "fts" => include_str!("../../../../fixtures/parity/sessions/fts.json"),
        "overlays" => include_str!("../../../../fixtures/parity/sessions/overlays.json"),
        other => panic!("no fixture {other}"),
    };
    revive(&serde_json::from_str(text).expect("fixture parses"))
}

struct Clk(Arc<AtomicI64>);
impl Clock for Clk {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}
struct Seq(Arc<AtomicU64>);
impl IdSource for Seq {
    fn next_id(&self) -> String {
        (self.0.fetch_add(1, Ordering::SeqCst) + 1).to_string()
    }
}

// ---- JSON out ---------------------------------------------------------------------------------------------------------

fn num(n: i64) -> Value {
    json!(n)
}
fn on(n: Option<i64>) -> Value {
    n.map_or(Value::Null, num)
}
fn os(s: &Option<String>) -> Value {
    s.as_ref().map_or(Value::Null, |s| json!(s))
}
pub(super) fn f(x: f64) -> Value {
    num_value(x)
}

fn session_json(s: &SessionRecord) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(s.id));
    m.insert("kind".into(), json!(s.kind.as_str()));
    m.insert("agentId".into(), json!(s.agent_id));
    m.insert("owner".into(), json!(s.owner));
    m.insert("scope".into(), json!(s.scope));
    m.insert("chatKey".into(), os(&s.chat_key));
    m.insert("title".into(), json!(s.title));
    m.insert("pinned".into(), json!(s.pinned));
    m.insert("memoryMode".into(), json!(s.memory_mode.as_str()));
    m.insert("createdAt".into(), num(s.created_at));
    m.insert("updatedAt".into(), num(s.updated_at));
    m.insert("lastTurnAt".into(), on(s.last_turn_at));
    m.insert("archivedAt".into(), on(s.archived_at));
    m.insert("turnCount".into(), num(s.turn_count));
    if let Some(o) = s.origin {
        m.insert("origin".into(), json!(o.as_str()));
    }
    Value::Object(m)
}
fn turn_json(t: &TurnRecord) -> Value {
    json!({"id": t.id, "sessionId": t.session_id, "seq": t.seq, "state": t.state.as_str(), "startedAt": t.started_at,
        "endedAt": on(t.ended_at), "error": os(&t.error), "incognito": t.incognito})
}
pub(super) fn message_json(m: &MessageRecord) -> Value {
    json!({"id": m.id, "sessionId": m.session_id, "turnId": os(&m.turn_id), "seq": m.seq, "role": m.role.as_str(),
        "text": m.text, "tokens": m.tokens, "createdAt": m.created_at})
}
pub(super) fn event_json(e: &EventRecord) -> Value {
    json!({"sessionId": e.session_id, "turnId": os(&e.turn_id), "seq": e.seq, "type": e.kind, "data": e.data.to_value(), "at": e.at})
}
pub(super) fn summary_json(s: &SummaryRecord) -> Value {
    json!({"id": s.id, "sessionId": s.session_id, "fromSeq": s.from_seq, "toSeq": s.to_seq, "text": s.text,
        "tokens": s.tokens, "tier": s.tier, "state": s.state.as_str(), "createdAt": s.created_at})
}
fn rewind_json(r: &RewindRecord) -> Value {
    json!({"id": r.id, "sessionId": r.session_id, "parentSeq": r.parent_seq, "hiddenFromSeq": r.hidden_from_seq,
        "hiddenToSeq": r.hidden_to_seq, "lessonMessageId": os(&r.lesson_message_id), "hiddenDigest": r.hidden_digest,
        "trigger": r.trigger.as_str(), "actor": r.actor, "createdAt": r.created_at, "undoneAt": on(r.undone_at)})
}
fn page_json(p: &SessionPage) -> Value {
    let mut m = Map::new();
    m.insert(
        "sessions".into(),
        Value::Array(p.sessions.iter().map(session_json).collect()),
    );
    m.insert("truncated".into(), json!(p.truncated));
    Value::Object(m)
}
fn list<T>(v: &[T], f: impl Fn(&T) -> Value) -> Value {
    Value::Array(v.iter().map(f).collect())
}
fn checkpoint_json(c: &StoredCheckpoint) -> Value {
    json!({"sessionId": c.session_id, "turnId": c.turn_id, "projectId": c.project_id, "cardId": c.card_id, "root": c.root,
        "commonGitDir": c.common_git_dir, "ref": c.ref_name, "tree": c.tree, "commitId": c.commit_id})
}
pub(super) fn err_json(e: &SessionError) -> Value {
    let mut m = Map::new();
    m.insert("code".into(), json!(e.code.as_str()));
    if let Some(r) = &e.reason {
        m.insert("reason".into(), json!(r));
    }
    m.insert("message".into(), json!(e.message));
    Value::Object(m)
}

// ---- JSON in ----------------------------------------------------------------------------------------------------------

pub(super) fn gs<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str()
        .unwrap_or_else(|| panic!("missing string {k} in {v}"))
}
pub(super) fn gso(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}
pub(super) fn gi(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(Value::as_i64)
}
pub(super) fn gb(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}
fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_owned())
        .collect()
}
fn kind_of(s: &str) -> SessionKind {
    SessionKind::parse(s).unwrap_or_else(|| panic!("kind {s}"))
}

fn create_input(v: &Value) -> CreateSessionInput {
    CreateSessionInput {
        kind: kind_of(gs(v, "kind")),
        agent_id: gs(v, "agentId").to_owned(),
        owner: gs(v, "owner").to_owned(),
        scope: gso(v, "scope"),
        title: gso(v, "title"),
        memory_mode: gso(v, "memoryMode").and_then(|m| MemoryMode::parse(&m)),
        chat_key: gso(v, "chatKey"),
        replace_active: gb(v, "replaceActive"),
        origin: gso(v, "origin").and_then(|o| SessionOrigin::parse(&o)),
    }
}
fn list_filter(v: &Value) -> ListFilter {
    ListFilter {
        owner: gso(v, "owner").unwrap_or_default(),
        kind: gso(v, "kind").map(|k| kind_of(&k)),
        agent_id: gso(v, "agentId"),
        archived: gso(v, "archived").and_then(|a| ArchivedFilter::parse(&a)),
        search: gso(v, "search"),
        limit: gi(v, "limit"),
    }
}
fn details_of(v: &Value) -> Option<PruneDetail> {
    v.get("detail")
        .filter(|d| !d.is_null())
        .map(|d| PruneDetail {
            truncate: d["mode"] == "truncate",
            confidence: d["confidence"].as_f64().unwrap(),
            tokens_saved: d["tokensSaved"].as_i64().unwrap(),
        })
}
fn new_summary(v: &Value) -> NewSummary {
    NewSummary {
        session_id: gs(v, "sessionId").to_owned(),
        from_seq: gi(v, "fromSeq").unwrap(),
        to_seq: gi(v, "toSeq").unwrap(),
        text: gs(v, "text").to_owned(),
        tokens: gi(v, "tokens").unwrap(),
        tier: gi(v, "tier").unwrap(),
        state: SummaryState::parse(gs(v, "state")).unwrap_or_else(|| panic!("state")),
    }
}
fn checkpoint_of(v: &Value) -> StoredCheckpoint {
    StoredCheckpoint {
        session_id: gs(v, "sessionId").to_owned(),
        turn_id: gs(v, "turnId").to_owned(),
        project_id: gs(v, "projectId").to_owned(),
        card_id: gs(v, "cardId").to_owned(),
        root: gs(v, "root").to_owned(),
        common_git_dir: gs(v, "commonGitDir").to_owned(),
        ref_name: gs(v, "ref").to_owned(),
        tree: gs(v, "tree").to_owned(),
        commit_id: gs(v, "commitId").to_owned(),
    }
}

// ---- raw SQL ----------------------------------------------------------------------------------------------------------

fn raw_rows(store: &SessionStore, sql: &str, args: &[Value]) -> Result<Value, String> {
    let c = store.conn();
    let mut st = c.prepare(sql).map_err(|e| e.to_string())?;
    let names: Vec<String> = st.column_names().map(|n| n.to_string()).collect();
    let params: Vec<rusqlite::types::Value> = args
        .iter()
        .map(|a| match a {
            Value::String(s) => rusqlite::types::Value::Text(s.clone()),
            Value::Number(n) if n.is_i64() => rusqlite::types::Value::Integer(n.as_i64().unwrap()),
            Value::Number(n) => rusqlite::types::Value::Real(n.as_f64().unwrap()),
            _ => rusqlite::types::Value::Null,
        })
        .collect();
    let mut rows = st
        .query(rusqlite::params_from_iter(params))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(r) = rows.next().map_err(|e| e.to_string())? {
        let mut m = Map::new();
        for (i, n) in names.iter().enumerate() {
            let v = match r.get_ref(i).map_err(|e| e.to_string())? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(x) => f(x),
                ValueRef::Text(t) if n == "data" => {
                    serde_json::from_slice(t).unwrap_or_else(|_| json!(String::from_utf8_lossy(t)))
                }
                ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                ValueRef::Blob(_) => json!("<blob>"),
            };
            m.insert(n.clone(), v);
        }
        out.push(Value::Object(m));
    }
    Ok(Value::Array(out))
}

struct Catalog(Vec<CatalogModel>);
impl ReadCatalog for Catalog {
    fn models(&self) -> Vec<CatalogModel> {
        self.0.clone()
    }
}

// ---- the scenario runner ----------------------------------------------------------------------------------------------

pub(super) struct Run {
    path: std::path::PathBuf,
    now: Arc<AtomicI64>,
    n: Arc<AtomicU64>,
    store: Option<SessionStore>,
    last_page: Option<SessionPage>,
    reservations: HashMap<String, RewindToken>,
    archived: Arc<Mutex<Vec<String>>>,
    erased: Arc<AtomicU64>,
}

fn wrap<T>(r: Result<T, SessionError>, to: impl FnOnce(T) -> Value) -> Value {
    match r {
        Ok(v) => json!({"ok": to(v)}),
        Err(e) => json!({"err": err_json(&e)}),
    }
}
#[allow(clippy::needless_pass_by_value)]
fn ok(v: Value) -> Value {
    json!({"ok": v})
}
fn opt<T>(v: Option<T>, to: impl FnOnce(T) -> Value) -> Value {
    v.map_or(Value::Null, to)
}

impl Run {
    pub(super) fn new(tag: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "p4k-sessions-{}-{}-{tag}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut r = Self {
            path: dir.join("sessions.sqlite"),
            now: Arc::new(AtomicI64::new(1_000_000)),
            n: Arc::new(AtomicU64::new(0)),
            store: None,
            last_page: None,
            reservations: HashMap::new(),
            archived: Arc::new(Mutex::new(Vec::new())),
            erased: Arc::new(AtomicU64::new(0)),
        };
        r.open();
        r
    }
    fn open(&mut self) {
        self.store = Some(
            SessionStore::open(
                &self.path,
                Arc::new(Clk(self.now.clone())),
                Arc::new(Seq(self.n.clone())),
            )
            .expect("opens"),
        );
    }
    pub(super) fn s(&mut self) -> &mut SessionStore {
        self.store.as_mut().unwrap()
    }

    pub(super) fn op(&mut self, op: &Value) -> Value {
        let name = gs(op, "op").to_owned();
        match name.as_str() {
            "create" => wrap(self.s().create_session(&create_input(&op["input"])), |r| {
                session_json(&r)
            }),
            "continuation" => {
                let i = &op["input"];
                wrap(
                    self.s().create_continuation(
                        gs(i, "agentId"),
                        gs(i, "owner"),
                        gs(i, "title"),
                        gs(i, "context"),
                    ),
                    |r| session_json(&r),
                )
            }
            "get" => wrap(self.s().get_session(gs(op, "id")), |r| {
                opt(r, |r| session_json(&r))
            }),
            "activeForChat" => wrap(self.s().active_for_chat(gs(op, "chatKey")), |r| {
                opt(r, |r| session_json(&r))
            }),
            "getOwned" => wrap(self.s().get_owned(gs(op, "id"), gs(op, "owner")), |r| {
                session_json(&r)
            }),
            "learningSessions" => {
                let fl = &op["filter"];
                let lf = LearningFilter {
                    owner: gs(fl, "owner").to_owned(),
                    agent_id: gso(fl, "agentId"),
                    project_id: gso(fl, "projectId"),
                    from: gi(fl, "from").unwrap(),
                    to: gi(fl, "to").unwrap(),
                    limit: gi(fl, "limit").unwrap(),
                    offset: gi(fl, "offset"),
                };
                wrap(self.s().learning_sessions(&lf), |r| list(&r, session_json))
            }
            "list" => wrap(self.s().list_sessions(&list_filter(&op["filter"])), |r| {
                page_json(&r)
            }),
            "chatList" => {
                let fl = &op["filter"];
                let mut after = fl
                    .get("after")
                    .filter(|a| !a.is_null())
                    .map(|a| ChatCursor {
                        pinned: gb(a, "pinned"),
                        updated_at: gi(a, "updatedAt").unwrap(),
                        id: gs(a, "id").to_owned(),
                    });
                if gb(op, "afterLast") {
                    if let Some(l) = self.last_page.as_ref().and_then(|p| p.sessions.last()) {
                        after = Some(ChatCursor {
                            pinned: l.pinned,
                            updated_at: l.updated_at,
                            id: l.id.clone(),
                        });
                    }
                }
                let cf = ChatListFilter {
                    filter: list_filter(fl),
                    allowed_agents: fl.get("allowedAgents").map(strs).unwrap_or_default(),
                    after,
                };
                let r = self.s().list_chat_sessions(&cf);
                if let Ok(p) = &r {
                    self.last_page = Some(p.clone());
                }
                wrap(r, |r| page_json(&r))
            }
            "overview" => {
                let fl = &op["filter"];
                let of = OverviewFilter {
                    filter: list_filter(fl),
                    owner: gso(fl, "owner"),
                    owners: fl.get("owners").map(strs),
                };
                wrap(self.s().list_overview(&of), |(rows, truncated)| {
                    let mut m = Map::new();
                    m.insert(
                        "sessions".into(),
                        Value::Array(
                            rows.iter()
                                .map(|r| {
                                    let mut s = session_json(&r.session);
                                    let o = s.as_object_mut().unwrap();
                                    o.insert("model".into(), os(&r.model));
                                    o.insert("usage".into(), json!({"inputTokens": r.input_tokens, "outputTokens": r.output_tokens}));
                                    s
                                })
                                .collect(),
                        ),
                    );
                    m.insert("truncated".into(), json!(truncated));
                    Value::Object(m)
                })
            }
            "searchMessages" => {
                let fl = &op["filter"];
                let search = gso(fl, "search").unwrap_or_default();
                wrap(
                    self.s().search_messages(&list_filter(fl), &search),
                    |hits| {
                        list(&hits, |h| {
                            let mut m = Map::new();
                            m.insert("sessionId".into(), json!(h.session_id));
                            m.insert("messageId".into(), os(&h.message_id));
                            m.insert("seq".into(), on(h.seq));
                            m.insert("snippet".into(), json!(h.snippet));
                            m.insert("rank".into(), f(h.rank));
                            if h.rewound {
                                m.insert("rewound".into(), json!(true));
                            }
                            Value::Object(m)
                        })
                    },
                )
            }
            "update" => {
                let patch = patch_from_json(&J::from_value(&op["patch"]));
                match patch.and_then(|p| self.s().update_session(gs(op, "id"), &p)) {
                    Ok(r) => ok(session_json(&r)),
                    Err(e) => json!({"err": err_json(&e)}),
                }
            }
            "archive" => wrap(self.s().archive_session(gs(op, "id")), |r| session_json(&r)),
            "restore" => wrap(self.s().restore_session(gs(op, "id")), |r| session_json(&r)),
            "fork" => {
                let o = op.get("options").cloned().unwrap_or(json!({}));
                wrap(
                    self.s()
                        .fork_session(gs(op, "id"), o["title"].as_str(), gi(&o, "beforeSeq")),
                    |r| session_json(&r),
                )
            }
            "erase" => {
                let o = &op["options"];
                wrap(
                    self.s().erase_session(
                        gs(op, "id"),
                        o.get("actor").and_then(Value::as_str).unwrap_or(""),
                        o.get("reason").and_then(Value::as_str).unwrap_or(""),
                    ),
                    |r| json!({"tombstoneId": r.tombstone_id, "messages": r.messages}),
                )
            }
            "erasures" => wrap(self.s().erasures(), |r| {
                list(
                    &r,
                    |e| json!({"id": e.id, "sessionId": e.session_id, "owner": e.owner, "messageCount": e.message_count, "actor": e.actor, "reason": e.reason}),
                )
            }),
            "listen" => {
                let a = self.archived.clone();
                let e = self.erased.clone();
                self.s().on_archived(Arc::new(move |id| {
                    a.lock().unwrap().push(id.to_owned());
                    Ok(())
                }));
                self.s().on_erasure(Arc::new(move || {
                    e.fetch_add(1, Ordering::SeqCst);
                }));
                ok(Value::Null)
            }
            "listened" => ok(
                json!({"archived": *self.archived.lock().unwrap(), "erased": self.erased.load(Ordering::SeqCst)}),
            ),
            "begin" => {
                let o = op.get("options").cloned().unwrap_or(json!({}));
                let bo = BeginOptions {
                    harness_command: gb(&o, "harnessCommand"),
                    channel_origin: o.get("channelOrigin").map(J::from_value),
                };
                wrap(
                    self.s().begin_turn(
                        gs(op, "sessionId"),
                        gs(op, "text"),
                        gi(op, "tokens").unwrap(),
                        &bo,
                    ),
                    |b| json!({"turn": turn_json(&b.turn), "message": message_json(&b.message), "event": event_json(&b.event)}),
                )
            }
            "complete" => {
                let i = &op["input"];
                let data = i.get("data").map(J::from_value);
                wrap(
                    self.s().complete_turn(
                        gs(op, "turnId"),
                        gs(i, "text"),
                        gi(i, "tokens").unwrap(),
                        data.as_ref(),
                    ),
                    |r| {
                        opt(
                            r,
                            |c| json!({"message": message_json(&c.message), "event": event_json(&c.event)}),
                        )
                    },
                )
            }
            "fail" => {
                let data = op.get("data").map(J::from_value);
                wrap(
                    self.s()
                        .fail_turn(gs(op, "turnId"), gs(op, "error"), data.as_ref()),
                    |r| opt(r, |e| event_json(&e)),
                )
            }
            "recover" => wrap(self.s().recover_running_turns(), |r| list(&r, event_json)),
            "lastEventSeq" => wrap(self.s().last_event_seq(gs(op, "sessionId")), on),
            "running" => wrap(self.s().running_turn(gs(op, "sessionId")), |r| {
                opt(r, |t| turn_json(&t))
            }),
            "getTurn" => wrap(self.s().get_turn(gs(op, "id")), |r| {
                opt(r, |t| turn_json(&t))
            }),
            "turns" => wrap(self.s().list_turns(gs(op, "sessionId")), |r| {
                list(&r, turn_json)
            }),
            "append" => {
                let kind = EventType::parse(gs(op, "type")).unwrap_or_else(|| panic!("event type"));
                wrap(
                    self.s()
                        .append_event(gs(op, "turnId"), kind, J::from_value(&op["data"])),
                    |e| event_json(&e),
                )
            }
            "events" => wrap(
                self.s().list_events(
                    gs(op, "sessionId"),
                    gi(op, "after").unwrap_or(0),
                    gi(op, "limit").unwrap_or(1000),
                ),
                |r| list(&r, event_json),
            ),
            "toolResult" => wrap(
                self.s().tool_result(gs(op, "sessionId"), gs(op, "callId")),
                |r| r.map_or(Value::Null, |s| json!(s)),
            ),
            "messages" => {
                let q = op.get("query").cloned().unwrap_or(json!({}));
                let mq = MessageQuery {
                    after_seq: gi(&q, "afterSeq"),
                    before_seq: gi(&q, "beforeSeq"),
                    limit: gi(&q, "limit"),
                    keep_oldest: q["keep"] == "oldest",
                };
                wrap(self.s().list_messages(gs(op, "sessionId"), &mq), |r| {
                    list(&r, message_json)
                })
            }
            "harnessTurns" => wrap(self.s().harness_command_turns(gs(op, "sessionId")), |r| {
                let mut v: Vec<_> = r.into_iter().collect();
                v.sort();
                json!(v)
            }),
            "contextMessages" => {
                let after = op.get("options").and_then(|o| gi(o, "afterSeq"));
                wrap(self.s().context_messages(gs(op, "sessionId"), after), |r| {
                    list(&r, message_json)
                })
            }
            "toolEvents" => wrap(self.s().tool_events(gs(op, "sessionId")), |r| {
                list(&r, event_json)
            }),
            "contextToolEvents" => wrap(self.s().context_tool_events(gs(op, "sessionId")), |r| {
                list(&r, event_json)
            }),
            "skillEvents" => wrap(self.s().skill_events(gs(op, "sessionId")), |r| {
                list(&r, event_json)
            }),
            "rewinds" => wrap(self.s().rewinds(gs(op, "sessionId")), |r| {
                list(&r, rewind_json)
            }),
            "summaryRewinds" => wrap(
                self.s().summary_rewinds(gs(op, "sessionId")),
                |r: Vec<RewindRange>| {
                    list(&r, |x| {
                        let mut m = Map::new();
                        m.insert("hiddenFromSeq".into(), json!(x.hidden_from_seq));
                        m.insert("hiddenToSeq".into(), json!(x.hidden_to_seq));
                        m.insert("undoneAt".into(), on(x.undone_at));
                        if let Some(l) = &x.lesson_message_id {
                            m.insert("lessonMessageId".into(), json!(l));
                        }
                        Value::Object(m)
                    })
                },
            ),
            "freezeMemory" => wrap(
                self.s()
                    .freeze_prompt_snapshot(gs(op, "sessionId"), gs(op, "text")),
                |r| json!(r),
            ),
            "freezeCatalogue" => wrap(
                self.s()
                    .freeze_skill_catalogue(gs(op, "sessionId"), gs(op, "text")),
                |r| json!(r),
            ),
            "offers" => wrap(self.s().tool_offers(gs(op, "sessionId")), |r| json!(r)),
            "rememberOffers" => {
                let names = strs(&op["names"]);
                let refs: Vec<&str> = names.iter().map(String::as_str).collect();
                wrap(
                    self.s().remember_tool_offers(gs(op, "sessionId"), &refs),
                    |_| Value::Null,
                )
            }
            "modelProfile" => wrap(
                self.s().model_profile(gs(op, "sessionId")),
                |(p, r)| json!({"profile": p, "revision": r}),
            ),
            "modelReasoning" => wrap(self.s().model_reasoning(gs(op, "sessionId")), |r| {
                r.map_or(Value::Null, |s| json!(s))
            }),
            "setModelProfile" => {
                let reasoning = match op.get("reasoning") {
                    None => ReasoningChange::Keep,
                    Some(Value::Null) => ReasoningChange::Clear,
                    Some(v) => ReasoningChange::Set(v.as_str().unwrap().to_owned()),
                };
                let details = op.get("details").map(|d| ModelDetails {
                    model: gs(d, "model").to_owned(),
                    display_name: gso(d, "displayName"),
                    effective_reasoning: gso(d, "effectiveReasoning"),
                });
                let person = gso(op, "person");
                wrap(
                    self.s().set_model_profile(
                        gs(op, "sessionId"),
                        gs(op, "profile"),
                        gi(op, "revision").unwrap(),
                        &reasoning,
                        person.as_deref(),
                        details.as_ref(),
                    ),
                    |r| json!(r),
                )
            }
            "modelChanges" => wrap(self.s().model_changes(gs(op, "sessionId")), |r| {
                list(&r, event_json)
            }),
            "worktree" => wrap(self.s().worktree(gs(op, "sessionId")), |r| {
                opt(
                    r,
                    |w| json!({"sessionId": w.session_id, "root": w.root, "projectId": os(&w.project_id), "cardId": os(&w.card_id), "createdBy": w.created_by, "createdAt": w.created_at}),
                )
            }),
            "bindWorktree" => {
                let b = &op["binding"];
                wrap(
                    self.s().bind_worktree(
                        gs(b, "sessionId"),
                        gs(b, "root"),
                        b["projectId"].as_str(),
                        b["cardId"].as_str(),
                        gs(b, "createdBy"),
                    ),
                    |_| Value::Null,
                )
            }
            "recordCheckpoint" => wrap(
                self.s()
                    .record_checkpoint(&checkpoint_of(&op["checkpoint"])),
                |_| Value::Null,
            ),
            "checkpoint" => wrap(
                self.s().checkpoint(gs(op, "sessionId"), gs(op, "turnId")),
                |r| opt(r, |c| checkpoint_json(&c)),
            ),
            "hasCheckpoints" => wrap(self.s().has_checkpoints(), |b| json!(b)),
            "checkpoints" => wrap(self.s().checkpoints(gso(op, "sessionId").as_deref()), |r| {
                list(&r, |(c, seq)| {
                    let mut v = checkpoint_json(c);
                    v.as_object_mut()
                        .unwrap()
                        .insert("turnSeq".into(), json!(seq));
                    v
                })
            }),
            "latestTurnSeq" => wrap(self.s().latest_turn_seq(gs(op, "sessionId")), |n| json!(n)),
            "forgetCheckpoint" => wrap(
                self.s()
                    .forget_checkpoint(&checkpoint_of(&op["checkpoint"])),
                |_| Value::Null,
            ),
            "rewindProposal" => wrap(self.s().rewind_proposal(gs(op, "sessionId")), |r| {
                opt(
                    r,
                    |p| json!({"parentSeq": p.parent_seq, "failedCycles": p.failed_cycles, "lastCheckSeq": p.last_check_seq, "agentId": p.agent_id}),
                )
            }),
            "proposeRewind" => {
                let p = &op["proposal"];
                let rp = RewindProposal {
                    parent_seq: gi(p, "parentSeq").unwrap(),
                    failed_cycles: gi(p, "failedCycles").unwrap(),
                    last_check_seq: gi(p, "lastCheckSeq").unwrap(),
                    agent_id: gs(p, "agentId").to_owned(),
                };
                wrap(self.s().propose_rewind(gs(op, "sessionId"), &rp), |r| {
                    opt(r, |e| event_json(&e))
                })
            }
            "planRewind" => {
                let to = target_of(&op["to"]);
                let res = op
                    .get("reservation")
                    .and_then(Value::as_str)
                    .and_then(|n| self.reservations.get(n).copied());
                let cmd = gso(op, "commandTurnId");
                wrap(
                    self.s()
                        .plan_rewind(gs(op, "sessionId"), to, cmd.as_deref(), res),
                    |p| {
                        json!({"parentSeq": p.parent_seq, "hiddenFromSeq": p.hidden_from_seq, "hiddenToSeq": p.hidden_to_seq,
                        "messages": list(&p.messages, message_json), "eventSeq": p.event_seq})
                    },
                )
            }
            "rewind" => {
                let mut log: Vec<Value> = Vec::new();
                let mode = gso(op, "audit");
                let res = op
                    .get("reservation")
                    .and_then(Value::as_str)
                    .and_then(|n| self.reservations.get(n).copied());
                let r = {
                    let mut cb = |e: &RewindAuditEvent| -> Result<(), String> {
                        log.push(json!({"action": e.action, "detail": e.detail.to_value()}));
                        if mode.as_deref() == Some("fail") {
                            return Err("audit down".into());
                        }
                        Ok(())
                    };
                    let input = RewindInput {
                        to: target_of(&op["to"]),
                        lesson: gs(op, "lesson").to_owned(),
                        actor: gs(op, "actor").to_owned(),
                        trigger: RewindTrigger::parse(gs(op, "trigger"))
                            .unwrap_or(RewindTrigger::Agent),
                        expected_event_seq: gi(op, "expectedEventSeq"),
                        audit: if mode.is_some() { Some(&mut cb) } else { None },
                        command_turn_id: gso(op, "commandTurnId"),
                        reservation: res,
                    };
                    self.s().rewind_path(gs(op, "sessionId"), input)
                };
                match r {
                    Ok(r) => json!({"ok": rewind_json(&r), "audit": log}),
                    Err(e) => json!({"err": err_json(&e), "audit": log}),
                }
            }
            "undoRewind" => {
                let mut log: Vec<Value> = Vec::new();
                let mode = gso(op, "audit");
                let cmd = gso(op, "commandTurnId");
                let r = {
                    let mut cb = |e: &RewindAuditEvent| -> Result<(), String> {
                        log.push(json!({"action": e.action, "detail": e.detail.to_value()}));
                        if mode.as_deref() == Some("fail") {
                            return Err("audit down".into());
                        }
                        Ok(())
                    };
                    let a: Option<AuditFn<'_>> = if mode.is_some() { Some(&mut cb) } else { None };
                    self.store.as_mut().unwrap().undo_rewind(
                        gs(op, "sessionId"),
                        gs(op, "rewindId"),
                        gs(op, "actor"),
                        a,
                        cmd.as_deref(),
                    )
                };
                match r {
                    Ok(r) => json!({"ok": rewind_json(&r), "audit": log}),
                    Err(e) => json!({"err": err_json(&e), "audit": log}),
                }
            }
            "reserve" => {
                let cmd = gso(op, "commandTurnId");
                match self.s().reserve_rewind(gs(op, "sessionId"), cmd.as_deref()) {
                    Ok(t) => {
                        self.reservations.insert(gs(op, "name").to_owned(), t);
                        ok(Value::Null)
                    }
                    Err(e) => json!({"err": err_json(&e)}),
                }
            }
            "release" => {
                if let Some(t) = self.reservations.get(gs(op, "name")).copied() {
                    let sid = gso(op, "sessionId").unwrap_or_else(|| "ses_1".into());
                    self.s().release_rewind(&sid, t);
                }
                ok(Value::Null)
            }
            "reserved" => ok(json!(self.s().rewind_reserved(gs(op, "sessionId")))),
            "tokenCalibration" => wrap(self.s().token_calibration(gs(op, "model")), |r| {
                r.map_or(Value::Null, f)
            }),
            "tokenFactor" => wrap(self.s().token_factor(gs(op, "model")), f),
            "setTokenFactor" => wrap(
                self.s()
                    .set_token_factor(gs(op, "model"), op["factor"].as_f64().unwrap()),
                |_| Value::Null,
            ),
            "meterCount" => {
                let measured = op.get("measured").and_then(Value::as_f64);
                wrap(
                    count(self.s(), gs(op, "model"), gs(op, "text"), measured),
                    |n| json!(n),
                )
            }
            "meterObserve" => {
                let r = observe(
                    self.s(),
                    gs(op, "model"),
                    op["estimated"].as_f64().unwrap(),
                    op["measured"].as_f64().unwrap(),
                );
                match r {
                    Ok(()) => wrap(self.s().token_calibration(gs(op, "model")), |r| {
                        r.map_or(Value::Null, f)
                    }),
                    Err(e) => json!({"err": err_json(&e)}),
                }
            }
            "recordUsage" => wrap(
                self.s().record_message_usage(
                    gs(op, "id"),
                    gs(op, "model"),
                    gi(op, "tokens").unwrap(),
                ),
                |_| Value::Null,
            ),
            "messageUsage" => wrap(
                self.s()
                    .message_usage(gs(op, "id"), gs(op, "model"), gs(op, "text")),
                |r| r.map_or(Value::Null, |n| json!(n)),
            ),
            "visibility" => wrap(self.s().tool_visibility(gs(op, "sessionId")), |r| {
                list(&r, |v| {
                    let mut m = Map::new();
                    m.insert("ref".into(), json!(v.reference));
                    m.insert("hidden".into(), json!(v.hidden));
                    m.insert("reason".into(), json!(v.reason));
                    if v.truncate {
                        m.insert("mode".into(), json!("truncate"));
                    }
                    Value::Object(m)
                })
            }),
            "setVisibility" => {
                let d = details_of(op);
                wrap(
                    self.s().set_tool_visibility(
                        gs(op, "sessionId"),
                        gs(op, "ref"),
                        gb(op, "hidden"),
                        gs(op, "reason"),
                        d.as_ref(),
                    ),
                    |_| Value::Null,
                )
            }
            "setVisibilities" => {
                let changes: Vec<VisibilityChange> = op["changes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| VisibilityChange {
                        reference: gs(c, "ref").to_owned(),
                        hidden: gb(c, "hidden"),
                        reason: gs(c, "reason").to_owned(),
                        turn_id: gso(c, "turnId"),
                        detail: details_of(c),
                    })
                    .collect();
                wrap(
                    self.s()
                        .set_tool_visibilities(gs(op, "sessionId"), &changes),
                    |_| Value::Null,
                )
            }
            "latestAssistant" => wrap(
                self.s().latest_assistant_context(gs(op, "sessionId")),
                |r| json!(r),
            ),
            "pruneExplanation" => wrap(self.s().prune_explanation(gs(op, "sessionId")), |r| {
                list(&r, |p| {
                    let mut m = Map::new();
                    m.insert("ref".into(), json!(p.reference));
                    m.insert("hidden".into(), json!(p.hidden));
                    m.insert("verdict".into(), json!(p.verdict));
                    m.insert("confidence".into(), p.confidence.map_or(Value::Null, f));
                    m.insert("tokensSaved".into(), json!(p.tokens_saved));
                    Value::Object(m)
                })
            }),
            "refetch" => wrap(
                self.s()
                    .record_tool_refetch(gs(op, "sessionId"), gs(op, "ref")),
                |_| Value::Null,
            ),
            "pruneMetrics" => wrap(
                self.s().prune_metrics(gs(op, "sessionId")),
                |m| json!({"pruned": m.pruned, "tokensSaved": m.tokens_saved, "refetches": m.refetches, "refetchRate": f(m.refetch_rate)}),
            ),
            "addSummary" => wrap(self.s().add_summary(&new_summary(&op["summary"])), |r| {
                summary_json(&r)
            }),
            "summaries" => {
                let st = gso(op, "state").and_then(|s| SummaryState::parse(&s));
                wrap(self.s().list_summaries(gs(op, "sessionId"), st), |r| {
                    list(&r, summary_json)
                })
            }
            "setSummaryState" => {
                let st = SummaryState::parse(gs(op, "state")).unwrap_or_else(|| panic!("state"));
                wrap(self.s().set_summary_state(gs(op, "id"), st), |_| {
                    Value::Null
                })
            }
            "replaceSummaries" => {
                let sup = strs(&op["supersede"]);
                wrap(
                    self.s().replace_summaries(&sup, &new_summary(&op["next"])),
                    |r| summary_json(&r),
                )
            }
            "learningToolErrors" => {
                let w = &op["window"];
                wrap(
                    self.s().learning_tool_errors(
                        gs(op, "owner"),
                        gi(w, "from").unwrap(),
                        gi(w, "to").unwrap(),
                        gi(op, "limit").unwrap_or(200),
                    ),
                    |r| {
                        list(
                            &r,
                            |e| json!({"sessionId": e.session_id, "turnId": e.turn_id, "seq": e.seq, "at": e.at, "metadata": e.metadata.to_value()}),
                        )
                    },
                )
            }
            "learningTranscript" => {
                let w = &op["window"];
                let c = &op["caps"];
                let ids = op.get("turnIds").map(strs);
                wrap(
                    self.s().learning_transcript(
                        gs(op, "sessionId"),
                        gi(w, "from").unwrap(),
                        gi(w, "to").unwrap(),
                        gi(c, "messages").unwrap(),
                        gi(c, "events").unwrap(),
                        ids.as_deref(),
                    ),
                    |t| json!({"messages": list(&t.messages, message_json), "events": list(&t.events, event_json)}),
                )
            }
            "catalogWindow" => {
                let models: Vec<CatalogModel> = op["models"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|m| CatalogModel {
                        provider: gs(m, "provider").to_owned(),
                        id: gs(m, "id").to_owned(),
                        context_window: m.get("contextWindow").and_then(Value::as_f64),
                    })
                    .collect();
                let m = &op["model"];
                let r = catalog_window(
                    &Catalog(models),
                    &ContextModel {
                        provider: gs(m, "provider").to_owned(),
                        model: gs(m, "model").to_owned(),
                    },
                );
                ok(r.map_or(Value::Null, |n| json!(n)))
            }
            "advance" => {
                let t = self.now.fetch_add(gi(op, "ms").unwrap(), Ordering::SeqCst)
                    + gi(op, "ms").unwrap();
                ok(json!(t))
            }
            "reopen" => {
                self.store = None;
                self.open();
                ok(Value::Null)
            }
            "sql" => match raw_rows(
                self.store.as_ref().unwrap(),
                gs(op, "sql"),
                op["args"].as_array().map(Vec::as_slice).unwrap_or(&[]),
            ) {
                Ok(v) => ok(v),
                Err(m) => json!({"err": {"name": "Error", "message": m}}),
            },
            "sqlWrite" => match self
                .store
                .as_ref()
                .unwrap()
                .conn()
                .execute_batch(gs(op, "sql"))
            {
                Ok(()) => ok(Value::Null),
                Err(e) => json!({"err": {"name": "Error", "message": sqlite_message(&e)}}),
            },
            other => panic!("unknown op {other}"),
        }
    }
}

fn sqlite_message(e: &rusqlite::Error) -> String {
    match e {
        rusqlite::Error::SqliteFailure(_, Some(m)) => m.clone(),
        other => other.to_string(),
    }
}

fn target_of(v: &Value) -> RewindTarget {
    match v {
        Value::String(_) => RewindTarget::Last,
        n => RewindTarget::Seq(n.as_i64().unwrap()),
    }
}

pub(super) fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// The first place two JSON values differ, with a little context, never the whole document.
pub(super) fn first_diff(a: &Value, b: &Value) -> String {
    let (x, y) = (a.to_string(), b.to_string());
    let at = x.chars().zip(y.chars()).take_while(|(p, q)| p == q).count();
    let from = at.saturating_sub(60);
    let cut = |t: &str| t.chars().skip(from).take(220).collect::<String>();
    format!(
        "differs at {at}\n  want ...{}\n  got  ...{}",
        cut(&x),
        cut(&y)
    )
}

fn replay(file: &str) {
    let all = fixture(file);
    let mut failures = Vec::new();
    for sc in all.as_array().unwrap() {
        let Some(ops) = sc.get("ops").and_then(Value::as_array) else {
            continue;
        };
        let name = sc["name"].as_str().unwrap();
        let mut run = Run::new(name);
        for (i, step) in ops.iter().enumerate() {
            let mut got = run.op(&step["op"]);
            // K5-D1: TypeScript lets a raw SQLite error escape from the statements it runs outside `#tx`
            // (`{ name: "Error", message }`); Rust gives every store error a code, here storage / sqlite. Same message.
            if step["err"].get("name").is_some() && got["err"]["reason"] == "sqlite" {
                got["err"] = json!({"name": "Error", "message": got["err"]["message"]});
            }
            let mut want = Map::new();
            for k in ["ok", "err", "audit"] {
                if let Some(v) = step.get(k) {
                    want.insert(k.into(), v.clone());
                }
            }
            if Value::Object(want.clone()) != got {
                failures.push(format!(
                    "{name} #{i} {}\n  {}",
                    clip(&step["op"].to_string(), 300),
                    first_diff(&Value::Object(want), &got)
                ));
                if failures.len() > 6 {
                    break;
                }
            }
        }
        if failures.len() > 6 {
            break;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn sessions_scenarios_match_typescript() {
    replay("sessions");
}
#[test]
fn turn_scenarios_match_typescript() {
    replay("turns");
}
#[test]
fn fts_and_offer_scenarios_match_typescript() {
    replay("fts");
}
#[test]
fn overlay_scenarios_match_typescript() {
    replay("overlays");
}

#[test]
fn migration_texts_are_the_typescript_texts() {
    let s = fixture("schema");
    let texts: Vec<&str> = s["migrations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().unwrap())
        .collect();
    assert_eq!(
        s["version"].as_u64().unwrap() as u32,
        migrations::SCHEMA_VERSION
    );
    assert_eq!(texts.len(), migrations::MIGRATIONS.len());
    for (i, (a, b)) in texts.iter().zip(migrations::MIGRATIONS).enumerate() {
        assert_eq!(a, b, "migration {} differs", i + 1);
    }
}

fn schema_rows(c: &rusqlite::Connection) -> Value {
    let mut st = c
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
        .unwrap();
    let rows = st
        .query_map([], |r| {
            Ok(json!({"type": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "tbl_name": r.get::<_, String>(2)?, "sql": r.get::<_, Option<String>>(3)?}))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    Value::Array(rows)
}

#[test]
fn a_fresh_and_a_migrated_file_have_the_typescript_schema() {
    let s = fixture("schema");
    let want = &s["schema"];
    let run = Run::new("schema-fresh");
    assert_eq!(
        &schema_rows(run.store.as_ref().unwrap().conn()),
        want,
        "fresh file"
    );
    assert_eq!(
        run.store.as_ref().unwrap().user_version().unwrap(),
        migrations::SCHEMA_VERSION
    );
    // Every prefix, then migrated by this core: the same text again.
    for v in 1..=migrations::SCHEMA_VERSION as usize {
        let dir = std::env::temp_dir().join(format!("p4k-sessions-mig-{}-{v}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sessions.sqlite");
        {
            let c = rusqlite::Connection::open(&path).unwrap();
            for (i, m) in migrations::MIGRATIONS[..v].iter().enumerate() {
                c.execute_batch(&format!(
                    "BEGIN IMMEDIATE;{m};PRAGMA user_version = {};COMMIT;",
                    i + 1
                ))
                .unwrap();
            }
            assert_eq!(schema_rows(&c), s["prefixes"][v.to_string()], "prefix v{v}");
        }
        let st = SessionStore::open(
            &path,
            Arc::new(Clk(Arc::new(AtomicI64::new(1)))),
            Arc::new(Seq(Arc::new(AtomicU64::new(0)))),
        )
        .unwrap();
        assert_eq!(&schema_rows(st.conn()), want, "migrated from v{v}");
        assert_eq!(st.user_version().unwrap(), migrations::SCHEMA_VERSION);
    }
}

#[test]
fn a_newer_file_is_refused_and_left_alone() {
    let s = fixture("schema");
    let dir = std::env::temp_dir().join(format!("p4k-sessions-newer-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("sessions.sqlite");
    {
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch(&format!(
            "PRAGMA user_version = {}",
            migrations::SCHEMA_VERSION + 1
        ))
        .unwrap();
    }
    let before = std::fs::read(&path).unwrap();
    let e = SessionStore::open(
        &path,
        Arc::new(Clk(Arc::new(AtomicI64::new(1)))),
        Arc::new(Seq(Arc::new(AtomicU64::new(0)))),
    )
    .err()
    .expect("refused");
    assert_eq!(e.code, ErrorCode::Storage);
    assert_eq!(e.reason.as_deref(), Some("schema-too-new"));
    assert_eq!(e.message, s["newerRefusal"]["message"].as_str().unwrap());
    assert_eq!(
        std::fs::read(&path).unwrap(),
        before,
        "the file is untouched"
    );
}

#[test]
fn pure_helpers_match_typescript() {
    let p = fixture("pure");
    let msgs_of = |v: &Value| -> Vec<MessageRecord> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|m| MessageRecord {
                id: gs(m, "id").into(),
                session_id: "s".into(),
                turn_id: None,
                seq: gi(m, "seq").unwrap(),
                role: MessageRole::User,
                text: gs(m, "text").into(),
                tokens: 0,
                created_at: 0,
            })
            .collect()
    };
    let ranges_of = |v: &Value| -> Vec<RewindRange> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|r| RewindRange {
                hidden_from_seq: gi(r, "hiddenFromSeq").unwrap(),
                hidden_to_seq: gi(r, "hiddenToSeq").unwrap(),
                undone_at: gi(r, "undoneAt"),
                lesson_message_id: gso(r, "lessonMessageId"),
            })
            .collect()
    };
    for c in p["activePath"].as_array().unwrap() {
        let got: Vec<i64> = active_path(&msgs_of(&c["messages"]), &ranges_of(&c["rewinds"]))
            .iter()
            .map(|m| m.seq)
            .collect();
        let want: Vec<i64> = c["result"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["seq"].as_i64().unwrap())
            .collect();
        assert_eq!(got, want, "{}", c["rewinds"]);
    }
    for c in p["hiddenDigest"].as_array().unwrap() {
        let msgs: Vec<MessageRecord> = c["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| MessageRecord {
                id: gs(m, "id").into(),
                session_id: "s".into(),
                turn_id: None,
                seq: 0,
                role: MessageRole::User,
                text: gs(m, "text").into(),
                tokens: 0,
                created_at: 0,
            })
            .collect();
        assert_eq!(
            hidden_digest(&msgs),
            c["digest"].as_str().unwrap(),
            "{}",
            c["messages"]
        );
    }
    for c in p["failedEditCycles"].as_array().unwrap() {
        let events: Vec<EventRecord> = c["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| EventRecord {
                session_id: gs(e, "sessionId").into(),
                turn_id: gso(e, "turnId"),
                seq: gi(e, "seq").unwrap(),
                kind: gs(e, "type").into(),
                data: J::from_value(&e["data"]),
                at: gi(e, "at").unwrap(),
            })
            .collect();
        let r = failed_edit_cycles(&events);
        let want = &c["result"];
        assert_eq!(
            r.failed_cycles,
            want["failedCycles"].as_i64().unwrap(),
            "{}",
            c["events"]
        );
        assert_eq!(
            r.last_check_seq,
            want["lastCheckSeq"].as_i64().unwrap_or(0),
            "{}",
            c["events"]
        );
        assert_eq!(r.from_turn_id, gso(want, "fromTurnId"), "{}", c["events"]);
        assert_eq!(r.pending_edit, gb(want, "pendingEdit"), "{}", c["events"]);
    }
}

#[test]
fn fts_query_matches_typescript() {
    let all = fixture("fts");
    let cases = all
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "fts-query")
        .unwrap();
    for c in cases["cases"].as_array().unwrap() {
        let got = fts::fts_query(gs(c, "text"));
        match (c.get("ok"), c.get("err")) {
            (Some(w), _) => assert_eq!(got.unwrap(), w.as_str().unwrap(), "{}", c["text"]),
            (_, Some(e)) => assert_eq!(err_json(&got.unwrap_err()), *e, "{}", c["text"]),
            _ => panic!("case"),
        }
    }
}
