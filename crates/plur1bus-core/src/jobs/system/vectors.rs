//! Replays `fixtures/parity/jobs/system.json` (mode V, `scripts/parity/export-jobs.ts`): the registry over a real ledger
//! directory (each op's answer, the warnings, the files after it) and the arm of the approvals integrity job against recorded
//! timers.
use super::testing::{replay_arm, replay_system};
use serde_json::Value;

#[test]
fn every_recorded_system_scenario_gives_typescripts_answers_warnings_and_files() {
    let all: Value = serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/jobs/system.json"
    ))
    .unwrap();
    let list = all.as_array().unwrap();
    let (mut ledger, mut arm) = (0, 0);
    for sc in list {
        if sc["name"].as_str().unwrap().starts_with("arm-") {
            replay_arm(sc);
            arm += 1;
        } else {
            replay_system(sc);
            ledger += 1;
        }
    }
    assert!(
        ledger >= 9 && arm >= 3,
        "{ledger} registry and {arm} arm scenarios"
    );
}
