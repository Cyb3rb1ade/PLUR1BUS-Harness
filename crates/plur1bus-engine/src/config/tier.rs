//! Settings tiers resolved from the nearest annotated harness-schema ancestor.

use super::Embedded;
use serde_json::Value;
use std::sync::OnceLock;

/// Settings presentation tier, shared with the harness configuration schema.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    /// Settings presented in the ordinary configuration view.
    Basic,
    /// Settings requiring the advanced configuration view.
    Advanced,
}

/// Resolve the nearest `x-tier` ancestor of a dotted harness path; unknown paths default to advanced.
/// All engine keys at the pinned contract inherit `engine`'s advanced tier.
pub fn tier_of(key: &str) -> Tier {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    let mut node = SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../packages/config-schema/schema/config.schema.json"
        ))
        .embedded("harness config schema")
    });
    let mut tier = annotation(node).unwrap_or(Tier::Advanced);
    for part in key.split('.') {
        let next = node
            .get("properties")
            .and_then(|properties| properties.get(part))
            .or_else(|| {
                node.get("additionalProperties")
                    .filter(|additional| additional.is_object())
            });
        let Some(next) = next else {
            break;
        };
        node = next;
        if let Some(annotation) = annotation(node) {
            tier = annotation;
        }
    }
    tier
}

fn annotation(node: &Value) -> Option<Tier> {
    node.get("x-tier").and_then(Value::as_str).map(|tier| {
        if tier == "basic" {
            Tier::Basic
        } else {
            Tier::Advanced
        }
    })
}
