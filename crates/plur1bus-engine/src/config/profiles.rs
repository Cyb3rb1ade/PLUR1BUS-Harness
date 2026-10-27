//! Pure feature-profile selection, safety policies, and setup status.

use super::Embedded;
use super::{
    effective_config, error, get_path, manifest_defaults, normalize, set_path, ConfigError,
};
use serde_json::{json, Value};
use std::sync::OnceLock;

fn features() -> &'static Value {
    static FEATURES: OnceLock<Value> = OnceLock::new();
    FEATURES.get_or_init(|| {
        let mut features: Value =
            serde_json::from_str(FEATURE_DEFINITIONS).embedded("feature descriptors");
        let defaults = manifest_defaults();
        for feature in features.as_array_mut().embedded("feature list") {
            let path = feature["path"]
                .as_array()
                .embedded("feature path")
                .iter()
                .map(|part| part.as_str().embedded("path segment"))
                .collect::<Vec<_>>();
            let default = get_path(&defaults, &path).cloned();
            if let Some(default) = default {
                feature["defaultValue"] = default;
            }
        }
        features
    })
}

fn path(feature: &Value) -> Vec<&str> {
    feature["path"]
        .as_array()
        .embedded("feature path")
        .iter()
        .map(|part| part.as_str().embedded("path segment"))
        .collect()
}

fn apply_values(config: &mut Value, encoded: &str, overwrite: bool) {
    let values: Value = serde_json::from_str(encoded).embedded("profile values");
    for assignment in values.as_array().embedded("assignments") {
        let path = assignment[0]
            .as_array()
            .embedded("path")
            .iter()
            .map(|part| part.as_str().embedded("path segment"))
            .collect::<Vec<_>>();
        if overwrite || get_path(config, &path).is_none() {
            set_path(config, &path, assignment[1].clone());
        }
    }
}

/// Clone the manifest-aligned feature descriptors, including their effective defaults.
pub fn list_core_features() -> Value {
    features().clone()
}

/// List every setup feature with no explicit value in the supplied configuration.
pub fn detect_missing_core_features(config: &Value) -> Value {
    Value::Array(
        features()
            .as_array()
            .embedded("features")
            .iter()
            .filter(|feature| get_path(config, &path(feature)).is_none())
            .cloned()
            .collect(),
    )
}

/// Build an explicit Safe profile with the Node mutator safety gates disabled.
pub fn safe_profile() -> Result<Value, Vec<ConfigError>> {
    let mut config = manifest_defaults();
    config["setupProfile"] = json!("safe");
    apply_values(&mut config, SAFE_VALUES, true);
    normalize(&config)
}

/// Build an explicit Recommended profile with the Node safety gates retained.
pub fn recommended_profile() -> Result<Value, Vec<ConfigError>> {
    let mut config = manifest_defaults();
    config["setupProfile"] = json!("recommended");
    for path in [
        "reranker.enabled",
        "emotion.t2.enabled",
        "emotion.t3.enabled",
        "metaCognition.enabled",
        "metaCognition.llmReport",
        "merging.enabled",
        "schicht15.enabled",
        "skillMiner.enabled",
        "dailyConsolidation.enabled",
        "criticalPush.enabled",
        "obsidianBridge.enabled",
        "obsidianBridge.allowWrite",
        "obsidianBridge.writeManagedBlocks",
        "obsidianBridge.semanticGraph.enabled",
        "obsidianBridge.adversarialDeep.llmClassifier",
        "obsidianBridge.morningReview.enabled",
        "obsidianBridge.eveningReview.enabled",
    ] {
        set_path(
            &mut config,
            &path.split('.').collect::<Vec<_>>(),
            json!(true),
        );
    }
    apply_values(&mut config, RECOMMENDED_SAFETY_VALUES, true);
    set_path(&mut config, &["schicht15", "maxPromotionsPerRun"], json!(3));
    normalize(&config)
}

/// Build a custom profile from feature booleans and shallow object overrides.
pub fn custom_profile_from_selection(selection: &Value) -> Result<Value, Vec<ConfigError>> {
    let mut config = safe_profile()?;
    config["setupProfile"] = json!("custom");
    if let Some(selection) = selection.as_object() {
        for (key, value) in selection {
            if key == "__proto__" {
                // The legacy JS setter ignores primitives and permits a null prototype;
                // object/array prototypes fail its plain-object check at the root.
                // Model those results without changing any Rust object prototype.
                if value.is_object() || value.is_array() {
                    return Err(vec![error("", "expected object, received object")]);
                }
                continue;
            }
            let feature = features()
                .as_array()
                .embedded("features")
                .iter()
                .find(|feature| feature["key"] == key.as_str());
            if let Some(feature) = feature {
                let path = path(feature);
                if value.is_boolean() {
                    set_path(&mut config, &path, value.clone());
                    continue;
                }
                if value.is_object() {
                    let parent = &path[..path.len() - 1];
                    let merged = shallow_merge(get_path(&config, parent), value);
                    if parent.is_empty() {
                        // Node's empty setPath writes its undefined leaf as this literal key.
                        // Retain the resulting validation failure for top-level object overrides.
                        config["undefined"] = merged;
                    } else {
                        set_path(&mut config, parent, merged);
                    }
                    continue;
                }
            }
            config[key] = if value.is_object() {
                shallow_merge(config.get(key), value)
            } else {
                value.clone()
            };
        }
    }
    normalize(&config)
}

/// Compatibility name for the explicit Recommended profile.
pub fn full_experience_defaults() -> Result<Value, Vec<ConfigError>> {
    recommended_profile()
}

/// Resolve the legacy full-experience policy through ordinary manifest defaults.
pub fn apply_full_experience_policy(config: &Value) -> Result<Value, Vec<ConfigError>> {
    if config.is_null() || config == false || config == "" || config.as_f64() == Some(0.0) {
        effective_config(&json!({}))
    } else {
        effective_config(config)
    }
}

fn shallow_merge(existing: Option<&Value>, next: &Value) -> Value {
    let mut merged = existing
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    merged
        .as_object_mut()
        .embedded("object")
        .extend(next.as_object().embedded("override object").clone());
    merged
}

/// Normalize legacy entry hooks and review aliases before a strict profile write.
pub fn normalize_plugin_entry_compatibility(
    entry: &Value,
    options: &Value,
) -> Result<Value, Vec<ConfigError>> {
    let mut entry = entry.clone();
    if !entry["config"].is_object() {
        entry["config"] = json!({});
    }
    if let Some(hooks) = entry["config"].get("hooks").cloned() {
        if !hooks.is_object() {
            return Err(vec![error("hooks", "expected object")]);
        }
        if entry.get("hooks").is_none() {
            entry["hooks"] = hooks;
        }
        entry["config"]
            .as_object_mut()
            .embedded("config")
            .remove("hooks");
    }
    if options["profileName"] == "recommended" {
        for key in ["backupBeforeApply", "auditLog"] {
            if entry["config"]["merging"][key] == false {
                entry["config"]["merging"][key] = json!(true);
            }
        }
    }
    let mut normalized = normalize(&entry["config"])?;
    for review in ["morningReview", "eveningReview"] {
        if let Some(value) = normalized.as_object_mut().embedded("config").remove(review) {
            set_path(&mut normalized, &["obsidianBridge", review], value);
        }
    }
    entry["config"] = normalized;
    Ok(entry)
}

fn merge_missing(target: &mut Value, defaults: &Value) {
    let (Some(target), Some(defaults)) = (target.as_object_mut(), defaults.as_object()) else {
        return;
    };
    for (key, value) in defaults {
        if let Some(existing) = target.get_mut(key) {
            merge_missing(existing, value);
        } else {
            target.insert(key.clone(), value.clone());
        }
    }
}

/// Apply an explicit profile to a cloned host document, retaining existing explicit values.
/// `options.confirmedAt` must be supplied by the caller's clock port; this function performs no IO.
pub fn apply_feature_profile(
    existing: &Value,
    profile: &Value,
    options: &Value,
) -> Result<Value, Vec<ConfigError>> {
    let mut merged = if existing.is_null() {
        json!({})
    } else {
        existing.clone()
    };
    for parts in [
        &["plugins"][..],
        &["plugins", "entries"],
        &["plugins", "entries", PLUGIN_KEY],
    ] {
        if !get_path(&merged, parts).is_some_and(Value::is_object) {
            set_path(&mut merged, parts, json!({}));
        }
    }
    let profile = normalize(profile)?;
    let name = profile["setupProfile"].as_str().unwrap_or_default();
    if !["safe", "recommended", "custom"].contains(&name) {
        return Err(vec![error("setupProfile", "explicit profile is required")]);
    }
    let entry_path = &["plugins", "entries", PLUGIN_KEY];
    let mut entry = normalize_plugin_entry_compatibility(
        get_path(&merged, entry_path).embedded("plugin entry"),
        &json!({"profileName":name}),
    )?;
    let mut config = entry["config"].clone();
    merge_missing(&mut config, &profile);
    if name == "safe" {
        apply_values(&mut config, SAFE_VALUES, true);
    } else if name == "recommended" {
        apply_values(&mut config, RECOMMENDED_SAFETY_VALUES, true);
    }
    if let Some(disabled) = options["disabledFeatures"].as_array() {
        for key in disabled {
            if let Some(feature) = features()
                .as_array()
                .embedded("features")
                .iter()
                .find(|feature| feature["key"] == *key)
            {
                set_path(&mut config, &path(feature), json!(false));
            }
        }
    }
    config["setupProfile"] = json!(name);
    let confirmed = options["confirmedAt"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            vec![error(
                "featuresConfirmedAt",
                "confirmation time must be supplied by the clock port",
            )]
        })?;
    config["featuresConfirmedAt"] = json!(confirmed);
    entry["enabled"] = json!(true);
    entry["config"] = normalize(&config)?;
    set_path(&mut merged, entry_path, entry);
    Ok(merged)
}

/// Report enabled but pending review delivery or vault-path confirmation.
pub fn detect_pending_features(config: &Value, options: &Value) -> Value {
    let bridge = &config["obsidianBridge"];
    let mut pending = Vec::new();
    for key in ["morningReview", "eveningReview"] {
        let review = &bridge[key];
        if review["enabled"] != false && review["status"] == "pending_setup" {
            pending.push(json!({"feature":key,"reason":"delivery_target_not_confirmed","explicit":review["enabled"] == true}));
        }
    }
    if bridge["enabled"] != false
        && bridge["requireVaultPathConfirmation"] == true
        && options["vaultConfirmed"] != true
    {
        pending.push(json!({"feature":"obsidianBridge","reason":"vault_path_not_confirmed","explicit":bridge["enabled"] == true}));
    }
    Value::Array(pending)
}

/// Return the setup apply gate and its pending features.
pub fn is_apply_blocked(config: &Value, options: &Value) -> Value {
    let pending = detect_pending_features(config, options);
    if pending.as_array().embedded("pending").is_empty() {
        json!({"blocked":false})
    } else {
        json!({"blocked":true,"reason":"pending_setup","pending":pending})
    }
}

/// Select log events for dormant feature reports; the host writes the returned levels and messages.
pub fn dormant_feature_events(reports: &Value) -> Value {
    Value::Array(reports.as_array().into_iter().flatten().filter_map(|report| {
        let message = report["message"].as_str().filter(|message| !message.is_empty())?;
        Some(json!({"level":if report["explicit"] == true {"warn"} else {"info"},"message":message}))
    }).collect())
}

/// Compare explicit feature booleans without materializing defaults.
pub fn describe_profile_diff(existing: &Value, profile: &Value) -> Value {
    let mut already = Vec::new();
    let mut newly = Vec::new();
    let mut disabled = Vec::new();
    for feature in features().as_array().embedded("features") {
        let path = path(feature);
        let value = get_path(profile, &path);
        let current = get_path(existing, &path);
        let key = feature["key"].clone();
        if value == Some(&json!(false)) {
            if current == Some(&json!(true)) {
                disabled.push(key);
            }
        } else if value == Some(&json!(true)) {
            if current == Some(&json!(true)) {
                already.push(key);
            } else {
                newly.push(key);
            }
        }
    }
    json!({"isUpdate":existing.as_object().is_some_and(|object| !object.is_empty()),"alreadyActive":already,"newlyActivated":newly,"disabled":disabled})
}

/// Partition feature descriptors into explicit active, explicit disabled and missing groups.
pub fn summarize_full_experience_status(config: &Value) -> Value {
    let mut active = Vec::new();
    let mut disabled = Vec::new();
    let mut missing = Vec::new();
    for feature in features().as_array().embedded("features") {
        match get_path(config, &path(feature)) {
            None => missing.push(feature.clone()),
            Some(value) if value == false => disabled.push(feature.clone()),
            Some(_) => active.push(feature.clone()),
        }
    }
    json!({"active":active,"disabled":disabled,"missing":missing})
}

/// Render the read-only start status using the pinned Node labels and default display paths.
pub fn render_start_status(config: &Value, options: &Value) -> String {
    let status = summarize_full_experience_status(config);
    let count = |key| status[key].as_array().embedded("status list").len();
    let mut lines = vec![
        "PLUR1BUS — Make your agent yours!".to_owned(),
        String::new(),
        format!(
            "Active: {}  Disabled: {}  New/missing: {}",
            count("active"),
            count("disabled"),
            count("missing")
        ),
        String::new(),
        "Active:".to_owned(),
    ];
    for (key, heading, suffix) in [
        ("active", "Active:", ""),
        ("disabled", "Disabled:", ""),
        ("missing", "New/missing:", " (follows manifest default)"),
    ] {
        if key != "active" {
            if count(key) == 0 {
                continue;
            }
            lines.extend([String::new(), heading.to_owned()]);
        }
        for feature in status[key].as_array().embedded("features") {
            lines.push(format!(
                "- {}{suffix}",
                feature["label"].as_str().embedded("label")
            ));
        }
    }
    let bridge = &config["obsidianBridge"];
    let display_path = |key, fallback: &str| {
        options[key]
            .as_str()
            .filter(|value| !value.is_empty())
            .or_else(|| bridge[key].as_str().filter(|value| !value.is_empty()))
            .unwrap_or(fallback)
            .to_owned()
    };
    lines.extend([
        String::new(),
        format!(
            "Obsidian: vaultPath={} workspaceRoot={} reviewRoot={}",
            display_path("vaultPath", "(auto-bootstrap)"),
            display_path("workspaceRoot", "(system-wide)"),
            display_path("reviewRoot", "plur1bus")
        ),
        format!(
            "Reviews: morning={} evening={} dashboard={}",
            if bridge["morningReview"]["enabled"] == false {
                "off"
            } else {
                "on"
            },
            if bridge["eveningReview"]["enabled"] == false {
                "off"
            } else {
                "on"
            },
            if bridge["dashboardLayer"]["enabled"] == false {
                "off"
            } else {
                "on"
            }
        ),
        String::new(),
        "Use /plur1bus enable|disable <feature>.".to_owned(),
    ]);
    lines.join("\n")
}

const PLUGIN_KEY: &str = "memory-lancedb-namespaced";
const FEATURE_DEFINITIONS: &str = r#"[{"key":"autoCapture","label":"Auto Capture","path":["autoCapture"]},{"key":"autoRecall","label":"Auto Recall","path":["autoRecall"]},{"key":"neo","label":"Neo Context Injection","path":["neo","enabled"]},{"key":"recallDedup","label":"Recall Dedup","path":["recall","dedup"]},{"key":"recallCanonicalFirst","label":"Canonical-First Recall","path":["recall","canonicalFirst"]},{"key":"temporalContext","label":"Temporal Continuity Context","path":["temporalContext","enabled"]},{"key":"embeddingCache","label":"Embedding Cache","path":["runtime","embeddingCacheEnabled"]},{"key":"llmResultCache","label":"LLM Result Cache","path":["runtime","llmResultCacheEnabled"]},{"key":"reranker","label":"Reranker","path":["reranker","enabled"]},{"key":"emotionT2","label":"Emotion Tier 2","path":["emotion","t2","enabled"]},{"key":"emotionT3","label":"Emotion Tier 3, provider-gated/fail-soft","path":["emotion","t3","enabled"]},{"key":"metaCognition","label":"Meta-Cognition","path":["metaCognition","enabled"]},{"key":"metaCognitionLlmReport","label":"Meta-Cognition LLM Report, budgeted/fail-soft","path":["metaCognition","llmReport"]},{"key":"merging","label":"Merging","path":["merging","enabled"]},{"key":"mergingAutoApply","label":"Low-risk Merge Auto-Apply","path":["merging","autoApply"]},{"key":"schicht15","label":"Schicht 1.5 Knowledge Promotion","path":["schicht15","enabled"]},{"key":"skillMiner","label":"Skill Miner","path":["skillMiner","enabled"]},{"key":"dailyConsolidation","label":"Daily Consolidation","path":["dailyConsolidation","enabled"]},{"key":"obsidianBridge","label":"Obsidian Bridge","path":["obsidianBridge","enabled"]},{"key":"morningReview","label":"Morning Review","path":["obsidianBridge","morningReview","enabled"]},{"key":"eveningReview","label":"Evening Review","path":["obsidianBridge","eveningReview","enabled"]},{"key":"dashboardLayer","label":"Dashboard Layer","path":["obsidianBridge","dashboardLayer","enabled"]},{"key":"semanticGraph","label":"Semantic Graph","path":["obsidianBridge","semanticGraph","enabled"]},{"key":"provenanceGraph","label":"Provenance Graph","path":["obsidianBridge","provenanceGraph","enabled"]},{"key":"adversarialDeep","label":"Adversarial Deep","path":["obsidianBridge","adversarialDeep","enabled"]},{"key":"criticalPush","label":"Critical Push, rate-limited","path":["criticalPush","enabled"]},{"key":"soulPatch","label":"SoulPatch","path":["obsidianBridge","soulPatch","enabled"]},{"key":"soulPatchCreateIfMissing","label":"SoulPatch createIfMissing","path":["obsidianBridge","soulPatch","createIfMissing"]},{"key":"soulPatchBackup","label":"SoulPatch backup","path":["obsidianBridge","soulPatch","backup"]}]"#;
const SAFE_VALUES: &str = r#"[[["reranker","enabled"],false],[["emotion","t3","enabled"],false],[["metaCognition","llmReport"],false],[["merging","enabled"],false],[["merging","autoApply"],false],[["schicht15","enabled"],false],[["skillMiner","enabled"],false],[["dailyConsolidation","enabled"],false],[["criticalPush","enabled"],false],[["obsidianBridge","enabled"],false],[["obsidianBridge","mode"],"augment"],[["obsidianBridge","allowWrite"],false],[["obsidianBridge","writeManagedBlocks"],false],[["obsidianBridge","dryRun"],true],[["obsidianBridge","requireVaultPathConfirmation"],true],[["obsidianBridge","autoApplyLowRisk"],false],[["obsidianBridge","dashboardLayer","enabled"],false],[["obsidianBridge","semanticGraph","enabled"],false],[["obsidianBridge","semanticGraph","proposalOnly"],true],[["obsidianBridge","semanticGraph","mutateMemory"],false],[["obsidianBridge","provenanceGraph","enabled"],false],[["obsidianBridge","adversarialDeep","enabled"],false],[["obsidianBridge","soulPatch","enabled"],false],[["obsidianBridge","soulPatch","createIfMissing"],false],[["obsidianBridge","morningReview","enabled"],false],[["obsidianBridge","eveningReview","enabled"],false]]"#;
const RECOMMENDED_SAFETY_VALUES: &str = r#"[[["reranker","timeoutMs"],5000],[["merging","autoApply"],false],[["merging","mode"],"safe-versioned"],[["merging","autoApplyRisk"],"low-only"],[["merging","backupBeforeApply"],true],[["merging","auditLog"],true],[["obsidianBridge","mode"],"augment"],[["obsidianBridge","dryRun"],true],[["obsidianBridge","requireVaultPathConfirmation"],true],[["obsidianBridge","autoApplyLowRisk"],false],[["obsidianBridge","semanticGraph","proposalOnly"],true],[["obsidianBridge","semanticGraph","mutateMemory"],false],[["obsidianBridge","morningReview","status"],"pending_setup"],[["obsidianBridge","eveningReview","status"],"pending_setup"]]"#;
