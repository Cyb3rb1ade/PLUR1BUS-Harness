//! Replays `fixtures/parity/collab/*.json` (modes V and B, `scripts/parity/export-collab.ts`): every scenario runs over a real
//! `collab.sqlite` with a scripted clock and scripted ids, each op must give the answer TypeScript gave, raw `sql` reads must
//! see the bytes TypeScript left, and the pure rules (limits, guardrails, capacity, repeat keys, work budgets) and the schema
//! text must match case by case.
use super::board::{CardFields, CardFilter};
use super::capacity::{writer_capacity, CapacityFacts, CapacitySettings};
use super::errors::{CollabError, GuardrailReason};
use super::guardrails::{evaluate_guardrails, GuardrailInput};
use super::ids::{pair_key, repeat_key, traceparent, CollabIds};
use super::limits::{
    legacy_collab_settings, resolve_collab_limits, CallClass, CollabLimits,
    CollaborationLimitsConfig, DelegationWorkBudget, Reservation, TaskClass, TaskLimits,
};
use super::migrations::{MIGRATIONS, SCHEMA_VERSION};
use super::store::{
    ArtifactRow, CollabStore, NewTask, NewWorktree, SpanPatch, StoreOptions, TaskGrantEnd,
    TaskPatch,
};
use super::types::{CollabSettings, RepoBinding};
use crate::approvals::js_json::{num_value, J};
use crate::budget::Clock;
use plur1bus_store::rusqlite;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

fn fixture(name: &str) -> Value {
    let text = match name {
        "schema" => include_str!("../../../../fixtures/parity/collab/schema.json"),
        "pure" => include_str!("../../../../fixtures/parity/collab/pure.json"),
        "store" => include_str!("../../../../fixtures/parity/collab/store.json"),
        "board" => include_str!("../../../../fixtures/parity/collab/board.json"),
        other => panic!("no fixture {other}"),
    };
    serde_json::from_str(text).expect("fixture parses")
}

// ---- small JSON readers -----------------------------------------------------------------------------------------------

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str()
        .unwrap_or_else(|| panic!("missing string {k} in {v}"))
}
fn os<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}
fn oi(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(Value::as_i64)
}
fn of(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64)
}
fn ob(v: &Value, k: &str) -> Option<bool> {
    v.get(k).and_then(Value::as_bool)
}
fn jtext(v: &Value, k: &str) -> Option<J> {
    os(v, k).map(|t| J::parse(t).unwrap_or_else(|| panic!("bad json text {t}")))
}

// ---- scripted ports ---------------------------------------------------------------------------------------------------

struct Clk {
    now: Arc<AtomicI64>,
    step: i64,
}
impl Clock for Clk {
    fn now(&self) -> i64 {
        self.now.fetch_add(self.step, Ordering::SeqCst)
    }
}

#[derive(Default)]
struct Seq(Mutex<HashMap<String, i64>>);
impl CollabIds for Seq {
    fn new_id(&self, prefix: &str) -> String {
        let mut m = self.0.lock().unwrap();
        let c = m.entry(prefix.to_owned()).or_insert(0);
        *c += 1;
        format!("{prefix}_{c}")
    }
    fn trace_id(&self) -> String {
        "0".repeat(31) + "1"
    }
    fn span_id(&self) -> String {
        "0".repeat(15) + "1"
    }
}

struct Grants {
    ended: Arc<Mutex<Vec<String>>>,
    throw: Arc<Mutex<bool>>,
}
impl TaskGrantEnd for Grants {
    fn end_task(&self, task_id: &str) -> Result<(), String> {
        self.ended.lock().unwrap().push(task_id.to_owned());
        if *self.throw.lock().unwrap() {
            return Err("grant store down".into());
        }
        Ok(())
    }
}

// ---- JSON out ---------------------------------------------------------------------------------------------------------

fn err_value(e: &CollabError) -> Value {
    if let Some(code) = e.board_code {
        return json!({ "board": code, "message": e.message });
    }
    if e.raw {
        return json!({ "raw": true });
    }
    let mut m = Map::new();
    m.insert("code".into(), Value::from(e.code.as_str()));
    if let Some(r) = &e.reason {
        m.insert("reason".into(), Value::from(r.clone()));
    }
    if let Some(g) = e.guardrail {
        m.insert("guardrail".into(), Value::from(g.as_str()));
    }
    m.insert("message".into(), Value::from(e.message.clone()));
    Value::Object(m)
}

fn limits_value(l: &CollabLimits) -> Value {
    let mut classes = Map::new();
    for c in TaskClass::ALL {
        let t = l.task(c);
        classes.insert(
            c.as_str().into(),
            json!({ "rounds": t.rounds, "wallTimeMs": t.wall_time_ms, "stallTimeMs": t.stall_time_ms }),
        );
    }
    json!({
        "readHelpers": { "perTurn": l.read_helpers_per_turn, "depth": l.read_helpers_depth },
        "writers": { "perProject": l.writers_per_project },
        "consults": { "perPairPerTurn": l.consults_per_pair_per_turn },
        "workTokens": l.work_tokens,
        "taskClasses": Value::Object(classes),
        "returnTokens": l.return_tokens,
        "allowCrossProject": l.allow_cross_project,
        "repeatWindowMs": num_value(l.repeat_window_ms),
        "tokenBudget": l.token_budget.map_or(Value::Null, num_value),
    })
}

fn config_from(v: &Value) -> CollaborationLimitsConfig {
    let tl = |c: &Value| TaskLimits {
        rounds: c["rounds"].as_i64().unwrap(),
        wall_time_ms: c["wallTimeMs"].as_i64().unwrap(),
        stall_time_ms: c["stallTimeMs"].as_i64().unwrap(),
    };
    let mut classes = CollaborationLimitsConfig::default().task_classes;
    for (i, c) in TaskClass::ALL.iter().enumerate() {
        classes[i] = tl(&v["taskClasses"][c.as_str()]);
    }
    CollaborationLimitsConfig {
        read_helpers_per_turn: v["readHelpers"]["perTurn"].as_i64().unwrap(),
        read_helpers_depth: v["readHelpers"]["depth"].as_i64().unwrap(),
        writers_per_project: v["writers"]["perProject"].as_i64().unwrap(),
        consults_per_pair_per_turn: v["consults"]["perPairPerTurn"].as_i64().unwrap(),
        work_tokens: v["workTokens"].as_i64().unwrap(),
        task_classes: classes,
    }
}

fn settings_from(v: &Value) -> CollabSettings {
    CollabSettings {
        max_depth: v["maxDepth"].as_i64().unwrap(),
        max_fanout: v["maxFanout"].as_i64().unwrap(),
        max_pair_per_turn: v["maxPairPerTurn"].as_i64().unwrap(),
        max_turns: v["maxTurns"].as_i64().unwrap(),
        timeout_ms: v["timeoutMs"].as_i64().unwrap(),
        return_tokens: v["returnTokens"].as_i64().unwrap(),
        allow_cross_project: v["allowCrossProject"].as_bool().unwrap(),
        repeat_window_ms: v["repeatWindowMs"].as_f64().unwrap(),
        token_budget: v["tokenBudget"].as_f64(),
        collaboration: None,
    }
}

// ---- scenarios --------------------------------------------------------------------------------------------------------

struct Ctx {
    path: std::path::PathBuf,
    now: Arc<AtomicI64>,
    step: i64,
    config: Option<CollaborationLimitsConfig>,
    ended: Arc<Mutex<Vec<String>>>,
    throw: Arc<Mutex<bool>>,
    warned: Arc<Mutex<Vec<String>>>,
    ids: Arc<Seq>,
    a: Option<CollabStore>,
    b: Option<CollabStore>,
    raw: Option<rusqlite::Connection>,
    cursor: Option<String>,
}

impl Ctx {
    fn open(&self) -> CollabStore {
        let mut o = StoreOptions::new(
            Arc::new(Clk {
                now: self.now.clone(),
                step: self.step,
            }),
            self.ids.clone(),
        );
        if let Some(c) = self.config.clone() {
            o.limits = Some(Box::new(move || c.clone()));
        }
        o.grants = Some(Arc::new(Grants {
            ended: self.ended.clone(),
            throw: self.throw.clone(),
        }));
        let w = self.warned.clone();
        o.log_warn = Some(Box::new(move |m| w.lock().unwrap().push(m.to_owned())));
        CollabStore::open_with_permissions(
            &self.path,
            o,
            crate::private_store::fixture_owner_hook(),
        )
        .expect("store opens")
    }
}

fn card_fields(v: &Value) -> CardFields {
    CardFields {
        title: os(v, "title").map(str::to_owned),
        description: os(v, "description").map(str::to_owned),
        labels: v
            .get("labels")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|x| x.as_str().unwrap().to_owned()).collect()),
        priority: os(v, "priority").map(str::to_owned),
        due_at: match v.get("dueAt") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(n) => Some(n.as_f64()),
        },
        links: os(v, "linksJson").map(|t| match J::parse(t) {
            Some(J::Arr(items)) => items,
            other => panic!("links json is not an array: {other:?}"),
        }),
    }
}

fn page_value(items_key: &str, items: &[J], next: Option<String>) -> Value {
    let mut m = Map::new();
    m.insert(
        items_key.into(),
        Value::Array(items.iter().map(J::to_value).collect()),
    );
    m.insert("nextCursor".into(), next.map_or(Value::Null, Value::from));
    Value::Object(m)
}

fn opt<T>(v: Option<T>, f: impl Fn(T) -> Value) -> Value {
    v.map_or(Value::Null, f)
}

fn run_op(c: &mut Ctx, op: &Value) -> Result<Value, CollabError> {
    let name = s(op, "op");
    // Ops that do not touch a store.
    match name {
        "setClock" => {
            c.now.store(op["to"].as_i64().unwrap(), Ordering::SeqCst);
            return Ok(Value::Null);
        }
        "reopen" => {
            c.a.take().unwrap().close();
            c.a = Some(c.open());
            return Ok(Value::Null);
        }
        "grants" => {
            *c.throw.lock().unwrap() = s(op, "mode") == "throw";
            return Ok(Value::Null);
        }
        "ended" => return Ok(json!(c.ended.lock().unwrap().clone())),
        "warned" => return Ok(json!(c.warned.lock().unwrap().clone())),
        "sql" | "exec" => {
            let conn = c
                .raw
                .get_or_insert_with(|| rusqlite::Connection::open(&c.path).unwrap());
            let args: Vec<String> = op
                .get("args")
                .and_then(Value::as_array)
                .map_or(vec![], |a| {
                    a.iter().map(|x| x.as_str().unwrap().to_owned()).collect()
                });
            if name == "exec" {
                conn.execute(s(op, "sql"), rusqlite::params_from_iter(args.iter()))
                    .unwrap();
                return Ok(Value::Null);
            }
            let mut st = conn.prepare(s(op, "sql")).unwrap();
            let n = st.column_count();
            let rows = st
                .query_map(rusqlite::params_from_iter(args.iter()), |r| {
                    (0..n)
                        .map(|i| {
                            Ok(match r.get_ref(i)? {
                                rusqlite::types::ValueRef::Null => Value::Null,
                                rusqlite::types::ValueRef::Integer(x) => Value::from(x),
                                rusqlite::types::ValueRef::Real(x) => num_value(x),
                                rusqlite::types::ValueRef::Text(t) => {
                                    Value::from(String::from_utf8_lossy(t).into_owned())
                                }
                                rusqlite::types::ValueRef::Blob(_) => Value::Null,
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            return Ok(Value::Array(rows.into_iter().map(Value::Array).collect()));
        }
        _ => {}
    }
    if op.get("on").and_then(Value::as_str) == Some("b") && c.b.is_none() {
        c.b = Some(c.open());
    }
    let st: &CollabStore = if op.get("on").and_then(Value::as_str) == Some("b") {
        c.b.as_ref().unwrap()
    } else {
        c.a.as_ref().unwrap()
    };
    let actor = jtext(op, "actorJson");
    let assignee = jtext(op, "assigneeJson");
    let over = ob(op, "override").unwrap_or(false);
    let proj = os(op, "project").unwrap_or("");
    let id = os(op, "id").unwrap_or("");
    let null_actor = J::Null;
    let actor_ref = actor.as_ref().unwrap_or(&null_actor);
    let card = os(op, "card");
    Ok(match name {
        "createProject" => st
            .create_project(
                s(op, "name"),
                s(op, "owner"),
                jtext(op, "settingsJson").as_ref(),
                os(op, "id"),
            )?
            .to_value(),
        "updateProject" => st.update_project(id, s(op, "name"))?.to_value(),
        "getProject" => opt(st.get_project(id)?, |p| p.to_value()),
        "limits" => limits_value(&st.limits(id)?),
        "setSettings" => st
            .set_settings(id, &jtext(op, "changesJson").unwrap())?
            .to_value(),
        "listProjects" => Value::Array(st.list_projects()?.iter().map(|p| p.to_value()).collect()),
        "archive" => st.archive_project(id)?.to_value(),
        "addMember" => st.add_member(id, s(op, "user"), s(op, "role"))?.to_value(),
        "removeMember" => st.remove_member(id, s(op, "user"))?.to_value(),
        "addAgent" => st.add_agent(id, s(op, "agent"))?.to_value(),
        "removeAgent" => st.remove_agent(id, s(op, "agent"))?.to_value(),
        "setRepo" => st
            .set_repo(
                id,
                &RepoBinding {
                    repo_path: s(&op["repo"], "repoPath").into(),
                    base_branch: s(&op["repo"], "baseBranch").into(),
                },
            )?
            .to_value(),
        "clearRepo" => st.clear_repo(id)?.to_value(),
        "insertWorktree" => {
            let i = &op["input"];
            let w = NewWorktree {
                project_id: s(i, "projectId").into(),
                root_id: s(i, "rootId").into(),
                card_id: os(i, "cardId").map(str::to_owned),
                branch: s(i, "branch").into(),
                path: s(i, "path").into(),
                base_sha: s(i, "baseSha").into(),
                git_dir: os(i, "gitDir").map(str::to_owned),
                common_git_dir: os(i, "commonGitDir").map(str::to_owned),
                dev: os(i, "dev").map(str::to_owned),
                ino: os(i, "ino").map(str::to_owned),
            };
            opt(st.insert_worktree(&w)?, |r| r.to_value())
        }
        "liveWorktree" => opt(st.live_worktree(proj, card)?, |r| r.to_value()),
        "previousWorktree" => opt(st.previous_worktree(proj, card)?, |r| r.to_value()),
        "worktreeAt" => opt(st.worktree_at(s(op, "path"))?, |r| r.to_value()),
        "markRemoved" => {
            st.mark_worktree_removed(proj, card)?;
            Value::Null
        }
        "putArtifact" => {
            let (aid, pointer) = st.put_artifact(proj, s(op, "body"), os(op, "contentType"))?;
            json!({ "id": aid, "pointer": pointer })
        }
        "getArtifact" => opt(
            st.get_artifact(id)?,
            |a: ArtifactRow| json!({ "id": a.id, "projectId": a.project_id, "body": a.body, "contentType": a.content_type, "createdAt": a.created_at }),
        ),
        "lastRepeat" => opt(st.last_repeat(s(op, "key"))?, Value::from),
        "rememberRepeat" => {
            st.remember_repeat(s(op, "key"), op["at"].as_i64().unwrap())?;
            Value::Null
        }
        "insertTrace" => {
            let i = &op["input"];
            st.insert_trace(
                s(i, "traceId"),
                s(i, "projectId"),
                s(i, "rootAgent"),
                s(i, "rootSpanId"),
                os(i, "status"),
            )?;
            Value::Null
        }
        "insertSpan" => {
            let i = &op["input"];
            st.insert_span(
                s(i, "spanId"),
                s(i, "traceId"),
                os(i, "parentSpanId"),
                s(i, "agentId"),
                s(i, "kind"),
                os(i, "status"),
                os(i, "inputPreview"),
            )?;
            Value::Null
        }
        "bindSession" => {
            st.bind_session(s(op, "span"), s(op, "session"))?;
            Value::Null
        }
        "finishSpan" => {
            let p = &op["patch"];
            let patch = SpanPatch {
                status: s(p, "status").into(),
                output_preview: os(p, "outputPreview").map(str::to_owned),
                error: os(p, "error").map(str::to_owned),
                guardrail: os(p, "guardrail").map(str::to_owned),
                input_tokens: oi(p, "inputTokens"),
                output_tokens: oi(p, "outputTokens"),
                target_kind: os(p, "targetKind").map(str::to_owned),
                origin: os(p, "origin").map(str::to_owned),
            };
            st.finish_span(s(op, "span"), &patch)?;
            Value::Null
        }
        "finishTrace" => {
            st.finish_trace(s(op, "trace"), s(op, "status"))?;
            Value::Null
        }
        "getTrace" => opt(st.get_trace(s(op, "trace"))?, |t| t.to_value()),
        "listTraces" => Value::Array(st.list_traces(proj)?.iter().map(|t| t.to_value()).collect()),
        "insertTask" => {
            let i = &op["input"];
            let t = NewTask {
                id: s(i, "id").into(),
                project_id: s(i, "projectId").into(),
                trace_id: s(i, "traceId").into(),
                span_id: s(i, "spanId").into(),
                parent_task_id: os(i, "parentTaskId").map(str::to_owned),
                from_agent: s(i, "fromAgent").into(),
                to_agent: s(i, "toAgent").into(),
                kind: s(i, "kind").into(),
                status: s(i, "status").into(),
                task: s(i, "task").into(),
                acceptance: s(i, "acceptance").into(),
                path: i["path"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_str().unwrap().to_owned())
                    .collect(),
            };
            opt(st.insert_task(&t)?, |t| t.to_value())
        }
        "updateTask" => {
            let p = &op["patch"];
            let patch = TaskPatch {
                status: s(p, "status").into(),
                result: os(p, "result").map(str::to_owned),
                truncated: ob(p, "truncated").unwrap_or(false),
                artifact_id: os(p, "artifactId").map(str::to_owned),
                error: os(p, "error").map(str::to_owned),
                input_tokens: oi(p, "inputTokens"),
                output_tokens: oi(p, "outputTokens"),
                target_kind: os(p, "targetKind").map(str::to_owned),
                origin: os(p, "origin").map(str::to_owned),
            };
            opt(st.update_task(id, &patch)?, |t| t.to_value())
        }
        "getTask" => opt(st.get_task(id)?, |t| t.to_value()),
        "listTasks" => Value::Array(
            st.list_tasks(s(op, "trace"))?
                .iter()
                .map(|t| t.to_value())
                .collect(),
        ),
        "cancelOpen" => json!(st.cancel_open_tasks(s(op, "trace"))?),
        "bColumns" => Value::Array(st.board_columns(proj)?.iter().map(J::to_value).collect()),
        "bCreateColumn" => {
            let i = &op["input"];
            st.board_create_column(
                proj,
                os(i, "title"),
                os(i, "titleKey"),
                of(i, "wipLimit"),
                of(i, "position"),
            )?
            .to_value()
        }
        "bUpdateColumn" => {
            let p = &op["patch"];
            let wip = match p.get("wipLimit") {
                None => None,
                Some(Value::Null) => Some(None),
                Some(n) => Some(n.as_f64()),
            };
            st.board_update_column(proj, id, os(p, "title"), os(p, "titleKey"), wip)?
                .to_value()
        }
        "bMoveColumn" => st
            .board_move_column(proj, id, op["position"].as_f64().unwrap())?
            .to_value(),
        "bDeleteColumn" => {
            st.board_delete_column(proj, id, os(op, "target"), actor_ref, over)?;
            json!({ "deleted": true })
        }
        "bGetCard" => st.board_get_card(proj, id)?.to_value(),
        "bCards" | "bBadCursor" => {
            let f = op.get("filter").cloned().unwrap_or(json!({}));
            let mut filter = CardFilter {
                column_id: os(&f, "columnId").map(str::to_owned),
                assignee: assignee.clone(),
                label: os(&f, "label").map(str::to_owned),
                text: os(&f, "text").map(str::to_owned),
                archived: ob(&f, "archived"),
                cursor: None,
                limit: of(&f, "limit"),
            };
            if name == "bBadCursor" {
                filter.cursor = os(op, "cursor").map(str::to_owned);
            } else if ob(op, "afterLast") == Some(true) {
                filter.cursor = c.cursor.clone();
            }
            let (cards, next) = st.board_cards(proj, &filter)?;
            if name == "bCards" {
                c.cursor = next.clone();
            }
            page_value("cards", &cards, next)
        }
        "bCreateCard" => {
            let i = &op["input"];
            st.board_create_card(
                proj,
                s(i, "columnId"),
                of(i, "position"),
                &card_fields(i),
                actor_ref,
                over,
            )?
            .to_value()
        }
        "bUpdateCard" => st
            .board_update_card(proj, id, &card_fields(&op["patch"]), actor_ref)?
            .to_value(),
        "bMoveCard" => st
            .board_move_card(
                proj,
                id,
                s(op, "column"),
                of(op, "position"),
                actor_ref,
                over,
            )?
            .to_value(),
        "bAssign" => st
            .board_assign(
                proj,
                id,
                assignee.as_ref().unwrap(),
                ob(op, "add").unwrap_or(false),
                actor_ref,
            )?
            .to_value(),
        "bArchive" => st
            .board_archive_card(
                proj,
                id,
                ob(op, "archived").unwrap_or(false),
                actor_ref,
                over,
            )?
            .to_value(),
        "bComment" => st
            .board_comment(proj, id, s(op, "text"), actor_ref)?
            .to_value(),
        "bComments" | "bActivity" => {
            let i = op.get("input").cloned().unwrap_or(json!({}));
            let cursor = if ob(op, "afterLast") == Some(true) {
                c.cursor.clone()
            } else {
                os(&i, "cursor").map(str::to_owned)
            };
            let p = if name == "bComments" {
                st.board_comments(proj, id, cursor.as_deref(), of(&i, "limit"))?
            } else {
                st.board_activity(proj, id, cursor.as_deref(), of(&i, "limit"))?
            };
            c.cursor = p.next_cursor.clone();
            page_value("items", &p.items, p.next_cursor)
        }
        other => panic!("unknown op {other}"),
    })
}

fn replay(file: &str) {
    let fx = fixture(file);
    for sc in fx["scenarios"].as_array().unwrap() {
        let name = s(sc, "name");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("collab.sqlite");
        let now = Arc::new(AtomicI64::new(1_000_000));
        let step = sc["step"].as_i64().unwrap_or(1);
        let mut c = Ctx {
            path: path.clone(),
            now,
            step,
            config: sc.get("config").map(config_from),
            ended: Arc::default(),
            throw: Arc::default(),
            warned: Arc::default(),
            ids: Arc::new(Seq::default()),
            a: None,
            b: None,
            raw: None,
            cursor: None,
        };
        c.a = Some(c.open());
        for (n, st) in sc["ops"].as_array().unwrap().iter().enumerate() {
            let op = &st["op"];
            let got = match run_op(&mut c, op) {
                Ok(v) => json!({ "ok": v }),
                Err(e) => json!({ "err": err_value(&e) }),
            };
            if got != st["out"] {
                let (g, w) = (got.to_string(), st["out"].to_string());
                let at = g
                    .bytes()
                    .zip(w.bytes())
                    .position(|(a, b)| a != b)
                    .unwrap_or(g.len().min(w.len()));
                let from = at.saturating_sub(120);
                let cut = |t: &str| t.chars().skip(from).take(300).collect::<String>();
                panic!(
                    "{file}/{name}: op #{n} {}\n  differs at {at}\n  got  ...{}\n  want ...{}",
                    op.to_string().chars().take(300).collect::<String>(),
                    cut(&g),
                    cut(&w)
                );
            }
        }
    }
}

#[test]
fn store_scenarios_match_typescript() {
    replay("store");
}

#[test]
fn board_scenarios_match_typescript() {
    replay("board");
}

// ---- pure rules -------------------------------------------------------------------------------------------------------

fn call_class(v: Option<&str>) -> Option<CallClass> {
    match v {
        Some("read") => Some(CallClass::Read),
        Some("write") => Some(CallClass::Write),
        Some("review") => Some(CallClass::Review),
        _ => None,
    }
}

#[test]
fn defaults_match_typescript() {
    let fx = fixture("pure");
    let l = resolve_collab_limits(&CollaborationLimitsConfig::default(), &J::Obj(vec![]));
    assert_eq!(
        limits_value(&l)["readHelpers"],
        fx["defaults"]["limits"]["readHelpers"]
    );
    assert_eq!(
        legacy_collab_settings(&l).to_value(),
        fx["defaults"]["settings"]
    );
}

#[test]
fn limits_match_typescript() {
    let fx = fixture("pure");
    for case in fx["limits"].as_array().unwrap() {
        let cfg = if case["config"].is_null() {
            CollaborationLimitsConfig::default()
        } else {
            config_from(&case["config"])
        };
        let project = J::parse(s(case, "projectJson")).unwrap();
        let l = resolve_collab_limits(&cfg, &project);
        let mut want = case["limits"].clone();
        // TypeScript prints the key only when the value is a number; the replay always writes it.
        if want.get("tokenBudget").is_none() {
            want["tokenBudget"] = Value::Null;
        }
        assert_eq!(limits_value(&l), want, "limits for {}", case["projectJson"]);
        assert_eq!(
            legacy_collab_settings(&l).to_value(),
            case["legacy"],
            "legacy for {}",
            case["projectJson"]
        );
    }
}

#[test]
fn guardrails_match_typescript() {
    let fx = fixture("pure");
    for case in fx["guardrails"].as_array().unwrap() {
        let i = &case["input"];
        let input = GuardrailInput {
            call_class: call_class(os(i, "callClass")),
            consult: ob(i, "consult"),
            settings: settings_from(&i["settings"]),
            from_agent: s(i, "fromAgent").into(),
            to_agent: s(i, "toAgent").into(),
            path: i["path"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap().to_owned())
                .collect(),
            fanout: i["fanout"].as_i64().unwrap(),
            pair_count: i["pairCount"].as_i64().unwrap(),
            now: i["now"].as_i64().unwrap(),
            chain_started_at: i["chainStartedAt"].as_i64().unwrap(),
            last_repeat_at: oi(i, "lastRepeatAt"),
            same_project: i["sameProject"].as_bool().unwrap(),
            tokens_used: i["tokensUsed"].as_i64().unwrap(),
            next_tokens: i["nextTokens"].as_i64().unwrap(),
        };
        let got = evaluate_guardrails(&input)
            .map_or(Value::Null, |r: GuardrailReason| Value::from(r.as_str()));
        assert_eq!(got, case["result"], "guardrail case {}", case["label"]);
    }
}

#[test]
fn capacity_matches_typescript() {
    let fx = fixture("pure");
    for case in fx["capacity"].as_array().unwrap() {
        let f = &case["facts"];
        let facts = CapacityFacts {
            cores: f["cores"].as_f64().unwrap(),
            available_memory: f["availableMemory"].as_f64().unwrap(),
            total_memory: of(f, "totalMemory"),
            settings: CapacitySettings {
                cores_per_writer: f["settings"]["coresPerWriter"].as_f64().unwrap(),
                memory_per_writer: f["settings"]["memoryPerWriter"].as_f64().unwrap(),
                max_writers: of(&f["settings"], "maxWriters"),
            },
        };
        let r = writer_capacity(
            case["perProject"].as_i64().unwrap(),
            &facts,
            case["running"].as_i64().unwrap(),
        );
        let got = json!({ "computed": num_value(r.computed), "slots": num_value(r.slots), "exceeded": r.exceeded });
        assert_eq!(got, case["result"], "capacity case {}", case["label"]);
    }
}

#[test]
fn repeat_keys_and_ids_match_typescript() {
    let fx = fixture("pure");
    for k in fx["repeatKeys"].as_array().unwrap() {
        assert_eq!(
            repeat_key(s(k, "from"), s(k, "to"), s(k, "question")),
            s(k, "key"),
            "repeat key for {}",
            k["question"]
        );
    }
    for p in fx["ids"]["pair"].as_array().unwrap() {
        assert_eq!(pair_key(s(p, "a"), s(p, "b")), s(p, "key"));
    }
    for t in fx["ids"]["traceparent"].as_array().unwrap() {
        assert_eq!(
            traceparent(s(t, "trace"), s(t, "span"), t["sampled"].as_bool().unwrap()),
            s(t, "text")
        );
    }
}

#[test]
fn work_budgets_match_typescript() {
    let fx = fixture("pure");
    for case in fx["budgets"].as_array().unwrap() {
        let parent = case["parentLimit"]
            .as_i64()
            .map(|l| DelegationWorkBudget::new(l, None));
        let b = DelegationWorkBudget::new(case["limit"].as_i64().unwrap(), parent.as_ref());
        let mut held: HashMap<String, Reservation> = HashMap::new();
        let mut got = vec![];
        for st in case["steps"].as_array().unwrap() {
            let who = s(st, "as").to_owned();
            if let Some(n) = st.get("reserve").and_then(Value::as_f64) {
                match b.reserve(n) {
                    Ok(r) => {
                        held.insert(who, r);
                        got.push(json!({ "ok": null }));
                    }
                    Err(e) => got.push(json!({ "err": err_value(&e) })),
                }
            } else if let Some(n) = st.get("settle").and_then(Value::as_i64) {
                // TypeScript throws a `TypeError` on a reservation that was never granted; that records as a raw failure.
                match held.get_mut(&who) {
                    Some(r) => {
                        r.settle(n);
                        got.push(json!({ "ok": null }));
                    }
                    None => got.push(json!({ "err": { "raw": true } })),
                }
            } else if st.get("release").is_some() {
                match held.get_mut(&who) {
                    Some(r) => {
                        r.release();
                        got.push(json!({ "ok": null }));
                    }
                    None => got.push(json!({ "err": { "raw": true } })),
                }
            }
            got.push(json!({ "used": b.used(), "parentUsed": parent.as_ref().map_or(Value::Null, |p| Value::from(p.used())) }));
        }
        assert_eq!(
            Value::Array(got).to_string(),
            case["out"].to_string(),
            "budget case {}",
            case["label"]
        );
    }
}

// ---- schema -----------------------------------------------------------------------------------------------------------

fn dump(conn: &rusqlite::Connection) -> Value {
    let mut st = conn
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
        .unwrap();
    let rows = st
        .query_map([], |r| {
            Ok(json!({ "type": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "tbl_name": r.get::<_, String>(2)?, "sql": r.get::<_, Option<String>>(3)? }))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    Value::Array(rows)
}

fn at_version(path: &Path, v: usize) {
    let conn = rusqlite::Connection::open(path).unwrap();
    for m in &MIGRATIONS[..v] {
        conn.execute_batch(m).unwrap();
    }
    conn.execute_batch(&format!("PRAGMA user_version = {v}"))
        .unwrap();
}

fn fresh_store(path: &Path) -> CollabStore {
    let o = StoreOptions::new(
        Arc::new(Clk {
            now: Arc::new(AtomicI64::new(1)),
            step: 0,
        }),
        Arc::new(Seq::default()),
    );
    CollabStore::open_with_permissions(path, o, crate::private_store::fixture_owner_hook())
        .expect("store opens")
}

#[test]
fn migration_texts_and_version_match_typescript() {
    let fx = fixture("schema");
    assert_eq!(fx["version"].as_u64().unwrap() as u32, SCHEMA_VERSION);
    let want: Vec<&str> = fx["migrations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m.as_str().unwrap())
        .collect();
    assert_eq!(MIGRATIONS.to_vec(), want);
}

#[test]
fn every_schema_version_migrates_to_the_current_schema() {
    let fx = fixture("schema");
    for v in 1..=SCHEMA_VERSION as usize {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("collab.sqlite");
        at_version(&path, v);
        assert_eq!(
            dump(&rusqlite::Connection::open(&path).unwrap()),
            fx["prefixes"][v.to_string()],
            "schema at v{v}"
        );
        let mut st = fresh_store(&path);
        assert_eq!(
            st.user_version().unwrap(),
            SCHEMA_VERSION,
            "migrated from v{v}"
        );
        st.close();
        assert_eq!(
            dump(&rusqlite::Connection::open(&path).unwrap()),
            fx["schema"],
            "schema migrated from v{v}"
        );
        assert_eq!(fx["migratedUserVersions"][v.to_string()], SCHEMA_VERSION);
    }
}

#[test]
fn a_newer_schema_is_refused_and_left_untouched() {
    let fx = fixture("schema");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("collab.sqlite");
    at_version(&path, SCHEMA_VERSION as usize);
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(&format!("PRAGMA user_version = {}", SCHEMA_VERSION + 1))
        .unwrap();
    let before = std::fs::read(&path).unwrap();
    let o = StoreOptions::new(
        Arc::new(Clk {
            now: Arc::new(AtomicI64::new(1)),
            step: 0,
        }),
        Arc::new(Seq::default()),
    );
    let err = match CollabStore::open_with_permissions(
        &path,
        o,
        crate::private_store::fixture_owner_hook(),
    ) {
        Ok(_) => panic!("a newer schema must be refused"),
        Err(e) => e,
    };
    assert_eq!(err_value(&err), fx["newerRefusal"]);
    assert_eq!(
        std::fs::read(&path).unwrap(),
        before,
        "the file is untouched"
    );
}
