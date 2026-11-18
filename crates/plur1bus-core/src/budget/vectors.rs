//! Replays `fixtures/parity/budget/*.json` (mode V, `scripts/parity/export-budget.ts`) against the Rust port.
//!
//! Time zones: the period vectors run against the production adapter, [`TzdbZones`], so they also prove the database
//! `chrono-tz` carries against the one ICU carried when the vectors were recorded.
use super::calls::MediaAmounts;
use super::context::{
    allocate_context, check_zones, ContextAllocation, ZoneCheck, ZonePolicy, ZoneShare, ZONES,
};
use super::media::{media_call_units, MediaUnit, MediaUnits};
use super::period::{period_bounds, validate_time_zone, CallPeriod, Period};
use super::retry::{
    RetryBudget, RetryClass, RetryError, RetryPolicy, RetryRule, CLASSES, DEFAULT_RETRY_TURN_TOKENS,
};
use super::service::{describe_breach, Breach, LimitScope, Metric};
use super::subagent::{
    cap_subagent_result, CappedSubagentResult, SubagentCapOptions, SubagentResultPort,
};
use super::weight::{counted_tokens, stored_cache_read_weight, validate_cache_read_weight};
use super::zones::TzdbZones;
use plur1bus_store::rusqlite::Connection;
use serde_json::{json, Value};
use std::cell::Cell;
use std::collections::BTreeSet;

fn fixture(name: &str) -> Value {
    let text = match name {
        "period" => include_str!("../../../../fixtures/parity/budget/period.json"),
        "weight" => include_str!("../../../../fixtures/parity/budget/weight.json"),
        "context" => include_str!("../../../../fixtures/parity/budget/context.json"),
        "retry" => include_str!("../../../../fixtures/parity/budget/retry.json"),
        "subagent" => include_str!("../../../../fixtures/parity/budget/subagent.json"),
        "media" => include_str!("../../../../fixtures/parity/budget/media.json"),
        "breach" => include_str!("../../../../fixtures/parity/budget/breach.json"),
        other => panic!("no fixture {other}"),
    };
    serde_json::from_str(text).expect("fixture parses")
}

/// A number as the exporter encodes it: a JSON number, or "NaN", "Infinity", "-Infinity", "-0".
fn num(v: &Value) -> f64 {
    match v {
        Value::String(s) => match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            other => panic!("unknown number tag {other}"),
        },
        other => other.as_f64().expect("number"),
    }
}

// --- periods ------------------------------------------------------------------------------------------------------------

#[test]
fn period_vectors_replay() {
    let f = fixture("period");
    let mut zones = BTreeSet::new();
    let rows = f["rows"].as_array().unwrap();
    for row in rows {
        let zone = row[0].as_str().unwrap();
        zones.insert(zone.to_owned());
        let period = CallPeriod::parse(row[1].as_str().unwrap()).expect("period");
        let ts = row[2].as_i64().unwrap();
        let b =
            period_bounds(&TzdbZones, ts, zone, period).unwrap_or_else(|e| panic!("{row}: {e}"));
        assert_eq!(
            (b.key.as_str(), b.start, b.end),
            (
                row[3].as_str().unwrap(),
                row[4].as_i64().unwrap(),
                row[5].as_i64().unwrap()
            ),
            "{row}"
        );
    }
    assert!(rows.len() > 1500, "replayed {}", rows.len());
    // The unusual days are in: a skipped midnight, a half-hour DST, a skipped day, and a zone given as an offset.
    for zone in [
        "America/Sao_Paulo",
        "Australia/Lord_Howe",
        "Pacific/Apia",
        "+05:45",
    ] {
        assert!(zones.contains(zone), "{zone}");
    }
}

#[test]
fn period_error_and_validation_vectors_replay() {
    let f = fixture("period");
    for e in f["errors"].as_array().unwrap() {
        let r = period_bounds(
            &TzdbZones,
            e["ts"].as_i64().unwrap(),
            e["zone"].as_str().unwrap(),
            CallPeriod::Day,
        );
        assert_eq!(
            r.unwrap_err().to_string(),
            e["message"].as_str().unwrap(),
            "{e}"
        );
    }
    for v in f["validate"].as_array().unwrap() {
        let zone = v["zone"].as_str().unwrap();
        match (v.get("ok"), v.get("message")) {
            (Some(ok), _) => assert_eq!(
                validate_time_zone(&TzdbZones, zone).unwrap(),
                ok.as_str().unwrap(),
                "{v}"
            ),
            (None, Some(m)) => assert_eq!(
                validate_time_zone(&TzdbZones, zone)
                    .unwrap_err()
                    .to_string(),
                m.as_str().unwrap(),
                "{v}"
            ),
            _ => panic!("{v}"),
        }
    }
}

// --- weights ------------------------------------------------------------------------------------------------------------

#[test]
fn weight_vectors_replay() {
    let f = fixture("weight");
    for v in f["validate"].as_array().unwrap() {
        let r = validate_cache_read_weight(num(&v["weight"]));
        match v.get("ok") {
            Some(ok) => assert_eq!(r.unwrap(), ok.as_f64().unwrap(), "{v}"),
            None => assert_eq!(
                r.unwrap_err().to_string(),
                v["message"].as_str().unwrap(),
                "{v}"
            ),
        }
    }
    for c in f["counted"].as_array().unwrap() {
        let got = counted_tokens(
            c["inputOutput"].as_i64().unwrap(),
            c["cacheReads"].as_i64().unwrap(),
            c["weight"].as_f64().unwrap(),
        );
        assert_eq!(got, c["counted"].as_i64().unwrap(), "{c}");
    }
    for s in f["stored"].as_array().unwrap() {
        let conn = settings_with(Some(s["value"].as_str().unwrap()));
        let got = stored_cache_read_weight(&conn);
        match s.get("weight") {
            Some(w) => assert_eq!(got.unwrap(), w.as_f64().unwrap(), "{s}"),
            None => assert!(got.is_err(), "{s}"),
        }
    }
    assert_eq!(
        stored_cache_read_weight(&settings_with(None)).unwrap(),
        f["absent"].as_f64().unwrap()
    );
}

fn settings_with(value: Option<&str>) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        .unwrap();
    if let Some(v) = value {
        conn.execute("INSERT INTO settings VALUES ('cache_read_weight', ?1)", [v])
            .unwrap();
    }
    conn
}

// --- context zones ------------------------------------------------------------------------------------------------------

fn policy_of(v: &Value) -> ZonePolicy {
    let mut out = [ZoneShare {
        min_share: 0.0,
        max_share: 0.0,
        max_tokens: None,
    }; 5];
    for z in ZONES {
        let p = &v[z.as_str()];
        out[z.index()] = ZoneShare {
            min_share: p["minShare"].as_f64().unwrap(),
            max_share: p["maxShare"].as_f64().unwrap(),
            max_tokens: p.get("maxTokens").and_then(Value::as_i64),
        };
    }
    out
}

#[test]
fn context_vectors_replay() {
    let f = fixture("context");
    let names: Vec<&str> = f["zones"]
        .as_array()
        .unwrap()
        .iter()
        .map(|z| z.as_str().unwrap())
        .collect();
    assert_eq!(names, ZONES.map(|z| z.as_str()).to_vec());
    for a in f["allocate"].as_array().unwrap() {
        let policy = policy_of(&f["policies"][a["policy"].as_str().unwrap()]);
        let r = allocate_context(a["window"].as_i64().unwrap(), &policy);
        if let Some(m) = a.get("message") {
            assert_eq!(r.unwrap_err().to_string(), m.as_str().unwrap(), "{a}");
            continue;
        }
        let want = &a["result"];
        match r.unwrap() {
            ContextAllocation::Allocated {
                budgets,
                unallocated,
            } => {
                assert_eq!(want["kind"], "allocated", "{a}");
                assert_eq!(want["unallocated"].as_i64().unwrap(), unallocated, "{a}");
                for z in ZONES {
                    assert_eq!(
                        want["budgets"][z.as_str()].as_i64().unwrap(),
                        budgets[z.index()],
                        "{a}"
                    );
                }
            }
            ContextAllocation::Infeasible { reason } => {
                assert_eq!(
                    (
                        want["kind"].as_str().unwrap(),
                        want["reason"].as_str().unwrap()
                    ),
                    ("infeasible", reason.as_str()),
                    "{a}"
                );
            }
        }
    }
    for c in f["check"].as_array().unwrap() {
        let mut budgets = [0_i64; 5];
        let mut used = [None; 5];
        for z in ZONES {
            budgets[z.index()] = c["budgets"][z.as_str()].as_i64().unwrap();
            used[z.index()] = c["used"].get(z.as_str()).and_then(Value::as_i64);
        }
        let r = check_zones(&budgets, &used);
        if let Some(m) = c.get("message") {
            assert_eq!(r.unwrap_err().to_string(), m.as_str().unwrap(), "{c}");
            continue;
        }
        match r.unwrap() {
            ZoneCheck::WithinBudget => assert_eq!(c["result"]["kind"], "within_budget", "{c}"),
            ZoneCheck::ZoneExceeded(over) => {
                assert_eq!(c["result"]["kind"], "zone_exceeded", "{c}");
                let got: Vec<Value> = over
                    .iter()
                    .map(|o| json!({"limit": o.limit, "used": o.used, "zone": o.zone.as_str()}))
                    .collect();
                assert_eq!(Value::Array(got), c["result"]["zones"], "{c}");
            }
        }
    }
}

// --- retry --------------------------------------------------------------------------------------------------------------

fn retry_policy(v: &Value) -> RetryPolicy {
    let mut out = [RetryRule {
        max_attempts: 0,
        max_tokens: 0,
    }; 5];
    for (i, c) in CLASSES.iter().enumerate() {
        let r = &v[c.as_str()];
        out[i] = RetryRule {
            max_attempts: r["maxAttempts"].as_i64().unwrap(),
            max_tokens: r["maxTokens"].as_i64().unwrap(),
        };
    }
    out
}

#[test]
fn retry_vectors_replay() {
    for s in fixture("retry").as_array().unwrap() {
        let name = s["name"].as_str().unwrap();
        let mut rb = if s["policy"].is_null() && s["turnTokens"].is_null() {
            RetryBudget::with_defaults()
        } else {
            let p = if s["policy"].is_null() {
                super::retry::DEFAULT_RETRY_POLICY
            } else {
                retry_policy(&s["policy"])
            };
            RetryBudget::new(
                p,
                s["turnTokens"]
                    .as_i64()
                    .unwrap_or(DEFAULT_RETRY_TURN_TOKENS),
            )
            .unwrap()
        };
        for (i, (op, want)) in s["ops"]
            .as_array()
            .unwrap()
            .iter()
            .zip(s["results"].as_array().unwrap())
            .enumerate()
        {
            let at = format!("{name} op {i}: {op} -> {want}");
            let got: Result<Value, String> = match op["op"].as_str().unwrap() {
                "consume" => RetryClass::parse(op["cls"].as_str().unwrap())
                    .map_err(|e| format!("R:{e}"))
                    .and_then(|c| {
                        rb.consume(
                            op["turn"].as_str().unwrap(),
                            c,
                            op["tokens"].as_i64().unwrap(),
                        )
                        .map_err(|e| retry_err(&e))
                    })
                    .map(|t| json!({"ticket": t})),
                "settle" => rb
                    .settle(
                        op["ticket"].as_u64().unwrap(),
                        op["tokens"].as_i64().unwrap(),
                    )
                    .map_err(|e| retry_err(&e))
                    .map(|b| json!({"settled": b})),
                _ => {
                    rb.end_turn(op["turn"].as_str().unwrap());
                    Ok(json!({"ended": true}))
                }
            };
            match (got, want.get("error")) {
                (Ok(v), None) => assert_eq!(&v, want, "{at}"),
                (Err(e), Some(kind)) => {
                    if kind == "exceeded" {
                        assert_eq!(
                            e,
                            format!(
                                "E:{}:{}:{}",
                                want["class"].as_str().unwrap(),
                                want["reason"].as_str().unwrap(),
                                want["message"].as_str().unwrap()
                            ),
                            "{at}"
                        );
                    } else {
                        assert!(e.starts_with("R:"), "{at}: {e}");
                        assert_eq!(&e[2..], want["message"].as_str().unwrap(), "{at}");
                    }
                }
                (g, _) => panic!("{at}: got {g:?}"),
            }
        }
    }
}

fn retry_err(e: &RetryError) -> String {
    match e {
        RetryError::Exceeded { class, reason } => format!(
            "E:{}:{}:{e}",
            class.as_str(),
            if *reason == super::retry::Reason::Attempts {
                "attempts"
            } else {
                "tokens"
            }
        ),
        RetryError::Range(m) => format!("R:{m}"),
    }
}

// --- subagent cap -------------------------------------------------------------------------------------------------------

struct FixedPort<'a> {
    pointer: &'a str,
    stored: Cell<bool>,
}

impl SubagentResultPort for FixedPort<'_> {
    fn store(&self, _value: &Value) -> String {
        self.stored.set(true);
        self.pointer.to_owned()
    }
}

#[test]
fn subagent_vectors_replay() {
    for c in fixture("subagent").as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let port = FixedPort {
            pointer: c["pointer"].as_str().unwrap(),
            stored: Cell::new(false),
        };
        let counter: Box<dyn Fn(&str) -> i64> = match c["counter"].as_str().unwrap() {
            "bytes" => Box::new(|s| s.len() as i64),
            "codepoints" => Box::new(|s| s.chars().count() as i64),
            _ => Box::new(|s| s.encode_utf16().count() as i64),
        };
        let r = cap_subagent_result(
            &c["value"],
            &SubagentCapOptions {
                limit: c.get("limit").and_then(Value::as_i64),
                port: &port,
                count_tokens: Some(&*counter),
            },
        );
        assert_eq!(
            if port.stored.get() { "value" } else { "none" },
            c["stored"].as_str().unwrap(),
            "{name}: port use"
        );
        match (r, c.get("error")) {
            (Err(e), Some(_)) => {
                assert_eq!(e.to_string(), c["message"].as_str().unwrap(), "{name}")
            }
            (Ok(CappedSubagentResult::Complete(_)), None) => {
                assert_eq!(c["result"]["kind"], "complete", "{name}")
            }
            (
                Ok(CappedSubagentResult::Capped {
                    text,
                    pointer,
                    original_tokens,
                }),
                None,
            ) => {
                let want = &c["result"];
                assert_eq!(want["kind"], "capped", "{name}");
                assert_eq!(text, want["text"].as_str().unwrap(), "{name}");
                assert_eq!(pointer, want["pointer"].as_str().unwrap(), "{name}");
                assert_eq!(
                    original_tokens,
                    want["originalTokens"].as_i64().unwrap(),
                    "{name}"
                );
            }
            (r, _) => panic!("{name}: {r:?}"),
        }
    }
}

// --- media --------------------------------------------------------------------------------------------------------------

#[test]
fn media_vectors_replay() {
    for c in fixture("media").as_array().unwrap() {
        let units = (!c["units"].is_null()).then(|| MediaUnits {
            unit: if c["units"]["unit"] == "image" {
                MediaUnit::Image
            } else {
                MediaUnit::VideoSecond
            },
            quantity: num(&c["units"]["quantity"]),
        });
        let r = media_call_units(units);
        match c.get("error") {
            Some(_) => assert_eq!(
                r.unwrap_err().to_string(),
                c["message"].as_str().unwrap(),
                "{c}"
            ),
            None => {
                let want = MediaAmounts {
                    images: c["result"]
                        .get("images")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                    video_seconds: c["result"]
                        .get("videoSeconds")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                };
                assert_eq!(r.unwrap(), want, "{c}");
            }
        }
    }
}

// --- breach text --------------------------------------------------------------------------------------------------------

#[test]
fn breach_text_vectors_replay() {
    let f = fixture("breach");
    assert_eq!(f.as_array().unwrap().len(), 48);
    for c in f.as_array().unwrap() {
        let b = &c["breach"];
        let breach = Breach {
            scope: if b["scope"] == "global" {
                LimitScope::Global
            } else {
                LimitScope::Agent
            },
            agent_id: b.get("agentId").and_then(Value::as_str).map(str::to_owned),
            period: Period::parse(b["period"].as_str().unwrap()).unwrap(),
            metric: Metric::parse(b["metric"].as_str().unwrap()).unwrap(),
            limit: b["limit"].as_i64().unwrap(),
            used: b["used"].as_i64().unwrap(),
            estimate: b["estimate"].as_i64().unwrap(),
            period_key: b["periodKey"].as_str().unwrap().to_owned(),
            resets_at: b["resetsAt"].as_i64().unwrap(),
        };
        assert_eq!(describe_breach(&breach), c["text"].as_str().unwrap(), "{c}");
    }
}
