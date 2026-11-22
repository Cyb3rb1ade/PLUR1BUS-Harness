#![allow(
    clippy::unwrap_used,
    reason = "assertions over genuine TypeScript recordings"
)]

use plur1bus_webtools::robots::Robots;
use serde_json::Value;

#[test]
fn crawl_directives_match_the_typescript_recording() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/webtools/robots.json"
    ))
    .unwrap();
    for vector in vectors["cases"].as_array().unwrap() {
        let robots = Robots::parse(vector["body"].as_str().unwrap()).unwrap();
        let agent = vector["agent"].as_str().unwrap();
        assert_eq!(
            robots.crawl_delay_seconds(agent),
            vector["expected"]["delay"].as_f64()
        );
        let actual: Vec<_> = vector["paths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|path| robots.allows(agent, path.as_str().unwrap()))
            .collect();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            vector["expected"]["decisions"]
        );
    }
}

#[test]
fn parser_refuses_a_body_above_the_byte_budget() {
    let max = 500 * 1024;
    assert!(Robots::parse(&" ".repeat(max)).is_ok());
    assert!(Robots::parse(&" ".repeat(max + 1)).is_err());
}
