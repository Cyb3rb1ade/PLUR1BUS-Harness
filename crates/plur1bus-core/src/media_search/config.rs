//! Media catalog and pure validation of pending typed configuration.

use super::{Error, Kind};
use plur1bus_config::privacy_ack::{privacy_acknowledgment_error, PrivacyChoice, PrivacyFunction};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::OnceLock;

/// Provider catalogue result sourced from verified metadata.
#[derive(Debug, Deserialize)]
pub struct Model {
    /// Whether the configured provider stays local.
    pub local: bool,
    /// Input modalities.
    pub capabilities: Capabilities,
    /// Verified licence metadata.
    pub licence: Licence,
    /// Available native dimensions.
    pub dimensions: Vec<u64>,
}
/// Model capabilities.
#[derive(Debug, Deserialize)]
pub struct Capabilities {
    /// Text over media space.
    pub text: bool,
    /// Image encoding.
    pub image: bool,
    /// Video encoding.
    pub video: bool,
    /// Audio encoding.
    pub audio: bool,
}
/// Licence descriptor.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Licence {
    /// Identifier in the shared licence catalogue.
    pub id: String,
    /// Whether it requires an explicit acceptance.
    pub non_commercial: bool,
}
/// Runtime model catalogue and installed/accepted state.
pub trait Catalog {
    /// Resolve effective provider and model metadata.
    fn lookup(&self, provider: &str, model: &str) -> Option<Model>;
    /// Check recorded acceptance for this model.
    fn licence_accepted(&self, model: &str) -> bool;
    /// Check local installation or the configured route through a trusted port.
    fn available(&self, provider: &str, model: &str) -> bool;
}
/// Typed settings after schema validation and agent inheritance, when applicable.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    /// Whether the index is enabled.
    pub enabled: Option<bool>,
    /// Configured encoder.
    pub provider: Option<String>,
    /// Configured embedding model.
    pub model: Option<String>,
    /// Optional dimension override.
    pub dimensions: Option<u64>,
    /// Optional modalities (all when omitted).
    pub modalities: Option<Vec<Kind>>,
    /// Media-encoding consent.
    pub privacy_ack: Option<Value>,
    /// Caption choice, for separate validation.
    pub caption: Option<Caption>,
}
/// Configured caption route.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Caption {
    /// Caption precedence setting, including off.
    pub source: Option<String>,
    /// Configured caption provider.
    pub provider: Option<String>,
    /// Resolved model supplied by the trusted selector.
    pub model: Option<String>,
    /// Function-specific privacy consent.
    pub privacy_ack: Option<Value>,
}

fn schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| serde_json::from_str(plur1bus_config::SCHEMA_JSON).unwrap_or(Value::Null))
}
/// Installed schema owner for the production model catalogue.
pub fn builtin_catalog() -> &'static Value {
    &schema()["x-media-models"]
}
fn builtin_provider(provider: &str) -> bool {
    builtin_catalog()["providers"]
        .as_array()
        .is_some_and(|list| list.iter().any(|value| value == provider))
}
/// Fixed provider/model in the owned production catalogue.
pub fn builtin_model(provider: &str, model: &str) -> Option<Model> {
    if !builtin_provider(provider) {
        return None;
    }
    serde_json::from_value(builtin_catalog()["models"].get(model)?.clone()).ok()
}
/// Legacy load-only substitution of known local defaults.
pub fn for_load(config: &Value) -> Value {
    let Some(provider) = config["provider"]
        .as_str()
        .filter(|id| builtin_provider(id))
    else {
        return config.clone();
    };
    if config["enabled"].as_bool() == Some(false) {
        return config.clone();
    }
    let Some(settings) =
        schema().pointer("/properties/memory/properties/mediaEmbedding/properties")
    else {
        return config.clone();
    };
    let known = config["model"]
        .as_str()
        .and_then(|model| builtin_model(provider, model).map(|info| (model, info)));
    let selected = known.or_else(|| {
        let model = settings.pointer("/model/default")?.as_str()?;
        builtin_model(provider, model).map(|info| (model, info))
    });
    let Some((model, info)) = selected else {
        return config.clone();
    };
    let dimension = config["dimensions"]
        .as_u64()
        .filter(|n| info.dimensions.contains(n))
        .or_else(|| {
            settings
                .pointer("/dimensions/default")
                .and_then(Value::as_u64)
        });
    let mut effective = config.clone();
    effective["model"] = json!(model);
    effective["dimensions"] = json!(dimension);
    effective
}
/// Validate one effective embedding configuration.
pub fn embedding(selection: &Selection, catalog: &dyn Catalog, pinned: bool) -> Result<(), Error> {
    let Some(provider) = active_provider(selection.enabled, selection.provider.as_deref()) else {
        return Ok(());
    };
    let model = selection.model.as_deref().unwrap_or_default();
    let info = catalog_model(
        catalog,
        provider,
        model,
        pinned,
        PrivacyFunction::Media,
        selection.privacy_ack.as_ref(),
    )?;
    let kinds = selection
        .modalities
        .as_deref()
        .unwrap_or(&[Kind::Image, Kind::Video, Kind::Audio]);
    if !info.capabilities.text
        || kinds.iter().any(|kind| !match kind {
            Kind::Image => info.capabilities.image,
            Kind::Video => info.capabilities.video,
            Kind::Audio => info.capabilities.audio,
        })
    {
        return Err(Error::new("E_MEDIA_CAPABILITY", "media-kind-unsupported"));
    }
    if selection
        .dimensions
        .is_some_and(|dim| !info.dimensions.contains(&dim))
    {
        return Err(Error::new(
            "E_MEDIA_DIMENSION",
            "media-dimension-unsupported",
        ));
    }
    availability(catalog, provider, model, &info)
}
/// Validate one effective caption configuration.
pub fn caption(selection: &Selection, catalog: &dyn Catalog, pinned: bool) -> Result<(), Error> {
    let Some(settings) = selection
        .caption
        .as_ref()
        .filter(|c| c.source.as_deref() != Some("off"))
    else {
        return Ok(());
    };
    let Some(provider) = active_provider(selection.enabled, settings.provider.as_deref()) else {
        return Ok(());
    };
    let model = settings.model.as_deref().unwrap_or_default();
    let info = catalog_model(
        catalog,
        provider,
        model,
        pinned,
        PrivacyFunction::Caption,
        settings.privacy_ack.as_ref(),
    )?;
    availability(catalog, provider, model, &info)
}

/// Validate the shared configuration and each inherited, effective agent embedding choice without writing it.
pub fn validate_candidate(config: &Value, catalog: &dyn Catalog) -> Result<(), Error> {
    let candidate = plur1bus_config::validate_filled(config)
        .map_err(|_| Error::new("E_CONFIG_INVALID", "media-config-invalid"))?;
    let base = &candidate["memory"]["mediaEmbedding"];
    let pinned = crate::config::policy::local_only_shared(&candidate);
    let checked = |model: Value| {
        let selection: Selection = serde_json::from_value(model)
            .map_err(|_| Error::new("E_CONFIG_INVALID", "media-selection-invalid"))?;
        embedding(&selection, catalog, pinned)
    };
    checked(base.clone())?;
    for agent in candidate["agents"]
        .as_object()
        .into_iter()
        .flat_map(|agents| agents.values())
    {
        let Some(override_fields) = agent
            .pointer("/memory/mediaEmbedding")
            .and_then(Value::as_object)
        else {
            continue;
        };
        let mut effective = base.clone();
        if let Some(fields) = effective.as_object_mut() {
            fields.extend(override_fields.clone());
        }
        checked(effective)?;
    }
    Ok(())
}

fn active_provider(enabled: Option<bool>, provider: Option<&str>) -> Option<&str> {
    provider.filter(|provider| enabled != Some(false) && *provider != "off")
}

fn catalog_model(
    catalog: &dyn Catalog,
    provider: &str,
    model: &str,
    pinned: bool,
    function: PrivacyFunction,
    ack: Option<&Value>,
) -> Result<Model, Error> {
    let info = catalog
        .lookup(provider, model)
        .ok_or_else(|| Error::new("E_MEDIA_UNAVAILABLE", "unknown-provider"))?;
    if let Some(failure) = privacy_acknowledgment_error(&PrivacyChoice {
        function,
        provider,
        local: info.local,
        pinned,
        endpoint: None,
        ack,
    }) {
        return Err(Error::new(failure.code, failure.reason));
    }
    Ok(info)
}

fn availability(
    catalog: &dyn Catalog,
    provider: &str,
    model: &str,
    info: &Model,
) -> Result<(), Error> {
    if info.licence.non_commercial && !catalog.licence_accepted(model) {
        return Err(Error::new("E_MEDIA_LICENSE", "media-licence-unaccepted"));
    }
    if !catalog.available(provider, model) {
        return Err(Error::new("E_MEDIA_UNAVAILABLE", "not-available"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "config_vectors.rs"]
mod vectors;
