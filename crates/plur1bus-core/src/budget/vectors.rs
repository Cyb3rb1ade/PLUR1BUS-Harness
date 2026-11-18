//! Replays `fixtures/parity/budget/*.json` (mode V, `scripts/parity/export-budget.ts`) against the Rust port.
//!
//! Time zones: `plur1bus-core` has no time-zone database, so the period vectors run against a rule-based [`Zones`] double
//! (UTC, Europe/Berlin, America/Los_Angeles, Asia/Kolkata, Pacific/Kiritimati, Etc/GMT+12). The zones whose rules this double does
//! not model are named in [`UNMODELLED`]; the test asserts that list equals what the fixture holds beyond the double, so a
//! vector is never skipped without being named. They replay once the production adapter over a database exists.
use super::calls::MediaAmounts;
use super::context::{
    allocate_context, check_zones, ContextAllocation, ZoneCheck, ZonePolicy, ZoneShare, ZONES,
};
use super::media::{media_call_units, MediaUnit, MediaUnits};
use super::period::{period_bounds, validate_time_zone, CallPeriod, LocalDate, Period, Zones};
use super::retry::{
    RetryBudget, RetryClass, RetryError, RetryPolicy, RetryRule, CLASSES, DEFAULT_RETRY_TURN_TOKENS,
};
use super::service::{describe_breach, Breach, LimitScope, Metric};
use super::subagent::{
    cap_subagent_result, CappedSubagentResult, SubagentCapOptions, SubagentResultPort,
};
use super::weight::{counted_tokens, stored_cache_read_weight, validate_cache_read_weight};
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

// --- the zone double ----------------------------------------------------------------------------------------------------

const DAY_MS: i64 = 86_400_000;
const MODELLED: [&str; 6] = [
    "utc",
    "europe/berlin",
    "america/los_angeles",
    "asia/kolkata",
    "pacific/kiritimati",
    "etc/gmt+12",
];
/// Zones the period vectors hold that the double does not model.
const UNMODELLED: [&str; 3] = ["America/Sao_Paulo", "Australia/Lord_Howe", "Pacific/Apia"];

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// 0 is Sunday.
fn weekday(days: i64) -> i64 {
    (days + 4).rem_euclid(7)
}

fn last_sunday(y: i64, m: i64) -> i64 {
    let last = days_from_civil(y, m + 1, 1) - 1;
    last - weekday(last)
}

fn nth_sunday(y: i64, m: i64, n: i64) -> i64 {
    let first = days_from_civil(y, m, 1);
    first + (7 - weekday(first)) % 7 + 7 * (n - 1)
}

pub(super) struct RuleZones;

impl RuleZones {
    fn offset_minutes(zone: &str, ts: i64) -> Option<i64> {
        let year = civil_from_days(ts.div_euclid(DAY_MS)).0;
        Some(match zone.to_ascii_lowercase().as_str() {
            "utc" => 0,
            "asia/kolkata" => 330,
            "pacific/kiritimati" => 840,
            "etc/gmt+12" => -720,
            "europe/berlin" => {
                let start = last_sunday(year, 3) * DAY_MS + 3_600_000;
                let end = last_sunday(year, 10) * DAY_MS + 3_600_000;
                if (start..end).contains(&ts) {
                    120
                } else {
                    60
                }
            }
            "america/los_angeles" => {
                let start = nth_sunday(year, 3, 2) * DAY_MS + 10 * 3_600_000;
                let end = nth_sunday(year, 11, 1) * DAY_MS + 9 * 3_600_000;
                if (start..end).contains(&ts) {
                    -420
                } else {
                    -480
                }
            }
            _ => return None,
        })
    }
}

impl Zones for RuleZones {
    fn is_valid(&self, zone: &str) -> bool {
        MODELLED.contains(&zone.to_ascii_lowercase().as_str())
    }

    fn local_date(&self, ts_ms: i64, zone: &str) -> Option<LocalDate> {
        if ts_ms.abs() > 8_640_000_000_000_000 {
            return None;
        }
        let off = Self::offset_minutes(zone, ts_ms)?;
        let (y, m, d) = civil_from_days((ts_ms + off * 60_000).div_euclid(DAY_MS));
        Some(LocalDate {
            y: y as i32,
            m: m as u32,
            d: d as u32,
        })
    }
}

// --- periods ------------------------------------------------------------------------------------------------------------

#[test]
fn period_vectors_replay_for_the_modelled_zones() {
    let f = fixture("period");
    let mut unmodelled = BTreeSet::new();
    let mut replayed = 0;
    for row in f["rows"].as_array().unwrap() {
        let zone = row[0].as_str().unwrap();
        if !MODELLED.contains(&zone.to_ascii_lowercase().as_str()) {
            unmodelled.insert(zone.to_owned());
            continue;
        }
        let period = CallPeriod::parse(row[1].as_str().unwrap()).expect("period");
        let ts = row[2].as_i64().unwrap();
        let b =
            period_bounds(&RuleZones, ts, zone, period).unwrap_or_else(|e| panic!("{row}: {e}"));
        assert_eq!(
            (b.key.as_str(), b.start, b.end),
            (
                row[3].as_str().unwrap(),
                row[4].as_i64().unwrap(),
                row[5].as_i64().unwrap()
            ),
            "{row}"
        );
        replayed += 1;
    }
    assert!(replayed > 800, "replayed {replayed}");
    assert_eq!(
        unmodelled.into_iter().collect::<Vec<_>>(),
        UNMODELLED.to_vec(),
        "unmodelled zones are exactly the named ones"
    );
}

#[test]
fn period_error_and_validation_vectors_replay() {
    let f = fixture("period");
    for e in f["errors"].as_array().unwrap() {
        let r = period_bounds(
            &RuleZones,
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
                validate_time_zone(&RuleZones, zone).unwrap(),
                ok.as_str().unwrap(),
                "{v}"
            ),
            (None, Some(m)) => assert_eq!(
                validate_time_zone(&RuleZones, zone)
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
