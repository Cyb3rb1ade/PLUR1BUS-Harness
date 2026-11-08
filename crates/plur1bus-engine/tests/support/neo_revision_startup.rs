//! Component startup restores original C4 callers without accepting a replacement request.
use super::*;
use plur1bus_engine::contract::StoreError;
fn journal(f: &Fixture) -> Arc<CaptureJournal> {
    Arc::new(
        CaptureJournal::open(
            &f._root.path().join("neo"),
            f.host.clone(),
            f.policy.clone(),
        )
        .unwrap(),
    )
}
fn prepared() -> Fixture {
    let mut f = fixture();
    let case = cases().remove(4);
    let request = request(&case, source(&f, &case));
    f.store = RevisionStore::new(journal(&f), f.host.clone()).with_observer(Arc::new(|stage| {
        if stage == "revision" {
            Err(StoreError::Unavailable.into())
        } else {
            Ok(())
        }
    }));
    assert!(f
        .store
        .apply(&f.principal, &f.agent, &request, &Cancel::never())
        .is_err());
    f
}
fn open(f: &Fixture) -> Result<RevisionStore, EngineError> {
    RevisionStore::open(journal(f), f.host.clone())
}
#[test]
fn opening_finishes_curation_without_any_new_request_or_clock() {
    let f = prepared();
    f.host.time.store(1794225600000, Ordering::SeqCst);
    let store = open(&f).unwrap();
    assert_eq!(store.recover_pending(&Cancel::never()).unwrap(), 0);
    assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 2);
    let audit = rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl"));
    assert_eq!(audit.len(), 1);
    assert_eq!(
        field(&audit[0], "timestamp"),
        &text("2026-11-08T12:00:00.000Z")
    );
    assert_eq!(rows(f.directory.join("embedding-queue.jsonl")).len(), 1);
}
#[test]
fn original_callers_in_two_workspaces_are_recovered_independently() {
    let f = prepared();
    let workspace = f._root.path().join("workspace-beta");
    fs::create_dir(&workspace).unwrap();
    f.host.set_workspace("beta", workspace.clone());
    let mut principal = serde_json::to_value(&f.principal).unwrap();
    principal["agentId"] = json!("beta");
    principal["workspace"] = json!(format!("workspace-dir:v1:{}", workspace.display()));
    principal["user"] = json!(harness_user_principal("second-user"));
    principal["chat"]["id"] = json!("second-chat");
    let principal: Principal = serde_json::from_value(principal).unwrap();
    let context = RequestContext::build(&principal, &f.agent, f.host.as_ref()).unwrap();
    let directory = f
        ._root
        .path()
        .join("neo/workspaces")
        .join(Layout::for_key(&context.workspace_key).canonical);
    fs::create_dir_all(&directory).unwrap();
    let case = cases().remove(4);
    let mut expected = field(&case, "source").clone();
    set(&mut expected, "agentId", text("beta"));
    set(&mut expected, "ownerUserId", text(&context.owner_user_id));
    set(&mut expected, "workspaceKey", text(&context.workspace_key));
    fs::write(
        directory.join("behavior-cards.jsonl"),
        format!("{}\n", write_json(&expected)),
    )
    .unwrap();
    assert!(f
        .store
        .apply(
            &principal,
            &f.agent,
            &request(&case, expected),
            &Cancel::never()
        )
        .is_err());
    let store = RevisionStore::new(journal(&f), f.host.clone());
    assert_eq!(store.recover_pending(&Cancel::never()).unwrap(), 2);
    for (path, agent) in [(f.workspace.clone(), "alpha"), (workspace, "beta")] {
        let audit = rows(path.join(".adaptive-learning/destructive-ops.jsonl"));
        assert_eq!(audit.len(), 1);
        assert_eq!(field(&audit[0], "agentId"), &text(agent));
    }
    assert_eq!(rows(directory.join("behavior-cards.jsonl")).len(), 2);
}
#[test]
fn complete_read_only_inventory_rejects_wrong_locations_before_any_replay() {
    let f = prepared();
    let wrong = f._root.path().join("neo/workspaces/wrong");
    fs::create_dir(&wrong).unwrap();
    fs::copy(
        f.directory.join("native-revision-state.json"),
        wrong.join("native-revision-state.json"),
    )
    .unwrap();
    assert!(open(&f).is_err());
    assert!(rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl")).is_empty());
    assert!(!f.directory.join("embedding-queue.jsonl").exists());
    assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 2);
}
#[test]
fn startup_does_not_reconstruct_authority_from_the_saved_owner() {
    let f = prepared();
    let host = Arc::new(support::TestHost::new(f._root.path().join("state")));
    let unbound = Arc::new(
        CaptureJournal::open(&f._root.path().join("neo"), host.clone(), f.policy.clone()).unwrap(),
    );
    assert!(RevisionStore::open(unbound, host).is_err());
    f.policy.0.store(false, Ordering::SeqCst);
    assert!(open(&f).is_err());
    assert!(rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl")).is_empty());
    f.policy.0.store(true, Ordering::SeqCst);
    open(&f).unwrap();
}
#[cfg(unix)]
#[test]
fn linked_state_and_oversized_state_block_startup_before_effects() {
    for kind in ["symlink", "hardlink", "oversize"] {
        let f = prepared();
        let path = f.directory.join("native-revision-state.json");
        let saved = f._root.path().join("saved-state");
        fs::rename(&path, &saved).unwrap();
        match kind {
            "symlink" => std::os::unix::fs::symlink(&saved, &path).unwrap(),
            "hardlink" => fs::hard_link(&saved, &path).unwrap(),
            _ => fs::write(&path, vec![b' '; 8 * 1024 * 1024 + 1]).unwrap(),
        }
        assert!(open(&f).is_err());
        assert!(rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl")).is_empty());
    }
}

fn turn(f: &Fixture) -> plur1bus_engine::contract::TurnRecord {
    serde_json::from_value(
        json!({"agentId":"alpha","principal":f.principal,"agent":f.agent,
        "runId":"automatic-one","sessionKey":"automatic-session","incognito":false,
        "messages":[{"role":"user","content":"Synthetic automatic capture"}]}),
    )
    .unwrap()
}
struct StopOnCapturePlan(PathBuf);
impl CapturePolicy for StopOnCapturePlan {
    fn allowed(&self, _: &RequestContext) -> Result<bool, EngineError> {
        let found = fs::read_dir(&self.0)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("native-capture-pending-")
            });
        Ok(!found)
    }
}
#[test]
fn a_human_revision_must_not_replay_capture_using_the_human_policy() {
    let f = fixture();
    let case = cases().remove(4);
    let request = request(&case, source(&f, &case));
    let capture = CaptureJournal::open(
        &f._root.path().join("neo"),
        f.host.clone(),
        Arc::new(StopOnCapturePlan(f.directory.clone())),
    )
    .unwrap();
    assert!(capture
        .record(&turn(&f), &f.context, &Cancel::never())
        .is_err());
    assert!(!f.directory.join("turn-journal.jsonl").exists());
    assert!(f
        .store
        .apply(&f.principal, &f.agent, &request, &Cancel::never())
        .is_err());
    assert!(
        !f.directory.join("turn-journal.jsonl").exists(),
        "human policy replayed automatic capture"
    );
    assert!(!f.directory.join("native-revision-state.json").exists());
    journal(&f)
        .recover(&f.principal, &f.agent, &Cancel::never())
        .unwrap();
    f.store
        .apply(&f.principal, &f.agent, &request, &Cancel::never())
        .unwrap();
}
#[test]
fn new_automatic_capture_cannot_change_a_pending_human_publication() {
    let f = prepared();
    let capture = journal(&f);
    assert!(capture
        .record(&turn(&f), &f.context, &Cancel::never())
        .is_err());
    assert!(!f.directory.join("turn-journal.jsonl").exists());
    open(&f).unwrap();
    capture
        .record(&turn(&f), &f.context, &Cancel::never())
        .unwrap();
}

#[test]
fn inventory_budget_counts_actual_file_bytes_including_whitespace() {
    let f = prepared();
    let completed = prepared();
    open(&completed).unwrap();
    let mut receipt = fs::read(completed.directory.join("native-revision-state.json")).unwrap();
    receipt.resize(8 * 1024 * 1024, b' ');
    for index in 0..8 {
        let dir = f
            ._root
            .path()
            .join("neo/workspaces")
            .join(format!("historical-{index}"));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("native-revision-state.json"), &receipt).unwrap();
    }
    assert!(open(&f).is_err());
    assert!(!f.directory.join("embedding-queue.jsonl").exists());
    assert!(rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl")).is_empty());
}
