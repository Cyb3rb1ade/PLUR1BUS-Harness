//! The TypeScript tests of `packages/core/test/approvals/` that are not surface (`chain`, `db`, `store`, `store-cancel`,
//! `signing`, `keys`, `integrity-job`), ported. The parity of the bytes is in [`super::vectors`]; these hold the behaviour.
#![allow(clippy::needless_pass_by_value)]
use super::chain::{ApprovalChain, VerifyFailure, VerifyResult, GENESIS_MAC};
use super::db::{self, DbError, MIGRATIONS, SCHEMA_VERSION};
use super::integrity::{IntegrityJob, Outcome, EVERY_MS};
use super::js_json::J;
use super::keys::{
    ChainKeySource, KeyError, SecretChainKey, SecretSigningKey, SecretSlot, SigningKeySource,
    StaticKeySource, CHAIN_KEY_SECRET_NAME, SIGNING_KEY_SECRET_NAME,
};
use super::signing::{verify_decision_signature, DecisionSigner, Ed25519Signer};
use super::store::{Binding, DecideInput, Denial, RequestInput, Status};
pub(crate) use super::vectors::SetClock;
use super::{ApprovalError, Clock, OsRandom};
use crate::grants::open::{OpenPermissionStores, PermissionStores, Signing};
use plur1bus_store::rusqlite::Connection;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use zeroize::Zeroizing;

pub(crate) const NOW: i64 = 1_791_288_000_000; // 2026-10-06T12:00:00Z
const MIN: i64 = 60_000;
const HOUR: i64 = 60 * MIN;
pub(crate) const KEY: [u8; 32] = [7; 32];
const OTHER_KEY: [u8; 32] = [9; 32];

pub(crate) struct Opened {
    pub(crate) _dir: tempfile::TempDir,
    pub(crate) path: PathBuf,
    pub(crate) stores: PermissionStores,
    pub(crate) clock: Arc<SetClock>,
}

pub(crate) fn open_at(
    path: &Path,
    key: &[u8],
    ttl: Option<i64>,
    signer: Option<Arc<dyn DecisionSigner>>,
    clock: Arc<SetClock>,
) -> PermissionStores {
    let mut stores = PermissionStores::open(OpenPermissionStores {
        path,
        db: Default::default(),
        keys: &StaticKeySource::new(key).unwrap(),
        clock,
        random: Arc::new(OsRandom),
        request_ttl_ms: ttl,
        max_grant_days: None,
        home: Some("/home/test-user".to_owned()),
        signing: signer.map_or(Signing::None, Signing::Signer),
    })
    .unwrap();
    // The tests name POSIX paths (`/work/proj`, `/home/test-user`). The path rules take the platform as an argument, so
    // they run as on Linux on every build; on Windows the build's own platform would refuse those paths as drive-relative
    // (as the TypeScript store does there).
    stores.grants.set_platform("linux");
    stores
}

pub(crate) fn opened(ttl: Option<i64>, signer: Option<Arc<dyn DecisionSigner>>) -> Opened {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state").join("approvals.sqlite");
    let clock = Arc::new(SetClock::at(NOW));
    let stores = open_at(&path, &KEY, ttl, signer, clock.clone());
    Opened {
        _dir: dir,
        path,
        stores,
        clock,
    }
}

/// A second, raw connection: what an attacker with write access to the file would use.
fn raw(path: &Path) -> Connection {
    Connection::open(path).unwrap()
}

pub(crate) fn binding() -> Binding {
    Binding {
        action_hash: "h1".into(),
        principal: "christian".into(),
        subject_kind: "agent".into(),
        subject_id: "bernd".into(),
        turn_id: "turn1".into(),
        task_id: "t1".into(),
        session_id: "s1".into(),
    }
}

fn req(cap: &str) -> RequestInput {
    RequestInput {
        bound: binding(),
        capability: cap.into(),
        detail: None,
    }
}

fn decide_in(id: &str, nonce: &str, approve: bool, person: &str, surface: u8) -> DecideInput {
    DecideInput {
        request_id: id.into(),
        nonce: nonce.into(),
        approve,
        person: person.into(),
        surface,
        delegable: false,
    }
}

fn reason<T>(r: Result<Result<T, Denial>, ApprovalError>) -> &'static str {
    match r.unwrap() {
        Ok(_) => "ok",
        Err(d) => d.as_str(),
    }
}

fn append(
    s: &mut PermissionStores,
    kind: &str,
    r: &str,
    payload: J,
    nonce: Option<&str>,
) -> Result<super::chain::ChainEntry, ApprovalError> {
    s.write(|tx, a, _| Ok::<_, ApprovalError>(a.chain.append(tx, kind, r, &payload, nonce)?))
}

fn seeded(n: usize) -> Opened {
    let mut o = opened(None, None);
    for i in 1..=n {
        append(
            &mut o.stores,
            "note",
            &format!("r{i}"),
            J::obj([("i", J::Num(i as f64))]),
            None,
        )
        .unwrap();
    }
    o
}

fn broken(o: &Opened) -> (f64, VerifyFailure) {
    match o.stores.verify().unwrap() {
        VerifyResult::Broken {
            broken_at, reason, ..
        } => (broken_at, reason),
        ok => panic!("expected a broken chain, got {ok:?}"),
    }
}

// ---- chain.test.ts ----

#[test]
fn an_empty_chain_verifies() {
    let o = opened(None, None);
    assert_eq!(
        o.stores.verify().unwrap().json(),
        serde_json::json!({ "ok": true, "entries": 0, "head": null, "signatures": { "unsignedLegacy": 0, "signedOk": 0, "signedBad": 0, "report": "unsigned (legacy)" } })
    );
}

#[test]
fn every_entry_carries_the_mac_of_its_predecessor() {
    let o = seeded(3);
    let snap = o.stores.chain().snapshot(o.stores.conn()).unwrap();
    let e = &snap.entries;
    assert_eq!(e[0].prev_mac, GENESIS_MAC);
    assert_eq!(e[1].prev_mac, e[0].mac);
    assert_eq!(e[2].prev_mac, e[1].mac);
    assert!(
        e[0].mac.len() == 64
            && e[0]
                .mac
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
    assert_eq!(
        o.stores.verify().unwrap(),
        VerifyResult::Ok {
            entries: 3,
            head: Some((3, e[2].mac.clone())),
            head_mac_blob: false,
            signatures: Default::default()
        }
        .with_unsigned(3)
    );
}

impl VerifyResult {
    fn with_unsigned(mut self, n: u64) -> Self {
        if let VerifyResult::Ok { signatures, .. } = &mut self {
            signatures.unsigned_legacy = n;
        }
        self
    }
}

#[test]
fn tampering_is_found_where_it_happened() {
    let cases: [(&str, f64, VerifyFailure); 5] = [
        ("UPDATE approval_chain SET payload = '{\"i\":99}' WHERE seq = 3", 3.0, VerifyFailure::MacMismatch),
        ("DELETE FROM approval_chain WHERE seq = 3", 3.0, VerifyFailure::SeqGap),
        ("DELETE FROM approval_chain WHERE seq >= 4", 4.0, VerifyFailure::Truncated),
        ("INSERT INTO approval_chain (seq, ts, kind, ref_id, nonce, payload, prev_mac, mac) SELECT 6, ts, kind, ref_id, nonce, payload, prev_mac, mac FROM approval_chain WHERE seq = 2", 6.0, VerifyFailure::PrevMismatch),
        ("UPDATE approval_chain SET seq = 100 WHERE seq = 2; UPDATE approval_chain SET seq = 2 WHERE seq = 3; UPDATE approval_chain SET seq = 3 WHERE seq = 100", 2.0, VerifyFailure::PrevMismatch),
    ];
    for (sql, at, why) in cases {
        let o = seeded(5);
        assert!(o.stores.verify().unwrap().ok());
        raw(&o.path).execute_batch(sql).unwrap();
        assert_eq!(
            broken(&o),
            (at, why),
            "{sql}: and another connection's change is seen after a clean verify"
        );
    }
}

#[test]
fn a_tail_cut_with_a_repointed_head_is_still_found() {
    let o = seeded(5);
    raw(&o.path)
        .execute_batch("DELETE FROM approval_chain WHERE seq >= 4; UPDATE chain_head SET seq = 3, mac = (SELECT mac FROM approval_chain WHERE seq = 3)")
        .unwrap();
    assert_eq!(broken(&o).1, VerifyFailure::HeadMismatch);
}

#[test]
fn another_key_breaks_the_chain_at_one_and_a_short_key_is_refused() {
    let o = seeded(5);
    let other = open_at(&o.path, &OTHER_KEY, None, None, o.clock.clone());
    assert!(
        matches!(other.verify().unwrap(), VerifyResult::Broken { broken_at, reason: VerifyFailure::MacMismatch, .. } if broken_at == 1.0)
    );
    assert_eq!(
        StaticKeySource::new(&[0; 8]).err(),
        Some(KeyError::TooShort)
    );
    assert!(ApprovalChain::new(&[0; 31], o.clock.clone(), None).is_err());
}

#[test]
fn append_refuses_a_broken_chain_and_runs_only_inside_a_write() {
    let mut o = seeded(5);
    raw(&o.path)
        .execute("UPDATE approval_chain SET payload = '{}' WHERE seq = 2", [])
        .unwrap();
    let e = append(&mut o.stores, "note", "r9", J::Obj(vec![]), None).unwrap_err();
    assert!(
        e.to_string().starts_with("approval chain is broken at 2"),
        "{e}"
    );
    let err = o
        .stores
        .chain()
        .append(o.stores.conn(), "note", "x", &J::Null, None)
        .unwrap_err();
    assert_eq!(err, super::chain::ChainError::NoTransaction);
}

// ---- db.test.ts ----

fn tables(c: &Connection) -> Vec<String> {
    let mut st = c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap();
    st.query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn version(c: &Connection) -> u32 {
    c.query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn an_empty_file_migrates_to_v4_under_state_owner_only() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        db::db_path(dir.path()),
        dir.path().join("state").join("approvals.sqlite")
    );
    let p = db::db_path(dir.path());
    let s = db::open(&p, &Default::default()).unwrap();
    assert_eq!((SCHEMA_VERSION, version(s.conn())), (4, 4));
    for t in [
        "grants",
        "approvals",
        "approval_chain",
        "approval_signatures",
        "chain_head",
    ] {
        assert!(tables(s.conn()).contains(&t.to_owned()), "{t}");
    }
    let sync: i64 = s
        .conn()
        .query_row("PRAGMA synchronous", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        sync, 2,
        "FULL: a decision that was reported must survive a crash"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&p).unwrap().permissions().mode() & 0o077,
            0
        );
        assert_eq!(
            std::fs::metadata(p.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o077,
            0
        );
    }
    drop(s);
    let again = db::open(&p, &Default::default()).unwrap();
    assert_eq!(version(again.conn()), 4, "opening again is idempotent");
}

#[test]
fn older_files_gain_their_columns_and_tables_and_keep_their_rows() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("approvals.sqlite");
    let a = db::open(&p, &Default::default()).unwrap();
    a.conn().execute_batch("INSERT INTO grants (id, person, agent, capability, match_kind, duration, created_by, created_at, surface, def_hash, chain_seq) VALUES ('g1','p','a','fs.read','capability','always','p',1,3,'h',1); INSERT INTO approval_chain (seq, ts, kind, ref_id, nonce, payload, prev_mac, mac) VALUES (1, 1, 'k', 'r', NULL, '{}', 'p', 'm'); ALTER TABLE grants DROP COLUMN origin; ALTER TABLE grants DROP COLUMN attested_via; DROP TABLE approval_signatures; PRAGMA user_version = 1").unwrap();
    drop(a);
    let b = db::open(&p, &Default::default()).unwrap();
    assert_eq!(version(b.conn()), 4);
    let row: (String, Option<String>, Option<String>) = b
        .conn()
        .query_row("SELECT id, attested_via, origin FROM grants", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert_eq!(row, ("g1".into(), None, None));
    let n: i64 = b
        .conn()
        .query_row("SELECT COUNT(*) FROM approval_chain", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
    assert!(tables(b.conn()).contains(&"approval_signatures".to_owned()));
}

#[test]
fn a_newer_schema_is_refused_and_the_file_is_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("approvals.sqlite");
    drop(db::open(&p, &Default::default()).unwrap());
    raw(&p).execute_batch("PRAGMA user_version = 7").unwrap();
    let before = std::fs::read(&p).unwrap();
    match db::open(&p, &Default::default()) {
        Err(DbError::NewerSchema(m)) => {
            assert!(m.contains("schema 7 is newer than this core's 4"), "{m}")
        }
        Err(e) => panic!("{e}"),
        Ok(_) => panic!("a newer file was opened"),
    }
    assert_eq!(version(&raw(&p)), 7);
    assert_eq!(std::fs::read(&p).unwrap(), before, "not a byte changed");
}

#[test]
fn the_constraints_refuse_an_invalid_duration_and_surface() {
    let o = opened(None, None);
    let ins = |d: &str, s: i64| {
        o.stores.conn().execute("INSERT INTO grants (id, person, agent, capability, match_kind, duration, created_by, created_at, surface, def_hash, chain_seq) VALUES ('g', 'p', 'a', 'fs.read', 'capability', ?, 'p', 1, ?, 'h', 1)", plur1bus_store::rusqlite::params![d, s])
    };
    assert!(ins("forever", 3).is_err());
    assert!(ins("always", 9).is_err());
    assert!(ins("always", 3).is_ok());
    assert_eq!(MIGRATIONS.len() as u32, SCHEMA_VERSION);
}

// ---- store.test.ts, store-cancel.test.ts ----

fn approved(delegable: bool) -> (Opened, String) {
    let mut o = opened(None, None);
    let r = o.stores.request(&req("fs.write")).unwrap();
    let mut d = decide_in(&r.id, &r.nonce, true, "christian", 3);
    d.delegable = delegable;
    assert_eq!(reason(o.stores.decide(&d)), "ok");
    (o, r.id)
}

#[test]
fn approve_then_consume_once_then_used() {
    let (mut o, id) = approved(false);
    assert_eq!(reason(o.stores.consume(&id, &binding())), "ok");
    assert_eq!(reason(o.stores.consume(&id, &binding())), "approval-used");
}

#[test]
fn another_binding_is_a_mismatch_and_the_approval_stays_usable() {
    let changes: [fn(&mut Binding); 7] = [
        |b| b.action_hash = "h2".into(),
        |b| b.principal = "mallory".into(),
        |b| b.subject_id = "other".into(),
        |b| b.subject_kind = "subagent".into(),
        |b| b.turn_id = "turn2".into(),
        |b| b.task_id = "t2".into(),
        |b| b.session_id = "s2".into(),
    ];
    for change in changes {
        let (mut o, id) = approved(false);
        let mut b = binding();
        change(&mut b);
        assert_eq!(
            reason(o.stores.consume(&id, &b)),
            "approval-mismatch",
            "{b:?}"
        );
        assert_eq!(reason(o.stores.consume(&id, &binding())), "ok");
    }
}

#[test]
fn unknown_pending_and_denied_are_mismatches() {
    let mut o = opened(None, None);
    assert_eq!(
        reason(o.stores.consume("apr_nope", &binding())),
        "approval-mismatch"
    );
    let pending = o.stores.request(&req("fs.write")).unwrap();
    assert_eq!(
        reason(o.stores.consume(&pending.id, &binding())),
        "approval-mismatch"
    );
    let denied = o.stores.request(&req("fs.write")).unwrap();
    assert_eq!(
        reason(
            o.stores
                .decide(&decide_in(&denied.id, &denied.nonce, false, "christian", 3))
        ),
        "ok"
    );
    assert_eq!(
        reason(o.stores.consume(&denied.id, &binding())),
        "approval-mismatch"
    );
}

#[test]
fn an_expired_request_cannot_be_decided_or_consumed() {
    let mut o = opened(Some(10 * MIN), None);
    let a = o.stores.request(&req("fs.write")).unwrap();
    o.clock.set(NOW + 10 * MIN);
    assert_eq!(
        reason(
            o.stores
                .decide(&decide_in(&a.id, &a.nonce, true, "christian", 3))
        ),
        "approval-expired"
    );
    let b = o.stores.request(&req("fs.write")).unwrap();
    assert_eq!(
        reason(
            o.stores
                .decide(&decide_in(&b.id, &b.nonce, true, "christian", 3))
        ),
        "ok"
    );
    o.clock.set(NOW + 20 * MIN);
    assert_eq!(
        reason(o.stores.consume(&b.id, &binding())),
        "approval-expired"
    );
    assert_eq!(
        o.stores.approval(&a.id).unwrap().unwrap().status,
        Status::Expired
    );
}

#[test]
fn the_default_lifetime_is_a_day_and_ids_and_nonces_have_their_shape() {
    let mut o = opened(None, None);
    let a = o.stores.request(&req("fs.write")).unwrap();
    assert_eq!(a.expires_at - NOW, 24 * HOUR);
    assert!(a.id.starts_with("apr_") && a.id.len() == 28 && a.nonce.len() == 32);
}

#[test]
fn the_nonce_is_single_use_and_only_the_principal_decides() {
    let mut o = opened(None, None);
    let r = o.stores.request(&req("fs.write")).unwrap();
    assert_eq!(
        reason(
            o.stores
                .decide(&decide_in(&r.id, &"0".repeat(32), true, "christian", 3))
        ),
        "approval-mismatch"
    );
    assert_eq!(
        reason(
            o.stores
                .decide(&decide_in(&r.id, &r.nonce, true, "mallory", 3))
        ),
        "approval-mismatch"
    );
    for surface in [0, 4] {
        assert_eq!(
            reason(
                o.stores
                    .decide(&decide_in(&r.id, &r.nonce, true, "christian", surface))
            ),
            "surface-untrusted"
        );
    }
    assert_eq!(
        reason(
            o.stores
                .decide(&decide_in(&r.id, &r.nonce, true, "christian", 3))
        ),
        "ok"
    );
    assert_eq!(
        reason(
            o.stores
                .decide(&decide_in(&r.id, &r.nonce, true, "christian", 3))
        ),
        "approval-used"
    );
}

#[test]
fn state_survives_reopening_and_two_stores_on_one_file_consume_once() {
    let (mut o, id) = approved(true);
    let rec = o.stores.approval(&id).unwrap().unwrap();
    assert_eq!(
        (
            rec.status,
            rec.decided_by.as_deref(),
            rec.decision_surface,
            rec.delegable
        ),
        (Status::Approved, Some("christian"), Some(J::Num(3.0)), true)
    );
    let mut other = open_at(&o.path, &KEY, None, None, o.clock.clone());
    let mut results = vec![
        reason(o.stores.consume(&id, &binding())),
        reason(other.consume(&id, &binding())),
    ];
    results.sort_unstable();
    assert_eq!(results, ["approval-used", "ok"]);
    drop(other);
    let again = open_at(&o.path, &KEY, None, None, o.clock.clone());
    assert_eq!(again.approval(&id).unwrap().unwrap().status, Status::Used);
}

#[test]
fn a_tampered_decision_fails_closed_and_the_projection_decides_nothing() {
    let (mut o, id) = approved(false);
    raw(&o.path).execute("UPDATE approval_chain SET payload = replace(payload, 'approve', 'denied') WHERE kind = 'approval.decided'", []).unwrap();
    assert_eq!(broken(&o), (2.0, VerifyFailure::MacMismatch));
    assert!(matches!(
        o.stores.consume(&id, &binding()),
        Err(ApprovalError::Integrity { .. })
    ));

    let mut p = opened(None, None);
    let d = p.stores.request(&req("fs.write")).unwrap();
    assert_eq!(
        reason(
            p.stores
                .decide(&decide_in(&d.id, &d.nonce, false, "christian", 3))
        ),
        "ok"
    );
    raw(&p.path)
        .execute("UPDATE approvals SET status = 'approved'", [])
        .unwrap();
    assert_eq!(
        reason(p.stores.consume(&d.id, &binding())),
        "approval-mismatch"
    );
}

#[test]
fn deleting_the_use_to_replay_it_is_caught() {
    let (mut o, id) = approved(false);
    assert_eq!(reason(o.stores.consume(&id, &binding())), "ok");
    raw(&o.path).execute_batch("DELETE FROM approval_chain WHERE kind = 'approval.used'; UPDATE approvals SET status = 'approved'").unwrap();
    assert_eq!(broken(&o), (3.0, VerifyFailure::Truncated));
    assert!(matches!(
        o.stores.consume(&id, &binding()),
        Err(ApprovalError::Integrity { .. })
    ));
}

fn bound_j(change: impl FnOnce(&mut Binding)) -> J {
    let mut b = binding();
    change(&mut b);
    b.j()
}

#[test]
fn a_key_holders_replayed_nonce_or_rebound_use_is_caught() {
    let (mut o, id) = approved(false);
    let nonce: String = o
        .stores
        .conn()
        .query_row("SELECT nonce FROM approvals WHERE id = ?", [&id], |r| {
            r.get(0)
        })
        .unwrap();
    let other = o.stores.request(&req("fs.write")).unwrap();
    let decided = J::obj([
        ("decision", J::s("approve")),
        ("person", J::s("christian")),
        ("surface", J::Num(3.0)),
        ("delegable", J::Bool(false)),
        ("bound", bound_j(|_| {})),
    ]);
    let forged = append(
        &mut o.stores,
        "approval.decided",
        &other.id,
        decided,
        Some(&nonce),
    )
    .unwrap();
    assert_eq!(broken(&o), (forged.seq, VerifyFailure::NonceReuse));

    let (mut p, id) = approved(false);
    let e = append(
        &mut p.stores,
        "approval.used",
        &id,
        J::obj([("bound", bound_j(|b| b.action_hash = "evil".into()))]),
        None,
    )
    .unwrap();
    assert_eq!(broken(&p), (e.seq, VerifyFailure::BindingMismatch));

    let (mut q, id) = approved(false);
    assert_eq!(reason(q.stores.consume(&id, &binding())), "ok");
    assert!(
        append(
            &mut q.stores,
            "approval.used",
            &id,
            J::obj([("bound", bound_j(|_| {}))]),
            None
        )
        .is_err(),
        "a second use cannot be written at all"
    );
}

#[test]
fn the_detail_is_kept_in_the_chain_and_is_part_of_the_mac() {
    let mut o = opened(None, None);
    let detail = J::obj([
        ("tool", J::s("fs.read")),
        ("risk", J::s("low")),
        ("flags", J::obj([("outsideRoots", J::Bool(true))])),
    ]);
    let r = o
        .stores
        .request(&RequestInput {
            detail: Some(detail.clone()),
            ..req("fs.read")
        })
        .unwrap();
    assert_eq!(
        o.stores.approval(&r.id).unwrap().unwrap().detail,
        Some(detail.clone())
    );
    assert_eq!(
        o.stores.approvals(None, None).unwrap()[0].detail,
        Some(detail)
    );
    let none = o.stores.request(&req("fs.read")).unwrap();
    assert_eq!(o.stores.approval(&none.id).unwrap().unwrap().detail, None);
    let big = J::obj([("x", J::s(&"a".repeat(16 * 1024)))]);
    assert!(matches!(
        o.stores.request(&RequestInput {
            detail: Some(big),
            ..req("fs.read")
        }),
        Err(ApprovalError::Invalid(_))
    ));
    raw(&o.path).execute("UPDATE approval_chain SET payload = replace(payload, 'low', 'critical') WHERE ref_id = ?", [&r.id]).unwrap();
    assert!(!o.stores.verify().unwrap().ok());
}

#[test]
fn cancel_closes_a_pending_request_for_good() {
    let mut o = opened(Some(1000), None);
    let a = o.stores.request(&req("fs.write")).unwrap();
    assert_eq!(reason(o.stores.cancel(&a.id, "christian")), "ok");
    assert_eq!(
        o.stores.approval(&a.id).unwrap().unwrap().status,
        Status::Cancelled
    );
    assert!(o.stores.verify().unwrap().ok());
    assert_eq!(
        reason(
            o.stores
                .decide(&decide_in(&a.id, &a.nonce, true, "christian", 3))
        ),
        "approval-expired"
    );
    assert_eq!(
        reason(o.stores.consume(&a.id, &binding())),
        "approval-mismatch"
    );
    assert_eq!(reason(o.stores.cancel(&a.id, "christian")), "approval-used");
    assert_eq!(
        reason(o.stores.cancel("apr_nope", "christian")),
        "approval-mismatch"
    );
    let b = o.stores.request(&req("fs.write")).unwrap();
    assert_eq!(
        reason(
            o.stores
                .decide(&decide_in(&b.id, &b.nonce, true, "christian", 3))
        ),
        "ok"
    );
    assert_eq!(reason(o.stores.cancel(&b.id, "christian")), "approval-used");
    let c = o.stores.request(&req("fs.write")).unwrap();
    o.clock.set(NOW + 1000);
    assert_eq!(
        reason(o.stores.cancel(&c.id, "christian")),
        "approval-expired"
    );
    assert_eq!(
        o.stores.approval(&c.id).unwrap().unwrap().status,
        Status::Expired
    );
    let late = append(
        &mut o.stores,
        "approval.cancelled",
        &b.id,
        J::obj([("by", J::s("x")), ("bound", bound_j(|_| {}))]),
        None,
    )
    .unwrap();
    assert_eq!(broken(&o), (late.seq, VerifyFailure::BindingMismatch));
}

#[test]
fn the_key_stays_off_the_disk() {
    let (mut o, _) = approved(false);
    let r = o.stores.request(&req("fs.write")).unwrap();
    assert_eq!(
        reason(
            o.stores
                .decide(&decide_in(&r.id, &r.nonce, true, "christian", 3))
        ),
        "ok"
    );
    o.stores
        .conn()
        .execute_batch("PRAGMA wal_checkpoint(FULL)")
        .unwrap();
    let hex = super::node_codec::hex_encode(&KEY);
    for f in [
        o.path.clone(),
        PathBuf::from(format!("{}-wal", o.path.display())),
    ] {
        let Ok(bytes) = std::fs::read(&f) else {
            continue;
        };
        assert!(!bytes.windows(32).any(|w| w == KEY), "{f:?}");
        assert!(
            !bytes.windows(hex.len()).any(|w| w == hex.as_bytes()),
            "{f:?}"
        );
    }
    assert!(!format!("{:?}", o.stores).contains(&hex));
}

// ---- signing.test.ts, keys.test.ts ----

#[derive(Default)]
struct MemorySlot(RefCell<HashMap<String, String>>);

impl SecretSlot for MemorySlot {
    fn read(&self, name: &str) -> Result<Option<Zeroizing<String>>, KeyError> {
        Ok(self.0.borrow().get(name).map(|v| Zeroizing::new(v.clone())))
    }
    fn create(&self, name: &str, value: &str) -> Result<(), KeyError> {
        self.0
            .borrow_mut()
            .insert(name.to_owned(), value.to_owned());
        Ok(())
    }
}

fn fresh_signer() -> Arc<dyn DecisionSigner> {
    let slot = MemorySlot::default();
    Arc::new(
        Ed25519Signer::load(&SecretSigningKey {
            slot: &slot,
            name: SIGNING_KEY_SECRET_NAME,
        })
        .unwrap(),
    )
}

#[test]
fn signed_decisions_verify_and_a_changed_signature_breaks_the_chain() {
    let signer = fresh_signer();
    let mut o = opened(None, Some(signer));
    let r = o.stores.request(&req("fs.read")).unwrap();
    assert_eq!(
        reason(
            o.stores
                .decide(&decide_in(&r.id, &r.nonce, true, "christian", 2))
        ),
        "ok"
    );
    let VerifyResult::Ok { signatures, .. } = o.stores.verify().unwrap() else {
        panic!()
    };
    assert_eq!(
        (
            signatures.signed_ok,
            signatures.unsigned_legacy,
            signatures.report()
        ),
        (1, 1, "signed-ok")
    );
    raw(&o.path)
        .execute(
            "UPDATE approval_signatures SET signature = ? WHERE seq = 2",
            [&"A".repeat(86).to_string()],
        )
        .unwrap();
    let VerifyResult::Broken {
        reason, signatures, ..
    } = o.stores.verify().unwrap()
    else {
        panic!()
    };
    assert_eq!(
        (reason, signatures.signed_bad, signatures.report()),
        (VerifyFailure::SignatureMismatch, 1, "signed-bad")
    );
}

#[test]
fn a_new_signer_invalidates_the_cached_view() {
    let a = fresh_signer();
    let b = fresh_signer();
    assert_ne!(a.public_key(), b.public_key());
    let mut o = opened(None, Some(a));
    let r = o.stores.request(&req("fs.read")).unwrap();
    assert_eq!(
        reason(
            o.stores
                .decide(&decide_in(&r.id, &r.nonce, true, "christian", 2))
        ),
        "ok"
    );
    assert!(o.stores.verify().unwrap().ok());
    o.stores.approvals.chain.set_signer(Some(b));
    assert!(matches!(
        o.stores.verify().unwrap(),
        VerifyResult::Broken {
            reason: VerifyFailure::SignatureMismatch,
            ..
        }
    ));
    o.stores.approvals.chain.set_signer(None);
    assert!(
        o.stores.verify().unwrap().ok(),
        "without a pinned key any valid signature counts (as in TypeScript)"
    );
}

#[test]
fn key_sources_create_once_reuse_and_never_replace_a_corrupt_value() {
    let slot = MemorySlot::default();
    let a = SecretSigningKey {
        slot: &slot,
        name: SIGNING_KEY_SECRET_NAME,
    };
    let sa = Ed25519Signer::load(&a).unwrap();
    let sb = Ed25519Signer::load(&a).unwrap();
    assert_eq!(sa.public_key(), sb.public_key());
    let mac = "a".repeat(64);
    let sig = sa.sign(&mac);
    assert!(verify_decision_signature(
        &mac,
        &sig.public_key,
        &sig.signature
    ));
    assert_eq!(
        base64_len(&slot, SIGNING_KEY_SECRET_NAME),
        48,
        "PKCS #8 v1, as Node exports it"
    );

    let corrupt = MemorySlot::default();
    corrupt
        .create(SIGNING_KEY_SECRET_NAME, "AAAAAAAAAAA=")
        .unwrap();
    assert!(matches!(
        Ed25519Signer::load(&SecretSigningKey {
            slot: &corrupt,
            name: SIGNING_KEY_SECRET_NAME
        }),
        Err(KeyError::Corrupt(_))
    ));
    assert_eq!(
        corrupt.0.borrow()[SIGNING_KEY_SECRET_NAME],
        "AAAAAAAAAAA=",
        "never replaced"
    );
    let garbage = MemorySlot::default();
    garbage
        .create(SIGNING_KEY_SECRET_NAME, &"QUJD".repeat(8))
        .unwrap();
    assert!(matches!(
        Ed25519Signer::load(&SecretSigningKey {
            slot: &garbage,
            name: SIGNING_KEY_SECRET_NAME
        }),
        Err(KeyError::Corrupt(_))
    ));

    let chain_slot = MemorySlot::default();
    let source = SecretChainKey {
        slot: &chain_slot,
        name: CHAIN_KEY_SECRET_NAME,
    };
    let k1 = source.load().unwrap();
    assert_eq!(
        (k1.len(), source.load().unwrap().as_slice() == k1.as_slice()),
        (32, true)
    );
    let short = MemorySlot::default();
    short.create(CHAIN_KEY_SECRET_NAME, "AAAA").unwrap();
    let err = SecretChainKey {
        slot: &short,
        name: CHAIN_KEY_SECRET_NAME,
    }
    .load()
    .unwrap_err();
    assert_eq!(
        err.to_string(),
        "secret approvals.chain-key.v1 is corrupt: not a 32-byte key"
    );
    assert_eq!(short.0.borrow()[CHAIN_KEY_SECRET_NAME], "AAAA");
    let _: &dyn SigningKeySource = &a;
}

fn base64_len(slot: &MemorySlot, name: &str) -> usize {
    super::node_codec::base64_decode(&slot.0.borrow()[name]).len()
}

// ---- integrity-job.test.ts ----

#[test]
fn the_integrity_job_completes_fails_skips_and_schedules() {
    let spec = super::integrity::spec();
    assert_eq!(
        (
            spec["name"].as_str(),
            spec["singleton"].as_bool(),
            spec["schedule"]["every"].as_i64()
        ),
        (Some("approvals.integrity"), Some(true), Some(86_400_000))
    );
    let o = seeded(1);
    let clock: Arc<dyn Clock> = o.clock.clone();
    let ok_runs = Cell::new(0);
    let mut job = IntegrityJob::new(
        Box::new(|| o.stores.verify()),
        clock.clone(),
        Box::new(|| 0.5),
        false,
    )
    .with_on_ok(Box::new(|| ok_runs.set(ok_runs.get() + 1)));
    assert_eq!(job.next_run_at(), NOW as f64);
    let Outcome::Completed(v) = job.run(false).unwrap() else {
        panic!()
    };
    assert!(v.ok());
    assert_eq!(ok_runs.get(), 1);
    assert_eq!(job.next_run_at(), NOW as f64 + EVERY_MS);
    assert_eq!(job.run(true).unwrap(), Outcome::Abandoned);
    drop(job);
    for (r, factor) in [(0.0, 0.9), (1.0, 1.1)] {
        let mut j = IntegrityJob::new(
            Box::new(|| o.stores.verify()),
            clock.clone(),
            Box::new(move || r),
            false,
        );
        j.run(false).unwrap();
        assert!((j.next_run_at() - (NOW as f64 + EVERY_MS * factor)).abs() < 1e-6);
    }
    let mut deferred = IntegrityJob::new(
        Box::new(|| o.stores.verify()),
        clock.clone(),
        Box::new(|| 0.5),
        true,
    );
    assert_eq!(deferred.next_run_at(), NOW as f64 + EVERY_MS);
    let mut absent = IntegrityJob::new(
        Box::new(|| o.stores.verify()),
        clock.clone(),
        Box::new(|| 0.5),
        false,
    )
    .with_present(Box::new(|| false));
    assert_eq!(absent.run(false).unwrap(), Outcome::Skipped);
    assert_eq!(
        IntegrityJob::validate_args(Some(&serde_json::json!([]))),
        Err("args must be an object")
    );
    assert_eq!(
        IntegrityJob::validate_args(Some(&serde_json::json!({ "x": 1 }))),
        Err("approvals.integrity takes no args")
    );
    assert_eq!(IntegrityJob::validate_args(None), Ok(()));

    let signer = fresh_signer();
    let mut s = opened(None, Some(signer));
    let r = s.stores.request(&req("fs.read")).unwrap();
    assert_eq!(
        reason(
            s.stores
                .decide(&decide_in(&r.id, &r.nonce, true, "christian", 2))
        ),
        "ok"
    );
    raw(&s.path)
        .execute(
            "UPDATE approval_signatures SET signature = ? WHERE seq = 2",
            [&"A".repeat(86).to_string()],
        )
        .unwrap();
    let mut failing = IntegrityJob::new(
        Box::new(|| s.stores.verify()),
        clock,
        Box::new(|| 0.5),
        false,
    );
    let out = failing.run(false).unwrap();
    assert_eq!(out.json()["reason"], "signature-mismatch");
    assert_eq!(out.json()["outcome"], "failed");
}
