//! Replays `fixtures/parity/capabilities/*.json` (mode V, `scripts/parity/export-capabilities.ts`): the two math
//! functions bit for bit, the calibration file and the usage prior, and scripted operations against the index with every
//! answer as the text TypeScript printed.
use super::capabilities::{
    load_calibration, usage_prior, CapabilityEntry, CapabilityIndex, CapabilityStats,
    EmbeddingPort, LexicalPort, PriorPort, SearchFilters,
};
use super::json::V;
use super::math::{js_log, js_pow2};
use super::validation::Thrown;
use super::vectors::{expect, value_of};
use serde_json::Value;
use std::collections::HashMap;

pub(super) fn fixture(name: &str) -> Value {
    let text = match name {
        "math" => include_str!("../../../../fixtures/parity/capabilities/math.json"),
        "calibration" => include_str!("../../../../fixtures/parity/capabilities/calibration.json"),
        "index" => include_str!("../../../../fixtures/parity/capabilities/index.json"),
        other => panic!("no fixture {other}"),
    };
    serde_json::from_str(text).expect("fixture parses")
}

fn pair(case: &Value) -> (f64, f64) {
    let (x, y) = case.as_str().unwrap().split_once(':').unwrap();
    let bits = |hex: &str| f64::from_bits(u64::from_str_radix(hex, 16).unwrap());
    (bits(x), bits(y))
}

#[test]
fn math_log_is_fdlibm_bit_for_bit() {
    let f = fixture("math");
    let cases = f["log"].as_array().unwrap();
    assert!(cases.len() > 1000);
    for c in cases {
        let (x, want) = pair(c);
        let got = js_log(x);
        assert!(
            got.to_bits() == want.to_bits() || (got.is_nan() && want.is_nan()),
            "log({x:e}): {got:e} ({:016x}), TypeScript {want:e} ({:016x})",
            got.to_bits(),
            want.to_bits()
        );
    }
}

#[test]
fn math_pow2_of_an_integer_is_exact() {
    let f = fixture("math");
    for c in f["pow2"].as_array().unwrap() {
        let (x, want) = pair(c);
        assert_eq!(js_pow2(x).to_bits(), want.to_bits(), "2 ** {x:e}");
    }
}

fn number(v: &V, key: &str) -> f64 {
    v.get(key).and_then(V::as_f64).unwrap()
}

#[test]
fn calibration_file_and_usage_prior() {
    let f = fixture("calibration");
    let load = f["load"].as_array().unwrap();
    for (i, c) in load.iter().enumerate() {
        let content = c[0].as_str().unwrap();
        // The first case is the built-in default (no file).
        let got = load_calibration((i > 0).then_some(content));
        let printed = got.map(|config| {
            let source = if i > 0 {
                content
            } else {
                super::capabilities::CALIBRATION_DEFAULTS
            };
            // TypeScript returns the parsed object itself; its members are the configuration's seven numbers.
            let parsed = super::json::parse(source.trim_start_matches('\u{feff}'))
                .expect("an accepted file parses");
            for (key, want) in [
                ("minOffers", config.min_offers),
                ("maxBonus", config.max_bonus),
                ("maxPenalty", config.max_penalty),
                ("halfLifeDays", config.half_life_days),
                ("successTarget", config.success_target),
                ("successWeight", config.success_weight),
                ("searchWeight", config.search_weight),
            ] {
                assert_eq!(
                    number(&parsed, key).to_bits(),
                    want.to_bits(),
                    "{content}: {key}"
                );
            }
            parsed.stringify()
        });
        expect(&format!("calibration {content:?}"), &c[1], printed);
    }
    let stats = |text: &str| {
        let v = value_of(text);
        CapabilityStats {
            offered: number(&v, "offered"),
            used: number(&v, "used"),
            found_by_search: number(&v, "foundBySearch"),
            succeeded: number(&v, "succeeded"),
        }
    };
    for c in f["prior"].as_array().unwrap() {
        let config = load_calibration(Some(c[2].as_str().unwrap())).expect("a valid configuration");
        let got = usage_prior(
            &stats(c[0].as_str().unwrap()),
            &stats(c[1].as_str().unwrap()),
            &config,
        );
        assert_eq!(
            c[3].as_str().unwrap(),
            V::Num(got).stringify(),
            "prior of {} / {} with {}",
            c[0],
            c[1],
            c[2]
        );
    }
}

struct Table(HashMap<String, f64>);

impl EmbeddingPort for Table {
    fn score(&self, _query: &str, _entries: &[&CapabilityEntry]) -> HashMap<String, f64> {
        self.0.clone()
    }
}

fn table(world: &Value, key: &str) -> Option<HashMap<String, f64>> {
    world.get(key).map(|t| {
        t.as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_f64().unwrap()))
            .collect()
    })
}

fn filters_of(v: Option<&Value>) -> SearchFilters {
    let text = |key: &str| {
        v.and_then(|f| f.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    SearchFilters {
        category: text("category"),
        kind: text("kind"),
        effect: text("effect"),
        source: text("source"),
        limit: v.and_then(|f| f.get("limit")).and_then(Value::as_f64),
    }
}

#[test]
fn index_scenarios() {
    let f = fixture("index");
    for scenario in f["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let world = &scenario["world"];
        let embedding =
            table(world, "embedding").map(|t| Box::new(Table(t)) as Box<dyn EmbeddingPort>);
        let lexical = table(world, "lexical").map(|t| {
            Box::new(move |_query: &str, entries: &[&CapabilityEntry]| {
                entries
                    .iter()
                    .filter_map(|e| t.get(&e.id()).map(|score| (e.id(), *score)))
                    .collect()
            }) as LexicalPort
        });
        let prior = table(world, "prior").map(|t| {
            Box::new(move |e: &CapabilityEntry| t.get(&e.id()).copied().unwrap_or(0.0)) as PriorPort
        });
        let mut index = CapabilityIndex::new(embedding, lexical, prior);
        let ops = scenario["ops"].as_array().unwrap();
        for (i, (op, want)) in ops
            .iter()
            .zip(scenario["steps"].as_array().unwrap())
            .enumerate()
        {
            let null = || Ok("null".to_owned());
            let got: Result<String, Thrown> = match op["op"].as_str().unwrap() {
                "upsert" => index
                    .upsert(&value_of(op["entry"].as_str().unwrap()))
                    .and_then(|()| null()),
                "remove" => {
                    index.remove(op["id"].as_str().unwrap());
                    null()
                }
                "search" => index
                    .search(
                        op["query"].as_str().unwrap(),
                        &filters_of(op.get("filters")),
                    )
                    .map(|hits| V::Arr(hits.iter().map(|h| h.to_v()).collect()).stringify()),
                "route" => {
                    let distribution: Vec<(String, f64)> = op["distribution"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|p| (p[0].as_str().unwrap().to_owned(), p[1].as_f64().unwrap()))
                        .collect();
                    let top_k = op.get("topK").and_then(Value::as_f64).unwrap_or(12.0);
                    let confidence = op.get("confidence").and_then(Value::as_f64).unwrap_or(1.0);
                    index
                        .route(
                            op["query"].as_str().unwrap(),
                            &distribution,
                            top_k,
                            confidence,
                        )
                        .map(|r| r.to_v().stringify())
                }
                "prefix" => Ok(V::s(&index.categories_prefix()).stringify()),
                other => panic!("unknown op {other}"),
            };
            expect(&format!("{name} #{i} {op}"), want, got);
        }
    }
}
