//! Unit tests of the ledger beside the recorded scenarios.
use super::ledger::{StartedEntry, SystemJobsLedger};
use crate::approvals::js_json::J;
use std::collections::HashSet;
use std::rc::Rc;

#[test]
fn a_started_row_without_an_end_reads_back_abandoned_unless_it_is_in_flight() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir
        .path()
        .join("state")
        .join("system-jobs")
        .join("ledger.jsonl");
    let l = SystemJobsLedger::new(path, Box::new(|_| true), Rc::new(|_, _| {}));
    l.begin(&StartedEntry {
        run_id: "r1".into(),
        job: "j".into(),
        trigger: "cron".into(),
        started_at: 5.0,
        args: Some(J::obj([("a", J::Num(1.0))])),
    })
    .unwrap();
    let gone = l.read_all(&HashSet::new());
    assert_eq!(gone.len(), 1);
    assert_eq!(gone[0].outcome, "abandoned");
    let live = l.read_all(&HashSet::from(["r1".to_owned()]));
    assert!(live.is_empty(), "a run in flight is not reported yet");
}

#[cfg(unix)]
#[test]
fn the_ledger_directory_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir
        .path()
        .join("state")
        .join("system-jobs")
        .join("ledger.jsonl");
    let l = SystemJobsLedger::new(path.clone(), Box::new(|_| true), Rc::new(|_, _| {}));
    l.begin(&StartedEntry {
        run_id: "r".into(),
        job: "j".into(),
        trigger: "cron".into(),
        started_at: 1.0,
        args: None,
    })
    .unwrap();
    let mode = std::fs::metadata(path.parent().unwrap())
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o700);
}
