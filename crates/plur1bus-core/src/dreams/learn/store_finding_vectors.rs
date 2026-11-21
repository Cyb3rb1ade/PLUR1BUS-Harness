use super::*;
use crate::dreams::learn::digest;
use crate::dreams::learn::store::{Reconcile, Window};
use crate::toolcall::json::parse;
use serde_json::{json, Value};
use std::path::Path;

const DAY: i64 = 86_400_000;

struct Erased;
impl Reconcile for Erased {
    fn target(&self, _: &Target) -> bool {
        true
    }
    fn session(&self, _: &Target, id: &str) -> bool {
        id != "s1" && !id.starts_with("observed")
    }
    fn evidence(&self, _: &Target, e: &V) -> bool {
        !e.get("sessionId").is_some_and(|v| v.is_str("s1"))
    }
}

fn native(v: &V) -> Value {
    serde_json::from_str(&v.stringify()).unwrap()
}
fn field(v: &V, key: &str) -> String {
    v.get(key).unwrap().as_js().unwrap().lossy()
}

#[test]
fn revisions_predictions_and_erasure_match_typescript() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/learn/finding-store.json"
    ))
    .unwrap();
    let target: Target = serde_json::from_value(fixture["target"].clone()).unwrap();
    let store = LearnStore::open(Path::new(":memory:")).unwrap();
    let create = |name: &str, from: i64, to: i64, sid: &str| {
        let mut run = store.begin(&target, Window { from, to }, to).unwrap();
        run.session_ids = vec![sid.into()];
        run.digest = name.into();
        store.save(&run).unwrap();
        let data = parse(fixture["keep"][name].as_str().unwrap()).unwrap();
        store
            .publish(&run, data.as_arr().unwrap(), to + 1, &[])
            .unwrap()
    };
    let first = create("first", 10, 20, "s1");
    let initial = store.findings(&first.id).unwrap();
    let kept = initial.iter().find(|f| field(f, "text") == "kept").unwrap();
    let rejected = initial
        .iter()
        .find(|f| field(f, "text") == "reviewed")
        .unwrap();
    let id = field(kept, "id");
    let expected_hash = digest(kept);
    store.start_action(&id, "ada", &expected_hash).unwrap();
    let action_started = store.action(&id, 1).unwrap().as_ref().map(native);
    let receipt =
        parse(r#"{"operation":"memory.importText.apply","runId":"apply-fixture"}"#).unwrap();
    store
        .decide(&id, "ada", &expected_hash, Decision::Accepted, 24, &receipt)
        .unwrap();
    store
        .decide(
            &field(rejected, "id"),
            "ada",
            &digest(rejected),
            Decision::Rejected,
            25,
            &V::obj([]),
        )
        .unwrap();
    let decisions = store
        .decisions(&first.id)
        .unwrap()
        .iter()
        .map(native)
        .collect::<Vec<_>>();
    let initial_prediction = store.prediction(&id).unwrap().as_ref().map(native);
    let repeated = create("repeated", 20, 30, "s1");
    let reopened = create("reopened", 30, 40, "s2");
    let reopened_finding = native(&store.findings(&reopened.id).unwrap()[0]);
    let mut wide = store
        .begin(
            &target,
            Window {
                from: 24,
                to: 14 * DAY + 25,
            },
            14 * DAY + 25,
        )
        .unwrap();
    let observations: Vec<Observation> =
        serde_json::from_value(fixture["observations"].clone()).unwrap();
    wide.session_ids = observations.iter().map(|o| o.session_id.clone()).collect();
    wide.digest = "observation".into();
    store.save(&wide).unwrap();
    store
        .publish(&wide, &[], wide.started_at + 1, &observations)
        .unwrap();
    let confirmed = store.prediction(&id).unwrap().as_ref().map(native);
    let stable = store
        .target_findings(&target, 100, 0)
        .unwrap()
        .iter()
        .map(|f| json!({"id":field(f,"id"),"status":field(f,"status"),"hash":digest(f)}))
        .collect::<Vec<_>>();
    store.reconcile(15 * DAY, 7, &Erased).unwrap();
    let withdrawn = store.finding(&id).unwrap().as_ref().map(native);
    let after_prediction = store.prediction(&id).unwrap().as_ref().map(native);
    let summaries = store
        .decided_findings("ada")
        .unwrap()
        .iter()
        .map(
            |op| json!({"id":field(op.get("finding").unwrap(),"id"),"outcome":field(op,"outcome")}),
        )
        .collect::<Vec<_>>();
    let actual = json!({"initial":initial.iter().map(native).collect::<Vec<_>>(),"actionStarted":action_started,
        "decisions":decisions,"initialPrediction":initial_prediction,"repeated":repeated.findings,
        "reopenedFinding":reopened_finding,"confirmed":confirmed,"stable":stable,"withdrawn":withdrawn,
        "afterPrediction":after_prediction,"action":store.action(&id,1).unwrap().as_ref().map(native),"summaries":summaries});
    for (key, value) in actual.as_object().unwrap() {
        assert_eq!(value, &fixture["expected"][key], "{key}");
    }
}
