//! RE-D162: no owner's retained work delays or fails another owner's capture.
//!
//! One shared assertion (a foreign turn with a caller deadline is stored) runs against
//! every holder a recovery can wait on. Holders never let go before the assertion, so a
//! dependency shows as a missing result, never as a timing race.
//!
//! The deadline only has to be shorter than the shortest budget a holder could impose. The
//! engines under test therefore run with a capture budget of 120 s and a Neo budget of
//! 60 s, and the caller gives its turn 20 s: any dependency on a holder costs at least a
//! minute and still ends the turn unstored, while a loaded machine has several times the
//! time a turn needs on its own. The tests of this module run one after the other.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "isolated fixture errors are fatal"
)]

use super::*;
use std::sync::mpsc;

/// The budgets of the engines under test: far above the caller's deadline (module text).
fn patient(host: Arc<FakeHost>) -> Arc<FakeHost> {
    let mut config = serde_json::to_value(host.config()).unwrap();
    config["runtime"]["captureTimeoutMs"] = json!(120_000);
    config["neo"]["agentEndBudgetMs"] = json!(60_000);
    host.set_config(serde_json::from_value(config).unwrap());
    host
}

/// The caller's deadline of a foreign turn.
const FOREIGN_DEADLINE: Duration = Duration::from_secs(20);

/// The tests of this module measure against the wall clock; they do not load each other.
fn serial() -> std::sync::MutexGuard<'static, ()> {
    static TIMED: Mutex<()> = Mutex::new(());
    TIMED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn engine_on(host: Arc<dyn HostServices>) -> Arc<ProcessEngine> {
    Arc::new(ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap())
}

/// The first workspace lookup for `agent` hangs while `<root>/hang` exists; later ones answer.
fn hanging(root: &Path, inner: Arc<FakeHost>) -> Arc<CrashHost> {
    fs::write(root.join("hang"), "").unwrap();
    Arc::new(CrashHost {
        inner,
        root: root.to_path_buf(),
        phase: "hang-first".into(),
    })
}

fn wait_for(path: &Path, what: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while !path.exists() {
        assert!(std::time::Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Compose capture on its own thread: the composition must return whatever a holder does.
fn compose(engine: &Arc<ProcessEngine>, root: &Path, case: &str) {
    let (sent, opened) = mpsc::channel();
    let (engine, base) = (engine.clone(), root.join("db"));
    std::thread::spawn(move || {
        let _ = sent.send(engine_capture::ProcessCapture::open(&engine, &base).is_ok());
    });
    let composed = opened.recv_timeout(Duration::from_secs(20));
    assert_eq!(composed, Ok(true), "{case}: composition waits for a holder");
}

/// The shared assertion: a foreign turn with the caller's deadline is stored.
fn foreign_turn_is_stored(engine: &Arc<ProcessEngine>, mut turn: TurnRecord, case: &str) {
    turn.cancel = Cancel::with_deadline(std::time::Instant::now() + FOREIGN_DEADLINE);
    let (sent, done) = mpsc::channel();
    let engine = engine.clone();
    std::thread::spawn(move || {
        let result = engine.capture(turn, options()).map(|handle| {
            let result: CaptureResult = handle.done.recv_timeout(Duration::from_secs(60)).unwrap();
            serde_json::to_value(result).unwrap()
        });
        let _ = sent.send(result.map_err(|error| error.to_string()));
    });
    let result = done
        .recv_timeout(FOREIGN_DEADLINE + Duration::from_secs(60))
        .unwrap_or_else(|_| panic!("{case}: the foreign turn never finished"))
        .unwrap_or_else(|error| panic!("{case}: {error}"));
    assert_eq!(result["stored"], 2, "{case}: {result}");
}

/// Leave durable admissions for `turns`, as workers killed after admission would.
fn retain(root: &Path, host: Arc<FakeHost>, turns: &[TurnRecord]) {
    let engine = engine_on(host);
    engine_capture::ProcessCapture::open(&engine, &root.join("db")).unwrap();
    for turn in turns {
        engine.capture.pipeline_for_test().retain_for_test(turn);
    }
    engine.close(None).unwrap();
}

/// The owner scopes that retain an admission (directory names, or the old name prefix).
fn retained_scopes(root: &Path) -> Vec<String> {
    let mut scopes = fs::read_dir(root.join("db/_capture-admissions"))
        .unwrap()
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|name| {
            let scope = name.split(['-', '.']).next().unwrap_or_default().to_owned();
            (scope.len() == 16 && !name.starts_with('.')).then_some(scope)
        })
        .collect::<Vec<_>>();
    scopes.sort();
    scopes.dedup();
    scopes
}

/// Hold every retained scope's lease, as another process would.
fn hold_scopes(root: &Path) -> Vec<crate::store::kernel_lease::KernelLease> {
    let leases = crate::store::directory::TrustedDirectory::open(
        &root.join("db/_capture-admissions/.leases"),
    )
    .unwrap();
    retained_scopes(root)
        .iter()
        .map(|scope| {
            crate::store::kernel_lease::acquire(&leases, scope, &Cancel::never(), &mut || {})
                .unwrap()
        })
        .collect()
}

/// The workspace directory under the Neo root that holds the killed turn's prepared plan.
fn neo_workspace(root: &Path) -> PathBuf {
    fs::read_dir(root.join("db/_neo/workspaces"))
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir())
        .unwrap()
}

fn remove_admissions(root: &Path) {
    let directory = root.join("db/_capture-admissions");
    for entry in fs::read_dir(&directory).unwrap().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if entry.path().is_dir() {
            fs::remove_dir_all(entry.path()).unwrap();
        } else {
            fs::remove_file(entry.path()).unwrap();
        }
    }
}

/// (a) Three owners each retain a record whose recovery is slow (their lease is held).
#[test]
fn three_slow_scopes_never_delay_a_foreign_turn() {
    let _serial = serial();
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let owners = ["owner-a", "owner-b", "owner-c"];
    let first = host(root);
    let turns = owners.map(|owner| user_turn(root, owner, &format!("run-retained-{owner}")));
    retain(root, first, &turns);
    assert_eq!(retained_scopes(root).len(), 3);
    let held = hold_scopes(root);
    let engine = engine_on(patient(host(root)));
    compose(&engine, root, "a");
    foreign_turn_is_stored(&engine, turn("other", "run-other"), "a/other agent");
    foreign_turn_is_stored(&engine, user_turn(root, "owner-d", "run-d"), "a/same agent");
    // Nothing of the slow owners is lost.
    assert_eq!(admissions_with_content(root), 3);
    drop(held);
    engine.close(None).unwrap();
}

/// (b) A prepared Neo plan whose replay hangs. The replay calls no provider
/// (`EmbeddingDrain::new`: "Recovery uses saved vectors"), so the hang is the binding's host
/// lookup, the only call a replay cannot bound itself.
#[test]
fn a_hanging_neo_replay_never_delays_a_foreign_turn() {
    let _serial = serial();
    let scratch = killed("neo-plan");
    let root = scratch.path().to_path_buf();
    remove_admissions(&root);
    let engine = engine_on(hanging(&root, patient(neo_host(&root))));
    compose(&engine, &root, "b");
    wait_for(&root.join("hang-entered"), "b: the replay never started");
    foreign_turn_is_stored(&engine, turn("other", "run-other"), "b/other agent");
    foreign_turn_is_stored(
        &engine,
        user_turn(&root, "owner-b", "run-b"),
        "b/same agent",
    );
    assert_eq!(neo_plans_with_content(&root), 1);
    fs::remove_file(root.join("hang")).unwrap();
    engine.close(None).unwrap();
}

/// (c) A revoked plan whose workspace lease another process holds (I3).
#[test]
fn a_held_workspace_lease_never_delays_a_foreign_turn() {
    let _serial = serial();
    let scratch = killed("neo-plan");
    let root = scratch.path().to_path_buf();
    revoke_for(&root, &user_turn(&root, "owner-a", "run-crash"));
    let leases = crate::store::directory::TrustedDirectory::open(&neo_workspace(&root))
        .unwrap()
        .create_child(".native-capture-leases")
        .unwrap();
    let held =
        crate::store::kernel_lease::acquire(&leases, "workspace", &Cancel::never(), &mut || {})
            .unwrap();
    let engine = engine_on(patient(neo_host(&root)));
    compose(&engine, &root, "c");
    foreign_turn_is_stored(&engine, turn("other", "run-other"), "c/other agent");
    foreign_turn_is_stored(&engine, foreign_owner_turn(&root, "run-f"), "c/other owner");
    drop(held);
    engine.close(None).unwrap();
}

/// (d) The interoperable Neo write lock is held from outside.
#[test]
fn a_held_neo_write_lock_never_delays_a_foreign_turn() {
    let _serial = serial();
    let scratch = killed("neo-plan");
    let root = scratch.path().to_path_buf();
    let held = crate::store::lock::Lock::try_acquire_neo(
        &neo_workspace(&root).join(".neo-write.lock"),
        Duration::from_secs(300),
    )
    .unwrap()
    .unwrap();
    let engine = engine_on(patient(neo_host(&root)));
    compose(&engine, &root, "d");
    foreign_turn_is_stored(&engine, turn("other", "run-other"), "d/other agent");
    foreign_turn_is_stored(&engine, foreign_owner_turn(&root, "run-f"), "d/other owner");
    assert_eq!(neo_plans_with_content(&root), 1);
    drop(held);
    engine.close(None).unwrap();
}

/// (e) The host never answers the identity lookup of scope A's recovery.
#[test]
fn a_hanging_host_lookup_never_delays_a_foreign_turn() {
    let _serial = serial();
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    retain(root, host(root), &[turn("agent", "run-retained")]);
    let engine = engine_on(hanging(root, patient(host(root))));
    compose(&engine, root, "e");
    wait_for(&root.join("hang-entered"), "e: the recovery never started");
    foreign_turn_is_stored(&engine, turn("other", "run-other"), "e/other agent");
    foreign_turn_is_stored(&engine, user_turn(root, "owner-b", "run-b"), "e/same agent");
    assert_eq!(admissions_with_content(root), 1);
    fs::remove_file(root.join("hang")).unwrap();
    engine.close(None).unwrap();
}

/// (f) U1 and U2 share an agent. U1's deferred record is busy elsewhere; U1 sends a turn and
/// U2 sends one right after it (I2).
#[test]
fn an_owners_retry_never_delays_another_owner_of_the_same_agent() {
    let _serial = serial();
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    retain(
        root,
        host(root),
        &[user_turn(root, "owner-a", "run-retained")],
    );
    // The first recovery fails transiently, so the record is deferred to its owner.
    fs::write(root.join("fail"), "").unwrap();
    let engine = engine_on(Arc::new(CrashHost {
        inner: patient(host(root)),
        root: root.to_path_buf(),
        phase: "toggle".into(),
    }));
    compose(&engine, root, "f");
    recovery_settled(&engine);
    fs::remove_file(root.join("fail")).unwrap();
    assert_eq!(admissions_with_content(root), 1);
    let held = hold_scopes(root);
    let own = engine
        .capture(user_turn(root, "owner-a", "run-own"), options())
        .unwrap();
    foreign_turn_is_stored(&engine, user_turn(root, "owner-b", "run-b"), "f");
    // Once the record is free, the owner's turn and its retained turn both complete.
    drop(held);
    assert_eq!(done(&own)["stored"], 2);
    recovery_settled(&engine);
    assert_eq!(admissions_with_content(root), 0);
    assert_eq!(rows(root, "agent").len(), 6);
    engine.close(None).unwrap();
}

/// The composition reads directories only: it returns with every holder in place and has
/// asked the host nothing by then.
#[test]
fn the_composition_asks_no_host_and_waits_for_no_holder() {
    let _serial = serial();
    let scratch = killed("neo-plan");
    let root = scratch.path().to_path_buf();
    let held = hold_scopes(&root);
    let workspace = neo_workspace(&root);
    let neo = crate::store::lock::Lock::try_acquire_neo(
        &workspace.join(".neo-write.lock"),
        Duration::from_secs(300),
    )
    .unwrap()
    .unwrap();
    let engine = engine_on(hanging(&root, neo_host(&root)));
    engine.capture.hold_recovery();
    compose(&engine, &root, "composition");
    assert!(!root.join("host-calls").exists());
    assert_eq!(
        capture_state(&engine),
        Some((
            "capture-recovery-deferred".into(),
            engine_capture::Served::Deferred
        ))
    );
    assert!(engine.status().ready);
    drop((held, neo));
    engine.capture.release_recovery();
    wait_for(&root.join("hang-entered"), "the worker never started");
    fs::remove_file(root.join("hang")).unwrap();
    engine.close(None).unwrap();
}

/// RE-D163 / I2: a recovery attempt asks the host nothing while it holds the Neo workspace
/// lease. The fixture host would never answer such a lookup; another owner of the same
/// workspace is stored and the plan is recovered.
#[test]
fn no_host_lookup_is_made_under_the_neo_workspace_lease() {
    let _serial = serial();
    let scratch = killed("neo-plan");
    let root = scratch.path().to_path_buf();
    remove_admissions(&root);
    fs::write(root.join("hang"), "").unwrap();
    let engine = engine_on(Arc::new(CrashHost {
        inner: patient(neo_host(&root)),
        root: root.clone(),
        phase: "hang-under-lease".into(),
    }));
    compose(&engine, &root, "under-lease");
    // Either the attempt hangs under the lease, or the pass finishes.
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while !root.join("hang-entered").exists()
        && !engine.capture.recovered_for_test(Duration::from_millis(50))
    {
        assert!(std::time::Instant::now() < deadline);
    }
    foreign_turn_is_stored(&engine, user_turn(&root, "owner-b", "run-b"), "under-lease");
    assert!(!root.join("hang-entered").exists());
    recovery_settled(&engine);
    assert_eq!(neo_plans_with_content(&root), 0);
    fs::remove_file(root.join("hang")).unwrap();
    engine.close(None).unwrap();
}

/// RE-D163 / R2: a live turn's Neo step waits for the workspace lease no longer than the
/// pin's Neo budget. Then the turn is stored and its Neo step deferred, never aborted.
#[test]
fn a_live_turn_waits_for_the_neo_lease_within_the_neo_budget_only() {
    let _serial = serial();
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let host = neo_host(root);
    let mut config = serde_json::to_value(host.config()).unwrap();
    config["neo"]["agentEndBudgetMs"] = json!(1000);
    config["runtime"] = json!({"captureTimeoutMs":8000});
    host.set_config(serde_json::from_value(config).unwrap());
    let engine = engine_on(host);
    assert_eq!(
        capture(&engine, user_turn(root, "owner-a", "run-a"))["stored"],
        2
    );
    let leases = crate::store::directory::TrustedDirectory::open(&neo_workspace(root))
        .unwrap()
        .create_child(".native-capture-leases")
        .unwrap();
    let held =
        crate::store::kernel_lease::acquire(&leases, "workspace", &Cancel::never(), &mut || {})
            .unwrap();
    let started = std::time::Instant::now();
    let result = capture(&engine, user_turn(root, "owner-b", "run-b"));
    assert_eq!(result["stored"], 2, "{result}");
    assert!(
        started.elapsed() < Duration::from_secs(6),
        "{:?}",
        started.elapsed()
    );
    // The Neo step is deferred: the admission stays for its owner's next recovery.
    assert_eq!(admissions_with_content(root), 1);
    drop(held);
    assert_eq!(
        capture(&engine, user_turn(root, "owner-b", "run-b2"))["stored"],
        2
    );
    assert_eq!(admissions_with_content(root), 0);
    engine.close(None).unwrap();
}
