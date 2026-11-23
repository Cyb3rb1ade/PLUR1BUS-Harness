#![allow(
    clippy::unwrap_used,
    reason = "assertions over genuine TypeScript recordings"
)]

use plur1bus_discovery::roles::{self, Model};
use serde_json::{to_value, Value};

#[test]
fn model_role_resolution_prefers_the_right_provider_and_availability() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/discovery/roles.json"
    ))
    .unwrap();
    let models = serde_json::from_value::<Vec<Model>>(fixture["models"].clone()).unwrap();
    for case in fixture["selectors"].as_array().unwrap() {
        assert_eq!(
            to_value(roles::resolve(case["selector"].as_str().unwrap(), &models)).unwrap(),
            case["result"]
        );
    }
    let role_values = fixture["roles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| (pair[0].as_str().unwrap(), pair[1].as_str().unwrap()));
    for case in fixture["warnings"].as_array().unwrap() {
        assert_eq!(
            to_value(roles::warnings(
                &models,
                role_values.clone(),
                case["provider"].as_str()
            ))
            .unwrap(),
            case["result"]
        );
    }
}
