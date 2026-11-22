//! The TypeScript tests of `packages/core/test/attestation/` that are about the library (`service-hardening`, `pin`,
//! `resolve`), ported against doubles of the helper host and the file probe. The process behaviour those tests also
//! check (a hung helper killed at the deadline, a binary swapped on disk) is the production host's, not this module's.
use super::helper::{
    helper_from_env, helper_pinned, run_helper, FileProbe, FileStat, HelperHost, HelperOutcome,
    HelperPin, HelperSpec,
};
use super::service::{AttestAudit, AttestFailure, AttestInput, AttestResult, AttestationService};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

struct Host {
    verdicts: RefCell<Vec<Result<String, &'static str>>>,
    outcome: HelperOutcome,
    runs: Cell<usize>,
    request: RefCell<Option<Value>>,
}

impl Host {
    fn new(verdicts: Vec<Result<String, &'static str>>, outcome: HelperOutcome) -> Host {
        Host {
            verdicts: RefCell::new(verdicts),
            outcome,
            runs: Cell::new(0),
            request: RefCell::new(None),
        }
    }
}

impl HelperHost for Host {
    fn verify(&self, _spec: &HelperSpec) -> Result<String, &'static str> {
        let mut v = self.verdicts.borrow_mut();
        if v.len() > 1 {
            v.remove(0)
        } else {
            v[0].clone()
        }
    }
    fn run(
        &self,
        _spec: &HelperSpec,
        _mode: &str,
        request: Option<&Value>,
        _deadline: f64,
    ) -> HelperOutcome {
        self.runs.set(self.runs.get() + 1);
        *self.request.borrow_mut() = request.cloned();
        self.outcome.clone()
    }
}

fn spec(pinned: bool) -> HelperSpec {
    HelperSpec {
        path: "/opt/p/plur1bus-attest".into(),
        pin: pinned.then(|| HelperPin {
            sha256: Some("ab".repeat(32)),
            ..HelperPin::default()
        }),
        ..HelperSpec::default()
    }
}

fn reply(v: &Value) -> HelperOutcome {
    HelperOutcome::Reply(v.as_object().unwrap().clone())
}

#[test]
fn run_helper_refuses_an_unpinned_or_changed_binary() {
    let ok = reply(&json!({ "v": 1 }));
    assert_eq!(
        run_helper(
            &Host::new(vec![Err("helper-not-pinned")], ok.clone()),
            &spec(true),
            "--attest",
            None,
            1.0
        ),
        HelperOutcome::Missing
    );
    let bad = Host::new(vec![Err("helper-hash-mismatch")], ok.clone());
    assert_eq!(
        run_helper(&bad, &spec(true), "--attest", None, 1.0),
        HelperOutcome::Refused("helper-hash-mismatch")
    );
    assert_eq!(bad.runs.get(), 0, "a refused binary never runs");
    let swapped = Host::new(vec![Ok("a".into()), Ok("b".into())], ok.clone());
    assert_eq!(
        run_helper(&swapped, &spec(true), "--attest", None, 1.0),
        HelperOutcome::Refused("helper-changed-during-run")
    );
    let same = Host::new(vec![Ok("a".into()), Ok("a".into())], ok.clone());
    assert_eq!(run_helper(&same, &spec(true), "--attest", None, 1.0), ok);
    // Without a pin there is no fingerprint to compare, so the answer stands.
    let unpinned = Host::new(
        vec![Ok(String::new()), Err("helper-hash-mismatch")],
        ok.clone(),
    );
    assert_eq!(
        run_helper(&unpinned, &spec(false), "--attest", None, 1.0),
        ok
    );
}

#[derive(Default)]
struct Audit {
    lines: Vec<(String, Value)>,
    fail_requested: bool,
}

impl AttestAudit for Audit {
    fn record(&mut self, action: &str, fields: &Value) -> Result<(), String> {
        if self.fail_requested && action == "attestation.requested" {
            return Err("disk full".into());
        }
        self.lines.push((action.to_owned(), fields.clone()));
        Ok(())
    }
}

fn input() -> AttestInput {
    AttestInput {
        action_hash: "ab".repeat(32),
        text: "Allow it".into(),
        ..AttestInput::default()
    }
}

fn attest(
    host: &Host,
    audit: &mut Audit,
    ttl: Option<f64>,
    input_ttl: Option<f64>,
) -> AttestResult {
    let clock = || 1_000_000.0;
    let mut nonce = || "n1".to_owned();
    let mut svc = AttestationService::new(
        Some(spec(false)),
        host,
        Some(audit),
        &clock,
        &mut nonce,
        ttl,
    );
    svc.attest(&AttestInput {
        ttl_ms: input_ttl,
        ..input()
    })
}

#[test]
fn an_attempt_is_never_made_unrecorded() {
    let host = Host::new(
        vec![Ok(String::new())],
        reply(&json!({ "v": 1, "ok": true })),
    );
    let mut audit = Audit {
        fail_requested: true,
        ..Audit::default()
    };
    assert_eq!(
        attest(&host, &mut audit, None, None),
        AttestResult::Failed(AttestFailure::Failed)
    );
    assert_eq!(host.runs.get(), 0);
    assert!(audit.lines.is_empty());
}

#[test]
fn outcomes_of_the_helper_map_to_failures_with_the_reason_for_the_log() {
    for (outcome, want) in [
        (HelperOutcome::Timeout, AttestFailure::Timeout),
        (HelperOutcome::Missing, AttestFailure::Unavailable),
        (HelperOutcome::Broken, AttestFailure::Failed),
        (
            HelperOutcome::Refused("helper-signature-invalid"),
            AttestFailure::Unavailable,
        ),
    ] {
        let host = Host::new(vec![Ok(String::new())], outcome.clone());
        let mut audit = Audit::default();
        assert_eq!(
            attest(&host, &mut audit, None, None),
            AttestResult::Failed(want),
            "{outcome:?}"
        );
        let last = &audit.lines.last().unwrap().1;
        assert_eq!(last["attestationOutcome"], want.as_str());
        if let HelperOutcome::Refused(r) = outcome {
            assert_eq!(last["reason"], r);
        }
    }
}

#[test]
fn the_lifetime_is_clamped_to_one_ms_and_sixty_seconds() {
    for (svc_ttl, input_ttl, want) in [
        (None, Some(600_000.0), 60_000.0),
        (Some(0.0), None, 1.0),
        (Some(5_000.0), None, 5_000.0),
        (None, Some(-5.0), 1.0),
    ] {
        let host = Host::new(vec![Ok(String::new())], HelperOutcome::Broken);
        attest(&host, &mut Audit::default(), svc_ttl, input_ttl);
        assert_eq!(
            host.request.borrow().as_ref().unwrap()["ttlMs"],
            json!(want),
            "{svc_ttl:?} {input_ttl:?}"
        );
    }
}

struct Probe {
    files: HashMap<&'static str, FileStat>,
    uid: Option<u32>,
    windows: bool,
}

impl FileProbe for Probe {
    fn lstat(&self, path: &str) -> Option<FileStat> {
        self.files.get(path).copied()
    }
    fn uid(&self) -> Option<u32> {
        self.uid
    }
    fn windows(&self) -> bool {
        self.windows
    }
}

const FILE: FileStat = FileStat {
    is_file: true,
    is_dir: false,
    mode: 0o755,
    uid: 501,
};
const DIR: FileStat = FileStat {
    is_file: false,
    is_dir: true,
    mode: 0o755,
    uid: 501,
};

fn probe(file: FileStat, dir: FileStat) -> Probe {
    Probe {
        files: HashMap::from([("/opt/p/plur1bus-attest", file), ("/opt/p", dir)]),
        uid: Some(501),
        windows: false,
    }
}

#[test]
fn a_pinned_helper_is_a_private_regular_file_in_a_private_directory() {
    let p = "/opt/p/plur1bus-attest";
    assert!(helper_pinned(p, &probe(FILE, DIR)));
    assert!(helper_pinned(
        p,
        &probe(FileStat { uid: 0, ..FILE }, FileStat { uid: 0, ..DIR })
    ));
    assert!(
        !helper_pinned("opt/p/plur1bus-attest", &probe(FILE, DIR)),
        "relative"
    );
    assert!(
        !helper_pinned(
            p,
            &probe(
                FileStat {
                    mode: 0o775,
                    ..FILE
                },
                DIR
            )
        ),
        "group-writable file"
    );
    assert!(
        !helper_pinned(
            p,
            &probe(
                FileStat {
                    mode: 0o757,
                    ..FILE
                },
                DIR
            )
        ),
        "world-writable file"
    );
    assert!(
        !helper_pinned(p, &probe(FileStat { uid: 502, ..FILE }, DIR)),
        "another user's file"
    );
    assert!(
        !helper_pinned(
            p,
            &probe(
                FILE,
                FileStat {
                    mode: 0o1777,
                    ..DIR
                }
            )
        ),
        "a sticky shared directory"
    );
    assert!(
        !helper_pinned(p, &probe(FILE, FileStat { uid: 502, ..DIR })),
        "another user's directory"
    );
    assert!(
        !helper_pinned(
            p,
            &probe(
                FileStat {
                    is_file: false,
                    is_dir: true,
                    ..FILE
                },
                DIR
            )
        ),
        "a directory"
    );
    assert!(!helper_pinned("/opt/p/missing", &probe(FILE, DIR)));
    let win = Probe {
        files: HashMap::from([(
            "C:\\p\\attest.exe",
            FileStat {
                mode: 0o777,
                uid: 9,
                ..FILE
            },
        )]),
        uid: None,
        windows: true,
    };
    assert!(
        helper_pinned("C:\\p\\attest.exe", &win),
        "Windows relies on the ACL, not the mode"
    );
}

#[test]
fn the_environment_names_the_helper_and_a_malformed_pin_means_none() {
    let pr = probe(FILE, DIR);
    let from = |vars: &[(&str, &str)]| {
        let m: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        helper_from_env(&move |k: &str| m.get(k).cloned(), &pr)
    };
    let bin = ("PLUR1BUS_ATTEST_BIN", "/opt/p/plur1bus-attest");
    assert_eq!(from(&[bin]).unwrap().pin, None);
    assert_eq!(from(&[bin, ("PLUR1BUS_CONTAINER", "1")]), None);
    assert_eq!(from(&[("PLUR1BUS_ATTEST_BIN", "")]), None);
    let sha = "AB".repeat(32);
    let got = from(&[
        bin,
        ("PLUR1BUS_ATTEST_SHA256", &sha),
        ("PLUR1BUS_ATTEST_WIN_THUMBPRINT", &"cd".repeat(20)),
    ])
    .unwrap();
    assert_eq!(
        got.pin.as_ref().unwrap().sha256.as_deref(),
        Some("ab".repeat(32).as_str())
    );
    assert_eq!(
        got.pin.as_ref().unwrap().win_thumbprint.as_deref(),
        Some("CD".repeat(20).as_str())
    );
    assert_eq!(from(&[bin, ("PLUR1BUS_ATTEST_SHA256", "abc")]), None);
    assert_eq!(
        from(&[bin, ("PLUR1BUS_ATTEST_TEAM_ID", "abcdefghij")]),
        None,
        "a team id is upper case"
    );
    assert_eq!(
        from(&[bin, ("PLUR1BUS_ATTEST_TEAM_ID", "ABCDE12345")])
            .unwrap()
            .pin
            .unwrap()
            .mac_team_id
            .as_deref(),
        Some("ABCDE12345")
    );
    assert_eq!(
        from(&[bin, ("PLUR1BUS_ATTEST_WIN_THUMBPRINT", "xyz")]),
        None
    );
}
