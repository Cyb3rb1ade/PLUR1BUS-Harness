//! Parity mode B for the budget package (P4-K K1): TypeScript writes the store files, Rust reads, migrates and writes them,
//! TypeScript reads them again (`tests/core-parity/budget-b-driver.ts`, on the P4-02 helper). Needs Node (`PLUR1BUS_NODE` or
//! `node` on PATH) with the workspace's TypeScript sources, like the other mixed-language tests.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_core::budget::calls::{
    ActualCallUsage, CallBudget, CallBudgetOptions, CallDecision, CallRequest,
};
use plur1bus_core::budget::licences::{LicenceLedger, LicenceSource};
use plur1bus_core::budget::peer::PeerCallBudget;
use plur1bus_core::budget::period::{LocalDate, Zones};
use plur1bus_core::budget::service::{BudgetService, BudgetServiceOptions, UsageEvent};
use plur1bus_core::budget::{Clock, UuidIds};
use plur1bus_core::rbac::audit::{AuditEvent, AuditSink};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn driver(command: &str, dir: &Path) -> String {
    let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
    let output = Command::new(&node)
        .current_dir(root())
        .args([
            "--experimental-strip-types",
            "--conditions=source",
            "--no-warnings=ExperimentalWarning",
            "tests/core-parity/budget-b-driver.ts",
            command,
        ])
        .arg(dir)
        .output()
        .unwrap_or_else(|e| {
            panic!("could not run Node {node:?}: {e}. Install Node and run `pnpm test:prep`.")
        });
    assert!(
        output.status.success(),
        "budget-b-driver {command}: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

struct Utc;

impl Zones for Utc {
    fn is_valid(&self, zone: &str) -> bool {
        zone == "UTC"
    }
    fn local_date(&self, ts_ms: i64, zone: &str) -> Option<LocalDate> {
        if zone != "UTC" {
            return None;
        }
        // Civil date of a day count (Hinnant), as the product's own helper does.
        let z = ts_ms.div_euclid(86_400_000) + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        Some(LocalDate {
            y: (yoe + era * 400 + i64::from(m <= 2)) as i32,
            m: m as u32,
            d: d as u32,
        })
    }
}

struct At(i64);

impl Clock for At {
    fn now(&self) -> i64 {
        self.0
    }
}

struct Quiet;

impl AuditSink for Quiet {
    fn append(&mut self, _: &AuditEvent) -> Result<(), String> {
        Ok(())
    }
}

fn service(path: &Path, now: i64) -> BudgetService {
    BudgetService::open(BudgetServiceOptions {
        path,
        clock: Arc::new(At(now)),
        zones: Arc::new(Utc),
        events: None,
        secure_path: None,
        default_time_zone: None,
        busy_timeout_ms: None,
    })
    .unwrap()
}

fn gate(path: &Path, now: i64) -> CallBudget {
    CallBudget::open(CallBudgetOptions {
        path,
        clock: Arc::new(At(now)),
        zones: Arc::new(Utc),
        ids: Arc::new(UuidIds),
        emitter: None,
        default_time_zone: None,
        secure_path: None,
        busy_timeout_ms: None,
        reservation_ttl_ms: None,
    })
    .unwrap()
}

fn peer(path: &Path, now: i64) -> PeerCallBudget {
    PeerCallBudget::open(path, Arc::new(At(now)), Arc::new(UuidIds)).unwrap()
}

fn copy(dir: &Path, from: &str, to: &str) -> PathBuf {
    std::fs::copy(dir.join(from), dir.join(to)).unwrap();
    dir.join(to)
}

fn usage<'a>(agent: &'a str, input: i64, request_id: &'a str) -> UsageEvent<'a> {
    UsageEvent {
        agent,
        model: "m",
        input_tokens: input,
        request_id: Some(request_id),
        ..Default::default()
    }
}

#[test]
fn typescript_budget_files_round_trip_through_the_rust_port() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    driver("prepare", dir);
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    let now = manifest["now"].as_i64().unwrap();
    assert_eq!(manifest["version"], 2);

    // A version 1 file: Rust migrates it in one step, keeps the row, and writes beside it.
    let migrated = copy(dir, "budget-v1.sqlite", "budget-migrated-rust.sqlite");
    {
        let svc = service(&migrated, now);
        assert_eq!(
            svc.status(None).unwrap().periods[0].total.events,
            1,
            "the TypeScript row survived the migration"
        );
        assert!(
            svc.record_usage(&usage("rust-agent", 5, "rs-m"))
                .unwrap()
                .recorded
        );
    }

    // A version 2 file written by the product code, with the lazily created call and peer tables and one pending
    // reservation of each: Rust sees them and the limits they set, and settles and reserves beside them.
    let written = copy(dir, "budget-v2.sqlite", "budget-v2-rust.sqlite");
    let ts_reservation = manifest["reservationId"].as_str().unwrap().to_owned();
    let rust_reservation = {
        let svc = service(&written, now);
        let s = svc.status(None).unwrap();
        assert_eq!(
            (s.periods[0].total.events, s.periods[0].total.input_tokens),
            (1, 1000)
        );
        assert_eq!(svc.limits().unwrap().len(), 1);
        assert!(
            svc.record_usage(&usage("rust-agent", 300, "rs-1"))
                .unwrap()
                .recorded
        );
        assert!(
            !svc.record_usage(&usage("ts-agent", 1, "ts-1"))
                .unwrap()
                .recorded,
            "the TypeScript request id is honoured"
        );
        drop(svc);
        let g = gate(&written, now);
        let req = |n| CallRequest {
            principal: "u1",
            agent: "a1",
            project: "p1",
            model: "m",
            estimated_input_tokens: n,
            ..Default::default()
        };
        let CallDecision::Refuse(r) = g.check_before_call(&req(60)).unwrap() else {
            panic!("the TypeScript reservation holds 50 of 100")
        };
        assert_eq!((r.used, r.limit), (50, 100));
        let settled = g
            .settle(
                &ts_reservation,
                &ActualCallUsage {
                    input_tokens: 20,
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(settled.recorded);
        let CallDecision::Allow(a) = g.check_before_call(&req(60)).unwrap() else {
            panic!("20 settled + 60 fits")
        };
        let p = peer(&written, now);
        let limits = plur1bus_core::budget::peer::PeerBudgetLimits {
            peer_calls: 2,
            turn_calls: 3,
            peer_tokens: 100,
            turn_tokens: 150,
        };
        let id = plur1bus_core::budget::peer::PeerBudgetIdentity {
            person: "person",
            agent: "main",
            session: "session",
            turn: "turn",
            peer: "peer",
        };
        assert!(
            matches!(
                p.reserve(&id, 50, &limits).unwrap(),
                plur1bus_core::budget::peer::PeerBudgetDecision::Refuse
            ),
            "60 + 50 over 100"
        );
        assert!(matches!(
            p.reserve(&id, 40, &limits).unwrap(),
            plur1bus_core::budget::peer::PeerBudgetDecision::Allow(_)
        ));
        a.reservation_id
    };
    std::fs::write(
        dir.join("rust-results.json"),
        json!({ "reservationId": rust_reservation }).to_string(),
    )
    .unwrap();

    // Files Rust creates itself must have the schema text the TypeScript code creates.
    let fresh = dir.join("budget-fresh-rust.sqlite");
    drop(service(&fresh, now));
    drop(gate(&fresh, now));
    drop(peer(&fresh, now));
    drop(
        LicenceLedger::open(
            &dir.join("licences-fresh-rust.sqlite"),
            Box::new(Quiet),
            Arc::new(At(1)),
        )
        .unwrap(),
    );

    // The licence ledger: Rust reads the TypeScript acceptance exactly and adds one.
    let licences = copy(dir, "licences.sqlite", "licences-rust.sqlite");
    {
        let mut l = LicenceLedger::open(&licences, Box::new(Quiet), Arc::new(At(99_999))).unwrap();
        let list = l.list().unwrap();
        assert_eq!(list.len(), 1);
        let want = &manifest["acceptance"];
        assert_eq!(
            [
                &list[0].who,
                &list[0].at,
                &list[0].licence,
                &list[0].model,
                &list[0].revision,
                &list[0].source
            ]
            .map(String::as_str),
            ["who", "at", "licence", "model", "revision", "source"]
                .map(|k| want[k].as_str().unwrap())
        );
        l.confirm(
            "owner2",
            "jinaai/jina-embeddings-v3",
            "CC BY-NC-4.0",
            want["revision"].as_str().unwrap(),
            LicenceSource::Memory,
        )
        .unwrap();
    }

    let out: Value = serde_json::from_str(&driver("verify", dir)).unwrap();
    assert_eq!(out["migrated"]["userVersion"], 2, "{out}");
    assert_eq!(
        out["migrated"]["sameSchema"], true,
        "a v1 file migrated by Rust has the schema TypeScript's v2 has: {out}"
    );
    assert_eq!(out["migrated"]["check"]["integrity"], "ok");
    assert_eq!(
        out["fresh"]["sameSchema"], true,
        "a file Rust creates has the schema TypeScript creates: {out}"
    );
    assert_eq!(out["fresh"]["userVersion"], 2);
    assert_eq!(out["licencesFresh"]["sameSchema"], true, "{out}");
    assert_eq!(
        out["service"]["events"], 3,
        "ts-1, rs-1 and the settled call: {out}"
    );
    assert_eq!(out["service"]["inputTokens"], 1320, "{out}");
    assert_eq!(
        out["service"]["limits"],
        json!([["global", "day", "tokens", 100_000]])
    );
    assert_eq!(
        (
            out["service"]["migratedEvents"].as_i64(),
            out["service"]["migratedInput"].as_i64()
        ),
        (Some(2), Some(45)),
        "{out}"
    );
    assert_eq!(
        out["calls"]["tsReservation"],
        json!({"state": "settled", "tokens": 20}),
        "{out}"
    );
    assert_eq!(
        out["calls"]["rustReservation"],
        json!({"state": "reserved", "tokens": 60}),
        "{out}"
    );
    assert_eq!(
        (&out["calls"]["over"], &out["calls"]["exact"]),
        (&json!("refuse"), &json!("allow")),
        "{out}"
    );
    assert_eq!(
        out["peer"],
        json!(["refuse"]),
        "TypeScript sees both reservations: {out}"
    );
    assert_eq!(out["licences"].as_array().unwrap().len(), 2);
    assert_eq!(out["licences"][0], manifest["acceptance"]);
}
