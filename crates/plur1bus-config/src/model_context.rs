//! Shared configuration policy: the managed Apple identity is fixed; known small windows fence agent roles.
use serde_json::{Map, Value};

pub const MIN_CONTEXT_AGENT_ROLE: u64 = 16_384;

fn references<'a>(
    reference: Option<&'a Value>,
    profiles: Option<&'a Map<String, Value>>,
) -> Vec<&'a str> {
    let Some(reference) = reference.and_then(Value::as_str) else {
        return vec![];
    };
    let Some(profile) = profiles.and_then(|profiles| profiles.get(reference)) else {
        return vec![reference];
    };
    profile["candidates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|candidate| candidate["model"].as_str())
        .collect()
}

fn context_window(reference: &str, catalog: Option<&Value>) -> Option<u64> {
    if reference == "apple-fm/system" {
        return Some(4096);
    }
    catalog?["models"].as_array()?.iter().find_map(|model| {
        let name = format!("{}/{}", model["provider"].as_str()?, model["id"].as_str()?);
        // JSON Schema/TypeScript integers include integral decimal/exponent encodings.
        // Match Number.isSafeInteger rather than serde_json's lexical integer variant.
        (name == reference)
            .then(|| model["contextWindow"].as_f64())
            .flatten()
            .filter(|window| {
                *window > 0.0 && *window <= 9_007_199_254_740_991.0 && window.fract() == 0.0
            })
            .map(|window| window as u64)
    })
}

fn role_error(
    path: &str,
    reference: Option<&Value>,
    profiles: Option<&Map<String, Value>>,
    catalog: Option<&Value>,
) -> Vec<String> {
    let window = references(reference, profiles)
        .into_iter()
        .filter_map(|reference| context_window(reference, catalog))
        .filter(|window| *window < MIN_CONTEXT_AGENT_ROLE)
        .min();
    window.map(|window| vec![format!("{path} context-too-small: window {window} is below the {MIN_CONTEXT_AGENT_ROLE} agent-role floor")]).unwrap_or_default()
}

pub fn errors(config: &Value, catalog: Option<&Value>) -> Vec<String> {
    if config["providers"]
        .as_object()
        .is_some_and(|providers| providers.contains_key("apple-fm"))
    {
        return vec![
            "/providers/apple-fm reserved-provider-id: apple-fm is synthesized by the core".into(),
        ];
    }
    let profiles = config["modelProfiles"].as_object();
    let roles = config["modelRoles"].as_object();
    let agents = config["agents"].as_object();
    let classes = config["decision"]["classProfiles"].as_object();
    let direct = roles.into_iter().flat_map(|roles| roles.values()).chain(
        agents
            .into_iter()
            .flat_map(|agents| agents.values())
            .filter_map(|agent| agent.get("model")),
    );
    let mut refs: Vec<&str> = direct
        .flat_map(|reference| references(Some(reference), profiles))
        .collect();
    refs.extend(
        classes
            .into_iter()
            .flat_map(|classes| classes.values())
            .flat_map(|reference| references(Some(reference), profiles)),
    );
    refs.extend(
        profiles
            .into_iter()
            .flat_map(|profiles| profiles.values())
            .flat_map(|profile| profile["candidates"].as_array().into_iter().flatten())
            .filter_map(|candidate| candidate["model"].as_str()),
    );
    if refs
        .iter()
        .any(|reference| reference.starts_with("apple-fm/") && *reference != "apple-fm/system")
    {
        return vec!["/modelRoles model_not_allowed: apple-fm only allows system".into()];
    }
    for role in ["chat", "reasoning", "capture", "dream"] {
        let errors = role_error(
            &format!("/modelRoles/{role}"),
            roles.and_then(|roles| roles.get(role)),
            profiles,
            catalog,
        );
        if !errors.is_empty() {
            return errors;
        }
    }
    for reference in classes.into_iter().flat_map(|classes| classes.values()) {
        let errors = role_error(
            "/decision/classProfiles",
            Some(reference),
            profiles,
            catalog,
        );
        if !errors.is_empty() {
            return errors;
        }
    }
    let default = Value::String("default".into());
    for reference in std::iter::once(&default).chain(
        agents
            .into_iter()
            .flat_map(|agents| agents.values())
            .filter_map(|agent| agent.get("model")),
    ) {
        let errors = role_error("/modelProfiles", Some(reference), profiles, catalog);
        if !errors.is_empty() {
            return errors;
        }
    }
    vec![]
}

/// Configuration transactions use already recorded catalog facts; they never probe a model or repair the catalog.
pub fn assignment_errors(before: &Value, after: &Value, path: &std::path::Path) -> Vec<String> {
    let models = |config: &Value| {
        config["agents"]
            .as_object()
            .into_iter()
            .flat_map(|agents| agents.iter())
            .map(|(id, agent)| (id.clone(), agent["model"].clone()))
            .collect::<Vec<_>>()
    };
    if before["decision"]["classProfiles"] == after["decision"]["classProfiles"]
        && before["modelRoles"] == after["modelRoles"]
        && before["modelProfiles"] == after["modelProfiles"]
        && models(before) == models(after)
    {
        return vec![];
    }
    // Unavailable or corrupt catalog data supplies no generic window fact. Fixed Apple policy
    // remains enforceable, while the owner can still repair model assignments.
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return errors(after, None),
    };
    use std::io::Read;
    // Match the existing Core catalog reader/writer cap (MAX_CATALOG_BYTES).
    let mut bytes = Vec::new();
    if file
        .by_ref()
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > 16 * 1024 * 1024
    {
        return errors(after, None);
    }
    let Ok(catalog) = serde_json::from_slice::<Value>(&bytes) else {
        return errors(after, None);
    };
    errors(after, Some(&catalog))
}
