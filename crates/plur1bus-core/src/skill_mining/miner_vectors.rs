use super::*;
use crate::approvals::js_json::J;
use crate::sessions::types::{MemoryMode, SessionKind, SessionRecord, TurnState};
use crate::skill_mining::evidence::{Execution, Store};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

fn str_at<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap()
}
fn str_value(row: &Value, key: &str) -> String {
    str_at(row, key).into()
}
fn num(row: &Value, key: &str) -> i64 {
    row[key].as_i64().unwrap()
}

pub(in crate::skill_mining) struct Source {
    name: String,
    sessions: Vec<SessionRecord>,
    turns: Vec<TurnRecord>,
    events: HashMap<String, Vec<EventRecord>>,
}

impl Sessions for Source {
    fn archived(&self, _: &Scope, _: usize) -> R<SessionPage> {
        Ok(SessionPage {
            sessions: self.sessions.clone(),
            truncated: self.name == "session cap",
        })
    }
    fn turns(&self, id: &str) -> R<Vec<TurnRecord>> {
        Ok(self
            .turns
            .iter()
            .filter(|t| t.session_id == id)
            .cloned()
            .collect())
    }
    fn events(&self, id: &str, after: i64, max: usize) -> R<Vec<EventRecord>> {
        Ok(self
            .events
            .get(id)
            .unwrap()
            .iter()
            .filter(|e| {
                if self.name == "nonadvancing" && id == "s1" {
                    after == 0
                } else {
                    e.seq > after
                }
            })
            .take(max)
            .cloned()
            .collect())
    }
}

pub(in crate::skill_mining) fn source(row: &Value) -> Source {
    let sessions = row["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| SessionRecord {
            id: str_value(s, "id"),
            kind: SessionKind::parse(str_at(s, "kind")).unwrap(),
            agent_id: str_value(s, "agentId"),
            owner: str_value(s, "owner"),
            scope: str_value(s, "scope"),
            chat_key: None,
            title: str_value(s, "title"),
            pinned: false,
            memory_mode: MemoryMode::parse(str_at(s, "memoryMode")).unwrap(),
            created_at: num(s, "createdAt"),
            updated_at: num(s, "updatedAt"),
            last_turn_at: s["lastTurnAt"].as_i64(),
            archived_at: s["archivedAt"].as_i64(),
            turn_count: num(s, "turnCount"),
            origin: None,
        })
        .collect();
    let turns = row["turns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| TurnRecord {
            id: str_value(t, "id"),
            session_id: str_value(t, "sessionId"),
            seq: num(t, "seq"),
            state: TurnState::parse(str_at(t, "state")).unwrap(),
            started_at: num(t, "startedAt"),
            ended_at: t["endedAt"].as_i64(),
            error: None,
            incognito: t["incognito"].as_bool().unwrap(),
        })
        .collect();
    let events = row["events"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(id, rows)| {
            let events = rows
                .as_array()
                .unwrap()
                .iter()
                .map(|e| EventRecord {
                    session_id: str_value(e, "sessionId"),
                    turn_id: e["turnId"].as_str().map(str::to_owned),
                    seq: num(e, "seq"),
                    kind: str_value(e, "type"),
                    data: J::parse(&e["data"].to_string()).unwrap(),
                    at: num(e, "at"),
                })
                .collect();
            (id.clone(), events)
        })
        .collect();
    Source {
        name: str_value(row, "name"),
        sessions,
        turns,
        events,
    }
}

#[test]
fn mining_archived_scoped_proofs_matches_typescript() {
    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/skills/mining.json"
    ))
    .unwrap();
    for row in fixture {
        let config: Settings = serde_json::from_value(row["config"].clone()).unwrap();
        let want: Scope = serde_json::from_value(row["scope"].clone()).unwrap();
        let tools: Vec<Tool> = serde_json::from_value(row["tools"].clone()).unwrap();
        let source = source(&row);
        let store = Store::open(Path::new(":memory:")).unwrap();
        for record in row["recorded"].as_array().unwrap() {
            store
                .record(&serde_json::from_value::<Execution>(record.clone()).unwrap())
                .unwrap();
        }
        let actual = match mine(&source, &want, &tools, &store, config) {
            Ok(candidates) => json!({"candidates":candidates}),
            Err(e) => json!({"error":match e.code{
                C::Invalid=>"E_INVALID_PARAMS",
                C::Conflict=>"E_NOT_AVAILABLE",
                _=>"E_STORAGE"
            }}),
        };
        assert_eq!(actual, row["expected"], "{}", source.name);
        assert!(!actual.to_string().contains("fixture-private"));
    }
}
