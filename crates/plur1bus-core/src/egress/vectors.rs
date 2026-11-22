//! Replays `fixtures/parity/egress/*.json` (mode V, `scripts/parity/export-egress.ts`) and the shared address vectors
//! (`packages/core/test/fixtures/net/ip-classification-vectors.json`) against the Rust port.
//!
//! A case with a `note` needs IDNA; the replay runs on [`HostIdna`], so those cases must equal the TypeScript answer as
//! every other one.
use super::gate::{bare_host, effective_port, is_loopback_host, Decision, Gate};
use super::guard::{ResolvedAddress, Resolver};
use super::ip::{canonical, classify, parse_address, TABLE};
use super::model_downloads::{is_model_artifact_request, model_download_policy, ModelRequest};
use super::policy::{compile_egress_policy, host_allowed, HostMatch};
use super::service::{ConfigSource, Egress, Purpose};
use super::{parse_url, HostIdna};
use serde_json::{json, Map, Value};
use std::sync::Mutex;

fn fixture(name: &str) -> Value {
    let text = match name {
        "policy" => include_str!("../../../../fixtures/parity/egress/policy.json"),
        "gate" => include_str!("../../../../fixtures/parity/egress/gate.json"),
        "decide" => include_str!("../../../../fixtures/parity/egress/decide.json"),
        "model" => include_str!("../../../../fixtures/parity/egress/model.json"),
        "urls" => include_str!("../../../../fixtures/parity/egress/urls.json"),
        "ip" => include_str!(
            "../../../../packages/core/test/fixtures/net/ip-classification-vectors.json"
        ),
        other => panic!("no fixture {other}"),
    };
    serde_json::from_str(text).expect("fixture parses")
}

fn s(v: &Value) -> &str {
    v.as_str().expect("string")
}

const OPTS: [HostMatch; 3] = [
    HostMatch {
        explicit_only: false,
        exact_only: false,
    },
    HostMatch {
        explicit_only: true,
        exact_only: false,
    },
    HostMatch {
        explicit_only: false,
        exact_only: true,
    },
];

#[test]
fn shared_address_vectors_replay() {
    let f = fixture("ip");
    assert_eq!(s(&f["classifier"]), super::ip::CLASSIFIER_ID);
    let table: Vec<(String, String)> = f["table"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (s(&r["cidr"]).to_owned(), s(&r["reason"]).to_owned()))
        .collect();
    let ours: Vec<(String, String)> = TABLE
        .iter()
        .map(|(c, r)| ((*c).to_owned(), (*r).to_owned()))
        .collect();
    assert_eq!(table, ours);
    let rows = f["addresses"].as_array().unwrap();
    for row in rows {
        let input = s(&row["input"]);
        let a = parse_address(input, false).unwrap_or_else(|| panic!("parses: {input}"));
        let want = parse_address(s(&row["canonical"]), false).expect("canonical parses");
        assert_eq!(canonical(a), canonical(want), "{input}: canonical");
        let v = classify(a);
        assert_eq!(v.public, row["public"].as_bool().unwrap(), "{input}");
        assert_eq!(v.reason, row["reason"].as_str(), "{input}");
    }
    assert!(rows.len() > 200);
    for row in f["parseRejects"].as_array().unwrap() {
        let strict = row["strict"].as_bool().unwrap();
        assert_eq!(parse_address(s(&row["input"]), strict), None, "{row}");
    }
    for row in f["strictRejects"].as_array().unwrap() {
        assert_eq!(parse_address(s(row), true), None, "{row}");
        assert!(
            parse_address(s(row), false).is_some(),
            "{row} parses loosely"
        );
    }
}

#[test]
fn policy_vectors_replay() {
    let f = fixture("policy");
    let (mut exact, mut diverged) = (0, 0);
    for case in f.as_array().unwrap() {
        let p = compile_egress_policy(&case["config"], &HostIdna);
        let hosts = case["hosts"].as_array().unwrap();
        let allowed = case["allowed"].as_array().unwrap();
        if case.get("divergence").is_some() {
            // K2-D4: Node takes an `xn--` label that is not valid IDNA; here the entry is an error and nothing is allowed.
            assert_ne!(p.json(), case["policy"], "{}", case["name"]);
            assert_eq!(p.errors.len(), 1, "{}", case["name"]);
            assert!(p.host_rules.is_empty() && p.allow_ports.is_empty() && !p.allow_loopback);
            for h in hosts {
                assert!(OPTS.iter().all(|o| !host_allowed(&p, s(h), *o)));
            }
            diverged += 1;
            continue;
        }
        assert_eq!(p.json(), case["policy"], "{}", case["name"]);
        for (h, want) in hosts.iter().zip(allowed) {
            for (i, o) in OPTS.iter().enumerate() {
                assert_eq!(
                    Value::Bool(host_allowed(&p, s(h), *o)),
                    want[i],
                    "{} {h} option {i}",
                    case["name"]
                );
            }
        }
        exact += 1;
    }
    assert!(
        exact > 50 && diverged == 2,
        "exact {exact}, diverged {diverged}"
    );
}

fn decision_json(d: &Decision) -> Value {
    match d {
        Decision::Allowed => json!({ "allowed": true }),
        Decision::Denied(r) => json!({ "allowed": false, "reason": r.as_str() }),
    }
}

fn pin_of(v: &Value) -> ResolvedAddress {
    ResolvedAddress {
        address: s(&v["address"]).to_owned(),
        family: v["family"].as_u64().unwrap() as u8,
    }
}

#[test]
fn gate_vectors_replay() {
    let f = fixture("gate");
    let configs = f["configs"].as_array().unwrap();
    let pins: Vec<ResolvedAddress> = f["pins"].as_array().unwrap().iter().map(pin_of).collect();
    let mut checked = 0;
    for case in f["cases"].as_array().unwrap() {
        let raw = s(&case["url"]);
        let parsed = parse_url(raw);
        if case.get("urlError").is_some() {
            assert_eq!(parsed, None, "{raw}: new URL throws");
            continue;
        }
        let url = parsed.unwrap_or_else(|| panic!("{raw}: Rust refuses a URL that parses"));
        let policy = compile_egress_policy(
            &configs[case["config"].as_u64().unwrap() as usize],
            &HostIdna,
        );
        assert_eq!(url.hostname, s(&case["hostname"]), "{raw}");
        assert_eq!(url.protocol(), s(&case["protocol"]), "{raw}");
        assert_eq!(
            url.port.map(|p| p.to_string()).unwrap_or_default(),
            s(&case["port"]),
            "{raw}"
        );
        assert_eq!(bare_host(&url), s(&case["bareHost"]), "{raw}");
        assert_eq!(
            u64::from(effective_port(&url)),
            case["effectivePort"].as_u64().unwrap(),
            "{raw}"
        );
        assert_eq!(
            Value::Bool(is_loopback_host(&bare_host(&url))),
            case["loopbackHost"],
            "{raw}"
        );
        let mut seen = Vec::new();
        let before = Gate::new(&policy, |d| seen.push(d)).before_resolve(&url);
        let before_json = match &before {
            Ok(()) => Value::Null,
            Err(d) => {
                json!({ "reason": d.reason.as_str(), "message": d.message, "host": d.host, "code": d.code() })
            }
        };
        assert_eq!(
            before_json, case["before"],
            "{raw} config {}",
            case["config"]
        );
        assert_eq!(
            Value::from(seen.iter().map(decision_json).collect::<Vec<_>>()),
            case["beforeDecisions"],
            "{raw}"
        );
        for (pin, want) in pins.iter().zip(case["after"].as_array().unwrap()) {
            let mut seen = Vec::new();
            let r = Gate::new(&policy, |d| seen.push(d)).after_resolve(&url, pin);
            let decisions = Value::from(seen.iter().map(decision_json).collect::<Vec<_>>());
            let got = match r {
                Ok(()) => json!({ "ok": true, "decisions": decisions }),
                Err(d) => {
                    json!({ "reason": d.reason.as_str(), "message": d.message, "host": d.host, "code": d.code(), "decisions": decisions })
                }
            };
            assert_eq!(&got, want, "{raw} pin {}", pin.address);
        }
        checked += 1;
    }
    assert!(checked > 700, "checked {checked}");
}

struct Scripted {
    config: Mutex<Value>,
    answers: Mutex<Map<String, Value>>,
    lookups: Mutex<Vec<String>>,
}

impl ConfigSource for Scripted {
    fn egress_config(&self) -> Value {
        self.config.lock().unwrap().clone()
    }
}

impl Resolver for Scripted {
    fn resolve(&self, host: &str) -> Result<Vec<ResolvedAddress>, Option<String>> {
        self.lookups.lock().unwrap().push(host.to_owned());
        match self.answers.lock().unwrap().get(host) {
            None => Err(Some("ENOTFOUND".to_owned())),
            Some(a) if a.get("error").is_some() => {
                let code = s(&a["error"]);
                Err((!code.is_empty()).then(|| code.to_owned()))
            }
            Some(a) => Ok(a["addresses"]
                .as_array()
                .unwrap()
                .iter()
                .map(pin_of)
                .collect()),
        }
    }
}

#[test]
fn decide_vectors_replay() {
    let f = fixture("decide");
    let mut steps_checked = 0;
    for sc in f.as_array().unwrap() {
        let configs = sc["configs"].as_array().unwrap();
        let base = sc["answers"].as_object().unwrap().clone();
        let scripted = Scripted {
            config: Mutex::new(configs[0].clone()),
            answers: Mutex::new(base.clone()),
            lookups: Mutex::new(Vec::new()),
        };
        let now = 1_794_978_000_000; // Date.UTC(2026, 10, 18, 5)
        let egress = Egress::new(&scripted, &scripted, &HostIdna, now);
        for step in sc["steps"].as_array().unwrap() {
            let ci = step.get("config").and_then(Value::as_u64).unwrap_or(0) as usize;
            *scripted.config.lock().unwrap() = configs[ci].clone();
            let mut answers = base.clone();
            if let Some(extra) = step.get("answers").and_then(Value::as_object) {
                answers.extend(extra.clone());
            }
            *scripted.answers.lock().unwrap() = answers;
            scripted.lookups.lock().unwrap().clear();
            let purpose = if step.get("purpose").is_some() {
                Purpose::A2a
            } else {
                Purpose::Ordinary
            };
            let got = egress.decide(s(&step["url"]), purpose).json();
            assert_eq!(got, step["result"], "{} {}", sc["name"], step["url"]);
            assert_eq!(
                Value::from(scripted.lookups.lock().unwrap().clone()),
                step["lookups"],
                "{}",
                step["url"]
            );
            assert_eq!(
                egress.status(),
                step["status"],
                "{} {}",
                sc["name"],
                step["url"]
            );
            steps_checked += 1;
        }
    }
    assert!(steps_checked > 35, "{steps_checked}");
}

#[test]
fn model_download_vectors_replay() {
    let f = fixture("model");
    let mut checked = 0;
    for r in f["requests"].as_array().unwrap() {
        if r.get("requestError").is_some() {
            continue; // `new Request` throws: there is no request to judge
        }
        let req = ModelRequest {
            method: r
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("GET")
                .to_owned(),
            url: s(&r["url"]).to_owned(),
            header_names: r
                .get("headers")
                .and_then(Value::as_array)
                .map(|h| h.iter().map(|p| s(&p[0]).to_owned()).collect())
                .unwrap_or_default(),
            has_body: r.get("body").is_some(),
        };
        assert_eq!(
            Value::Bool(is_model_artifact_request(&req)),
            r["artifact"],
            "{}",
            r["url"]
        );
        checked += 1;
    }
    assert!(checked > 30);
    for p in f["policies"].as_array().unwrap() {
        match model_download_policy(&p["config"]) {
            Ok(derived) => {
                assert_eq!(derived, p["derived"], "{}", p["config"]);
                assert_eq!(
                    compile_egress_policy(&derived, &HostIdna).json(),
                    p["policy"]
                );
            }
            Err(e) => assert_eq!(e, s(&p["error"])),
        }
    }
}

/// One row of `urls.json`: the URL, what `new URL` reads from it (`None` where it throws) and the divergence marker.
type UrlRow = (String, Option<[String; 5]>, Option<String>);

fn url_row(text: &Value) -> UrlRow {
    let row: Vec<String> = serde_json::from_str(s(text)).expect("a row is JSON text");
    let read = (row.len() > 1).then(|| {
        [
            row[1].clone(),
            row[2].clone(),
            row[3].clone(),
            row[4].clone(),
            row[5].clone(),
        ]
    });
    (row[0].clone(), read, row.get(6).cloned())
}

/// The gate judges the host, port, scheme and credentials its reader hands it, so the reader has to read a URL as `new URL`
/// does in the TypeScript core: refuse what the constructor refuses, and spell every member the same. `urls.json` holds
/// Node's reading of URLs built to be misread. The one known difference is K2-D4 (an `xn--` label that is not valid IDNA,
/// which Node keeps): there the reader refuses, and nowhere else.
#[test]
fn the_gate_reads_a_url_as_node_does() {
    let f = fixture("urls");
    let (mut refused, mut read, mut diverged, mut wrong) = (0, 0, 0, Vec::new());
    let mut check = |text: &Value| {
        let (raw, node, divergence) = url_row(text);
        let ours = parse_url(&raw).map(|u| {
            let port = u.port.map(|p| p.to_string()).unwrap_or_default();
            [u.protocol(), u.username, u.password, u.hostname, port]
        });
        match divergence.as_deref() {
            Some("K2-D4") => {
                diverged += 1;
                if ours.is_some() || node.is_none() {
                    wrong.push(format!(
                        "{raw:?}: K2-D4 means Node reads and Rust refuses, got {ours:?}"
                    ));
                }
            }
            Some(other) => wrong.push(format!("{raw:?}: unknown divergence {other}")),
            None => {
                if node.is_some() {
                    read += 1;
                } else {
                    refused += 1;
                }
                if ours != node {
                    wrong.push(format!("{raw:?}: Node {node:?}, Rust {ours:?}"));
                }
            }
        }
    };
    let classes = f["classes"].as_object().unwrap();
    for (name, rows) in classes {
        let rows = rows.as_array().unwrap();
        assert!(rows.len() >= 2, "class {name} has fewer than two cases");
        rows.iter().for_each(&mut check);
    }
    f["corpus"].as_array().unwrap().iter().for_each(&mut check);
    assert!(
        wrong.is_empty(),
        "{} of {} differ:\n{}",
        wrong.len(),
        refused + read + diverged,
        wrong.join("\n")
    );
    assert!(classes.len() >= 15, "{} classes", classes.len());
    assert!(
        refused > 1500 && read > 1500 && diverged >= 20,
        "refused {refused}, read {read}, diverged {diverged}"
    );
}
