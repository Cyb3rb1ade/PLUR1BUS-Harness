use super::*;
use crate::toolcall::json::parse;
use serde_json::{json, Value};
use std::path::Path;

const NOW: i64 = 1_750_000_000_000;

fn policy(config: &V, target: &Target) -> Value {
    let s = settings(config, target, true).unwrap();
    json!({"enabled":s.policy.enabled,"windowDays":s.window_days,"maxSessions":s.policy.max_sessions,
        "maxTokens":s.policy.max_tokens,"focus":s.policy.focus})
}

#[test]
fn learning_configuration_and_utc_windows_match_typescript() {
    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/learn/config.json"
    ))
    .unwrap();
    let store = LearnStore::open(Path::new(":memory:")).unwrap();
    for row in fixture {
        let config = parse(row["config"].as_str().unwrap()).unwrap();
        let bindings = targets(&config);
        let windows = bindings
            .iter()
            .map(|t| window(NOW, settings(&config, t, true).unwrap().window_days))
            .collect::<Vec<_>>();
        let fallback = policy(
            &config,
            &Target {
                scope: "agent".into(),
                owner: "ada".into(),
                agent_id: "alpha".into(),
                project_id: None,
            },
        );
        let options = bindings
            .iter()
            .map(|t| policy(&config, t))
            .collect::<Vec<_>>();
        let stats = calibration(
            &store,
            "ada",
            &["small".into(), "large".into(), "small".into()],
        )
        .unwrap();
        let result = json!({"targets":bindings,"windows":windows,"settings":options,"fallback":fallback,"wake":next_run_at(&config,NOW),
            "calibration":serde_json::from_str::<Value>(&stats.stringify()).unwrap()});
        assert!(
            V::from_serde(&result).deep_equal(&V::from_serde(&row["expected"])),
            "{}\nactual {result}\nexpected {}",
            row["name"],
            row["expected"]
        );
    }
}
