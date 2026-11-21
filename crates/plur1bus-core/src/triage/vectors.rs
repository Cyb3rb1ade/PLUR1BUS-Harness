//! Replays `fixtures/parity/triage/*.json` (mode V, `scripts/parity/export-triage.ts`) against the Rust port. A decision
//! is compared as the text `JSON.stringify` gives on the TypeScript side.
use super::classes::{
    class_table, parse_class_profiles, resolve_class, ClassProfileError, ModelClass, MODEL_CLASSES,
};
use super::message_eval::{evaluate_messages, GoldTask, MessageEvalCase};
use super::runtime::{ClassifyFailure, DecideOptions, MessageTriage, TaskBoundary};
use super::{
    apply_at_boundary, choose_class_j, escalate, rule_classifier, triage, triage_with_classifier,
    CostPreference, TriageError, TriageOptions,
};
use crate::approvals::js_json::J;
use crate::prompt::canonical::sha256_hex;
use serde_json::Value;
use std::cell::Cell;

fn fixture(name: &str) -> Value {
    let text = match name {
        "classes" => include_str!("../../../../fixtures/parity/triage/classes.json"),
        "rules" => include_str!("../../../../fixtures/parity/triage/rules.json"),
        "triage" => include_str!("../../../../fixtures/parity/triage/triage.json"),
        "runtime" => include_str!("../../../../fixtures/parity/triage/runtime.json"),
        "message-eval" => include_str!("../../../../fixtures/parity/triage/message-eval.json"),
        other => panic!("no fixture {other}"),
    };
    serde_json::from_str(text).expect("fixture parses")
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("string, got {v}"))
}

fn cost(v: &Value) -> Option<CostPreference> {
    v.get("cost").map(|c| match s(c) {
        "economy" => CostPreference::Economy,
        "balanced" => CostPreference::Balanced,
        "quality" => CostPreference::Quality,
        other => panic!("cost {other}"),
    })
}

fn class(v: &Value) -> ModelClass {
    ModelClass::parse(s(v)).unwrap()
}

/// A recorded argument as the value a classifier could have sent (`$num` for what JSON cannot hold).
fn arg(v: &Value) -> J {
    match v.get("$num").and_then(Value::as_str) {
        Some("NaN") => J::Num(f64::NAN),
        Some("Infinity") => J::Num(f64::INFINITY),
        Some("-0") => J::Num(-0.0),
        Some(other) => panic!("$num {other}"),
        None => J::from_value(v),
    }
}

/// Compares a refusal: the message, or only the kind where TypeScript fails with an engine `TypeError`.
fn same_error(what: &str, got: TriageError, want: &Value) {
    if s(&want["type"]) == "TypeError" {
        assert_eq!(got, TriageError::Type, "{what}");
    } else {
        assert_eq!(got.to_string(), s(&want["message"]), "{what}");
    }
}

#[test]
fn class_vectors_replay() {
    let f = fixture("classes");
    let names: Vec<&str> = MODEL_CLASSES.iter().map(|c| c.as_str()).collect();
    assert_eq!(serde_json::json!(names), f["classes"]);
    let table: Vec<Value> = class_table()
        .iter()
        .map(|(family, row)| {
            serde_json::json!([
                family,
                row.iter()
                    .map(|(c, p)| serde_json::json!([c.as_str(), p]))
                    .collect::<Vec<_>>()
            ])
        })
        .collect();
    assert_eq!(
        Value::Array(table),
        f["table"],
        "the profile table, rows and members in file order"
    );
    let (mut chosen, mut refused) = (0, 0);
    for case in f["choose"].as_array().unwrap() {
        let distribution = J::parse(s(&case["distJson"])).unwrap();
        let confidence = case.get("confidence").map(arg);
        let got = choose_class_j(
            Some(&distribution),
            cost(case).unwrap(),
            confidence.as_ref(),
        );
        match (got, case.get("error")) {
            (Ok(c), None) => {
                assert_eq!(c.as_str(), s(&case["result"]), "{case}");
                chosen += 1;
            }
            (Err(e), Some(want)) => {
                same_error(&case.to_string(), e, want);
                refused += 1;
            }
            (got, _) => panic!("{case}: {got:?}"),
        }
    }
    assert!(
        chosen > 300 && refused > 100,
        "{chosen} chosen, {refused} refused"
    );
    for case in f["escalation"].as_array().unwrap() {
        assert_eq!(
            escalate(class(&case["current"]), case["flag"].as_bool().unwrap()),
            class(&case["result"]),
            "{case}"
        );
    }
    for case in f["boundary"].as_array().unwrap() {
        let got = apply_at_boundary(
            class(&case["current"]),
            class(&case["recommended"]),
            case["at"].as_bool().unwrap(),
        );
        assert_eq!(got, class(&case["result"]), "{case}");
    }
    for case in f["resolve"].as_array().unwrap() {
        let providers: Vec<&str> = case["providers"]
            .as_array()
            .unwrap()
            .iter()
            .map(s)
            .collect();
        let allowed: Vec<&str> = case["allowed"].as_array().unwrap().iter().map(s).collect();
        let got = resolve_class(class(&case["modelClass"]), &providers, &|entry| {
            allowed.contains(&entry)
        });
        let want = (!case["result"].is_null()).then(|| {
            (
                s(&case["result"]["provider"]).to_owned(),
                s(&case["result"]["profile"]).to_owned(),
            )
        });
        assert_eq!(got, want, "{case}");
    }
    for case in f["profiles"].as_array().unwrap() {
        let fallback: Vec<(ModelClass, String)> = case["fallback"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (class(&p[0]), s(&p[1]).to_owned()))
            .collect();
        match (
            parse_class_profiles(case["text"].as_str(), &fallback),
            case.get("error"),
        ) {
            (Ok(rows), None) => {
                let got: Vec<Value> = rows
                    .iter()
                    .map(|(c, p)| serde_json::json!([c.as_str(), p]))
                    .collect();
                assert_eq!(Value::Array(got), case["result"], "{case}");
            }
            // A text that is not JSON is a `SyntaxError` with the engine's wording in TypeScript.
            (Err(ClassProfileError::Json), Some(want)) => {
                assert_eq!(s(&want["type"]), "SyntaxError", "{case}")
            }
            (Err(e), Some(want)) => assert_eq!(e.to_string(), s(&want["message"]), "{case}"),
            (got, _) => panic!("{case}: {got:?}"),
        }
    }
}

#[test]
fn rule_vectors_replay() {
    let f = fixture("rules");
    let cases = f["cases"].as_array().unwrap();
    for case in cases {
        let got = rule_classifier(s(&case["message"]), cost(case).unwrap());
        assert_eq!(
            got.as_j().stringify(),
            s(&case["json"]),
            "{:?} ({})",
            case["message"],
            case["cost"]
        );
    }
    assert!(cases.len() > 1400, "{}", cases.len());
}

#[test]
fn triage_vectors_replay() {
    let f = fixture("triage");
    let (mut accepted, mut refused) = (0, 0);
    for case in f["cases"].as_array().unwrap() {
        let what = format!(
            "{} {:?} {:?}",
            case["name"],
            case.get("cost"),
            case.get("activeTask")
        );
        let classified = case
            .get("classifiedJson")
            .map(|text| J::parse(s(text)).expect("the answer parses"));
        let options = TriageOptions {
            classified: classified.as_ref(),
            cost: cost(case),
            active_task: case.get("activeTask").map(s),
        };
        let got = triage(s(&case["message"]), &options);
        if case["divergence"] == "K9a-D6" {
            assert!(matches!(got, Err(TriageError::Decision)), "{what}");
            refused += 1;
            continue;
        }
        match (got, case.get("error")) {
            (Ok(d), None) => {
                assert_eq!(d.as_j().stringify(), s(&case["json"]), "{what}");
                accepted += 1;
            }
            (Err(e), Some(want)) => {
                same_error(&what, e, want);
                assert!(
                    !e.to_string().contains("bug"),
                    "no error echoes the message"
                );
                refused += 1;
            }
            (got, want) => panic!("{what}: Rust {got:?}, TypeScript {want:?}"),
        }
    }
    assert!(
        accepted > 100 && refused > 150,
        "{accepted} accepted, {refused} refused"
    );
}

fn decision_j(d: &super::runtime::MessageDecision) -> J {
    let mut j = J::Obj(vec![("decision".to_owned(), d.decision.as_j().clone())]);
    if let (Some(class), Some(effort)) = (d.model_class, d.effort) {
        j.set("modelClass", J::s(class.as_str()));
        j.set("effort", J::s(effort.as_str()));
    }
    j.set("coreOnly", J::Bool(d.core_only));
    j.set("fallback", J::Bool(d.fallback));
    j
}

#[test]
fn runtime_vectors_replay() {
    let f = fixture("runtime");
    let (mut decided, mut aborted) = (0, 0);
    for scenario in f["scenarios"].as_array().unwrap() {
        let name = s(&scenario["name"]);
        let mut runtime = MessageTriage::new();
        for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let what = format!("{name}[{i}]");
            let never = || false;
            if let Some(n) = step.get("fill") {
                let answer = J::parse(s(&step["answer"])).unwrap();
                let options = DecideOptions {
                    aborted: &never,
                    timeout_ms: None,
                    cost: None,
                    task: None,
                    on_fallback: None,
                };
                let lines: Vec<String> = (0..n.as_u64().unwrap())
                    .map(|k| {
                        decision_j(
                            &runtime
                                .decide(
                                    "do it",
                                    &format!("s{k}"),
                                    |_, _| Ok(answer.clone()),
                                    &options,
                                )
                                .unwrap(),
                        )
                        .stringify()
                    })
                    .collect();
                assert_eq!(sha256_hex(&lines.join("\n")), s(&step["digest"]), "{what}");
                continue;
            }
            let answer = &step["answer"];
            let cancelled = Cell::new(answer.as_str() == Some("abort-before"));
            let fallbacks = Cell::new(0u64);
            let is_cancelled = || cancelled.get();
            let count = || fallbacks.set(fallbacks.get() + 1);
            let options = DecideOptions {
                aborted: &is_cancelled,
                timeout_ms: step.get("timeoutMs").and_then(Value::as_f64),
                cost: cost(step),
                task: step.get("task").map(|t| TaskBoundary {
                    id: s(&t["id"]).to_owned(),
                    at_boundary: t["atBoundary"].as_bool().unwrap(),
                }),
                on_fallback: Some(&count),
            };
            let classify = |_: &str, limit: f64| -> Result<J, ClassifyFailure> {
                assert_eq!(
                    limit,
                    step.get("timeoutMs")
                        .and_then(Value::as_f64)
                        .unwrap_or(2000.0)
                );
                match answer.as_str() {
                    // A classifier that never answers has to give up at the limit it was handed.
                    Some("fail" | "hang") => Err(ClassifyFailure::Failed),
                    Some("abort-during") => {
                        cancelled.set(true);
                        Ok(
                            J::parse(r#"{"schema":"plur1bus.triage/1","shape":"chat","tasks":[]}"#)
                                .unwrap(),
                        )
                    }
                    Some(other) => panic!("{other}: the classifier is not asked"),
                    None => J::parse(s(&answer["json"])).ok_or(ClassifyFailure::Failed),
                }
            };
            match runtime.decide(s(&step["message"]), s(&step["scope"]), classify, &options) {
                Ok(d) => {
                    assert_eq!(decision_j(&d).stringify(), s(&step["json"]), "{what}");
                    decided += 1;
                }
                Err(_) => {
                    assert_eq!(step["aborted"], true, "{what}");
                    aborted += 1;
                }
            }
            assert_eq!(
                fallbacks.get(),
                step["fallbacks"].as_u64().unwrap(),
                "{what}: fallbacks"
            );
        }
    }
    assert!(
        decided > 30 && aborted == 2,
        "{decided} decided, {aborted} aborted"
    );
}

#[test]
fn message_eval_vectors_replay() {
    let f = fixture("message-eval");
    for set in f["sets"].as_array().unwrap() {
        let name = s(&set["name"]);
        let cases: Vec<MessageEvalCase> = set["golds"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, gold)| MessageEvalCase {
                id: format!("m{i}"),
                message: s(&set["message"]).to_owned(),
                gold: gold
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|g| GoldTask {
                        start: g["start"].as_u64().unwrap() as usize,
                        end: g["end"].as_u64().unwrap() as usize,
                        category: s(&g["category"]).to_owned(),
                        minimum_class: class(&g["minimumClass"]),
                    })
                    .collect(),
            })
            .collect();
        let answers = set["answers"].as_array().unwrap();
        let r = evaluate_messages(&cases, |row| {
            answers[row.id[1..].parse::<usize>().unwrap()]
                .as_str()
                .and_then(J::parse)
        });
        let n = |v: usize| J::Num(v as f64);
        let got = J::obj([
            ("messages", n(r.messages)),
            ("expected", n(r.expected)),
            ("predicted", n(r.predicted)),
            ("matched", n(r.matched)),
            ("under", n(r.under)),
            ("categories", n(r.categories)),
            ("failed", n(r.failed)),
            ("segmentationF1", J::Num(r.segmentation_f1)),
            ("underProvisioning", J::Num(r.under_provisioning)),
            ("passed", J::Bool(r.passed)),
        ]);
        assert_eq!(got.stringify(), s(&set["json"]), "{name}");
    }
    let passed: Vec<&str> = f["sets"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|x| x["result"]["passed"] == true)
        .map(|x| s(&x["name"]))
        .collect();
    assert_eq!(
        passed,
        [
            "all-good-60",
            "extra-13-of-60",
            "under-3-of-60",
            "wrong-category",
            "prototype-category"
        ],
        "the gates at their boundaries"
    );
    for case in f["wrapper"].as_array().unwrap() {
        let calls = Cell::new(0u64);
        let got = triage_with_classifier(
            s(&case["message"]),
            |message, cost| -> Result<J, ()> {
                calls.set(calls.get() + 1);
                Ok(rule_classifier(message, cost).as_j().clone())
            },
            Some(CostPreference::Quality),
            case.get("activeTask").map(s),
        )
        .unwrap();
        assert_eq!(got.as_j().stringify(), s(&case["json"]), "{case}");
        assert_eq!(calls.get(), case["calls"].as_u64().unwrap(), "{case}");
    }
}
