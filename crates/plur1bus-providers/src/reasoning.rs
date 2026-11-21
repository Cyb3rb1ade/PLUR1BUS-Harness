//! Model reasoning levels and construction of the declared vendor directive.
use crate::ordered::obj;
use crate::{Json, ProviderError};

const LEVELS: [&str; 6] = ["off", "minimal", "low", "medium", "high", "xhigh"];

pub fn nearest_level<'a>(requested: &str, supported: &'a [&str]) -> Option<(&'a str, bool)> {
    let requested_index = LEVELS.iter().position(|&level| level == requested)?;
    supported
        .iter()
        .copied()
        .filter_map(|level| {
            LEVELS
                .iter()
                .position(|&candidate| candidate == level)
                .map(|i| (level, i))
        })
        .min_by_key(|&(_, i)| (requested_index.abs_diff(i), i))
        .map(|(level, _)| (level, level != requested))
}

/// The descriptor comes from the caller's selected model, so no catalog or network lookup occurs.
pub fn directive(level: &str, descriptor: &Json) -> Result<Option<Json>, ProviderError> {
    let kind = descriptor["kind"].text();
    let param = descriptor["vendorParam"].text();
    if kind == "none" || param.is_empty() {
        return Ok(None);
    }
    if !descriptor["levels"]
        .items()
        .iter()
        .any(|item| item.text() == level)
    {
        return Err(ProviderError::invalid(format!(
            "reasoning level {level} is not supported by this model"
        )));
    }
    let value = match kind {
        "budget" => {
            let budget = &descriptor["budget"];
            let (Some(min), Some(max)) = (budget["min"].number(), budget["max"].number()) else {
                return Err(ProviderError::invalid("budget reasoning needs bounds"));
            };
            let value = match level {
                "off" => 0.0,
                "minimal" => min,
                _ => {
                    let share = match level {
                        "low" => 0.125,
                        "medium" => 0.25,
                        "high" => 0.5,
                        _ => 1.0,
                    };
                    min.max(max.min((max * share / 256.0).floor() * 256.0))
                }
            };
            value.into()
        }
        "toggle" => descriptor["values"][level]
            .boolean()
            .unwrap_or(level != "off")
            .into(),
        _ => descriptor["values"]
            .get(level)
            .filter(|value| !matches!(value, Json::Null))
            .cloned()
            .unwrap_or_else(|| level.into()),
    };
    let mut directive = obj!("vendorParam": param, "value": value);
    if kind == "effort" && descriptor["adaptiveThinking"].boolean() == Some(true) {
        directive.set("adaptiveThinking", true);
    }
    Ok(Some(directive))
}
