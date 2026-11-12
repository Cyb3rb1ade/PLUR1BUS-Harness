//! Frozen A1 catalog parity does not imply executable job bodies.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_engine::{contract::JobSpec, jobs};
use serde_json::Value;
#[test]
fn all_specs_match_the_actual_node_catalog_in_order() {
    let reference: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/job-catalog.json")).unwrap();
    let specs = jobs::catalog();
    assert_eq!(
        serde_json::to_value(&specs).unwrap(),
        reference["catalog"]["specs"]
    );
    let names: Vec<_> = specs.iter().map(|s| s.name.to_string()).collect();
    assert_eq!(
        serde_json::to_value(names).unwrap(),
        reference["catalog"]["names"]
    );
    let decoded: Vec<JobSpec> =
        serde_json::from_value(reference["catalog"]["specs"].clone()).unwrap();
    assert_eq!(decoded.len(), 20);
    let mut mutated = specs;
    mutated[0].default_schedule.as_mut().unwrap().expr.clear();
    assert_eq!(
        serde_json::to_value(jobs::catalog()).unwrap(),
        reference["catalog"]["specs"]
    );
}
