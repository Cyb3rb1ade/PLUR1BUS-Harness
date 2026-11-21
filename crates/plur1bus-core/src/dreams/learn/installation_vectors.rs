use super::*;
use crate::approvals::js_json::J;
use crate::rbac::types::{PrincipalKind, Role};
use crate::sessions::types::LearningToolError;
use crate::toolcall::json::parse;
use serde_json::{json, Value};

struct SourceFixture<'a> {
    name: &'a str,
    rows: Vec<V>,
    events: Vec<LearningToolError>,
    user: Principal,
}

impl Source for SourceFixture<'_> {
    fn current_person(&self, _: &str) -> Option<Principal> {
        Some(self.user.clone())
    }
    fn sessions(&self, _: &Target, _: Window, _: usize, _: usize) -> Result<Vec<V>, Error> {
        panic!("installation must never enumerate transcripts")
    }
    fn may_read_target(&self, _: &Target, _: &Principal) -> bool {
        true
    }
    fn session(&self, id: &str) -> Result<Option<V>, Error> {
        Ok(self
            .rows
            .iter()
            .find(|row| row.get("id").unwrap().is_str(id))
            .cloned())
    }
    fn may_read(&self, _: &Target, row: &V, _: &Principal) -> bool {
        self.name != "denied scope" || !row.get("id").unwrap().is_str("s2")
    }
    fn transcript(&self, _: &V, _: Window) -> Result<V, Error> {
        panic!("installation cannot load transcript content")
    }
    fn tool_errors(&self, _: &Target, _: Window) -> Result<Vec<LearningToolError>, Error> {
        if self.name == "missing port" {
            return Err(Error::Source);
        }
        Ok(self.events.clone())
    }
}

fn from_wire(wire: &str) -> LearningToolError {
    let row = parse(wire).unwrap();
    let s = |key| row.get(key).unwrap().as_js().unwrap().lossy();
    let n = |key| row.get(key).unwrap().as_f64().unwrap() as i64;
    LearningToolError {
        session_id: s("sessionId"),
        turn_id: s("turnId"),
        seq: n("seq"),
        at: n("at"),
        metadata: J::parse(&row.get("metadata").unwrap().stringify()).unwrap(),
    }
}

#[test]
fn installation_uses_only_bounded_structural_evidence() {
    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/learn/installation.json"
    ))
    .unwrap();
    let target = Target {
        scope: "installation".into(),
        owner: "ada".into(),
        agent_id: "alpha".into(),
        project_id: None,
    };
    let win = Window { from: 1, to: 100 };
    for row in fixture {
        let name = row["name"].as_str().unwrap();
        let mut person = Principal::new(
            "ada",
            if name == "non-owner" {
                Role::Admin
            } else {
                Role::Owner
            },
        );
        person.kind = PrincipalKind::parse(row["person"]["kind"].as_str().unwrap());
        let events = if name == "overflow" {
            let item = from_wire(
                r#"{"sessionId":"s1","turnId":"t","seq":1,"at":23,"metadata":{"version":1}}"#,
            );
            vec![item; 4001]
        } else {
            row["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| from_wire(v.as_str().unwrap()))
                .collect()
        };
        let source = SourceFixture {
            name,
            rows: row["rows"]
                .as_array()
                .unwrap()
                .iter()
                .map(V::from_serde)
                .collect(),
            events,
            user: person.clone(),
        };
        let result = match collect(
            &source,
            &target,
            &person,
            win,
            "run-fixture",
            row["cap"].as_u64().unwrap() as usize,
            100,
        ) {
            Ok(out) => {
                let mut value = json!(out);
                value["findings"] = json!(out
                    .findings
                    .iter()
                    .map(|f| serde_json::from_str::<Value>(&f.stringify()).unwrap())
                    .collect::<Vec<_>>());
                json!({"result":value})
            }
            Err(e) => json!({"error":e.as_str()}),
        };
        assert!(
            V::from_serde(&result).deep_equal(&V::from_serde(&row["expected"])),
            "{name}\nactual {result}\nexpected {}",
            row["expected"]
        );
    }
}
