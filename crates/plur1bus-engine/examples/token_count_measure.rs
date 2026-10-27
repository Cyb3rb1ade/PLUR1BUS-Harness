//! Local RE-14/T2 measurement only: one warm-up and one 200-item batch per family, without timing gates.
#![allow(clippy::print_stdout)]

use plur1bus_engine::tokens::{CountRequest, TokenCounter, TokenMethod};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Instant;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let fixtures =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/engine-parity/goldens/tokens");
    let texts: Value = serde_json::from_slice(&std::fs::read(fixtures.join("texts.json"))?)?;
    let goldens: Value = serde_json::from_slice(&std::fs::read(fixtures.join("counts.json"))?)?;
    let texts = texts["texts"].as_array().ok_or("missing fixture texts")?;
    if texts.is_empty() {
        return Err("fixture texts must not be empty".into());
    }
    let started = Instant::now();
    let counter = match std::env::var_os("PLUR1BUS_TOKENIZER_DIR") {
        Some(root) => TokenCounter::from_directory(&PathBuf::from(root))?,
        None => TokenCounter::heuristic()?,
    };
    println!(
        "{}",
        json!({"phase":"load", "loadMicros":started.elapsed().as_micros(), "profile":if cfg!(debug_assertions) {"debug"} else {"release"}})
    );
    for family in counter.families() {
        let items: Vec<_> = (0..200)
            .map(|index| {
                json!({
                    "id":format!("item-{index}"), "text":texts[index % texts.len()]["text"]
                })
            })
            .collect();
        let request: CountRequest =
            serde_json::from_value(json!({"family":family.family,"items":items}))?;
        let _warmup = counter.count(&request)?;
        let started = Instant::now();
        let measured = counter.count(&request)?;
        let elapsed = started.elapsed();
        let mut differences = Vec::new();
        if measured.method == TokenMethod::Exact {
            for (index, count) in measured.items.iter().enumerate() {
                let id = &texts[index % texts.len()]["id"];
                let expected = goldens["cases"]
                    .as_array()
                    .ok_or("missing golden cases")?
                    .iter()
                    .find(|case| case["family"] == family.family && case["id"] == *id)
                    .and_then(|case| case["tokens"].as_u64())
                    .ok_or("missing exact golden")?;
                differences.push(count.tokens.abs_diff(expected));
            }
        }
        let deviation = if differences.is_empty() {
            Value::Null
        } else {
            json!({
                "maxAbsoluteTokens":differences.iter().max(),
                "meanAbsoluteTokens":differences.iter().sum::<u64>() as f64 / differences.len() as f64
            })
        };
        println!(
            "{}",
            json!({
                "family":family.family, "method":measured.method, "artifactState":family.artifact_state,
                "items":measured.items.len(), "warmupBatches":1, "measuredBatches":1,
                "countMicros":elapsed.as_micros(), "goldenDeviation":deviation
            })
        );
    }
    Ok(())
}
