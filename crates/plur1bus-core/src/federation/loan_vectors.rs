use super::*;
use serde_json::{json, Value};

fn result<T: Serialize>(r: Result<T, Error>) -> Value {
    r.map_or_else(|error| json!({"error":error.0}), |value| json!(value))
}

#[test]
fn deadline_transitions_leases_and_views_match_typescript() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/federation/loan.json"
    ))
    .unwrap();
    for row in rows {
        let name = row["name"].as_str().unwrap();
        let offer = serde_json::from_value(row["offer"].clone()).unwrap();
        let side = serde_json::from_value(row["side"].clone()).unwrap();
        let initial = State::new(offer, side, row["now"].as_u64().unwrap());
        assert_eq!(
            result(initial.as_ref().map_err(|error| *error)),
            row["initial"],
            "{name}"
        );
        let Ok(mut state) = initial else {
            continue;
        };
        for record in row["steps"].as_array().unwrap() {
            let step = &record["step"];
            let now = step["at"].as_u64().unwrap();
            let kind = step["kind"].as_str().unwrap();
            let actual = match kind {
                "work" => json!({"allowed":state.work_allowed(step["project"].as_str(),now)}),
                "lender" => json!(state.lender_view()),
                "lease" => result(state.model_lease(now)),
                "event" | "renew" => {
                    let next = if kind == "renew" {
                        let lease = if step["previous"] == true {
                            Ok(state.lease().unwrap().clone())
                        } else {
                            state.model_lease(now).map(|lease| {
                                let mut raw = json!(lease);
                                if let Some(patch) = step["patch"].as_object() {
                                    raw.as_object_mut().unwrap().extend(patch.clone());
                                }
                                serde_json::from_value(raw).unwrap()
                            })
                        };
                        lease.and_then(|lease| state.transition(Event::Renew { lease }, now))
                    } else {
                        let event = serde_json::from_value(step["event"].clone()).unwrap();
                        state.transition(event, now)
                    };
                    match next {
                        Ok(next) => {
                            state = next;
                            json!(state)
                        }
                        Err(error) => json!({"error":error.0}),
                    }
                }
                _ => panic!("invalid fixture step"),
            };
            assert_eq!(actual, record["result"], "{name}: {step}");
        }
    }
}
