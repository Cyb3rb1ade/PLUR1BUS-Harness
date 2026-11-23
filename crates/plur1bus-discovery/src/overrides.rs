//! Validate and apply D112 catalogue overrides without reading or writing host state.

use std::collections::HashSet;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    reconcile::{Api, Catalog, Fields, Kind, Metadata, Model, Overrides, Source},
    roles::Status,
};

const KEYS: [&str; 5] = [
    "displayName",
    "kind",
    "contextWindow",
    "capabilities",
    "aliases",
];
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Deserialize)]
pub struct Request {
    pub provider: String,
    pub id: String,
    pub set: Option<Value>,
    pub clear: Option<Value>,
    #[serde(default)]
    pub create: bool,
}

#[derive(Debug, Serialize)]
pub struct Error {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

impl Error {
    fn invalid(field: &str) -> Self {
        Self {
            code: "invalid",
            field: Some(field.into()),
        }
    }
    fn conflict(field: Option<&str>) -> Self {
        Self {
            code: "conflict",
            field: field.map(str::to_owned),
        }
    }
}

type Result<T> = std::result::Result<T, Error>;

#[derive(Serialize)]
pub struct Updated {
    pub catalog: Catalog,
    pub entry: Model,
}

fn text_is_valid(text: &str) -> bool {
    !text.is_empty() && text.len() <= 512 && !text.chars().any(char::is_control)
}

fn field<T: DeserializeOwned>(values: &Map<String, Value>, key: &str) -> Result<Option<T>> {
    values
        .get(key)
        .map(|value| serde_json::from_value(value.clone()).map_err(|_| Error::invalid(key)))
        .transpose()
}

fn validate(set: &Value, request: &Request, catalog: &Catalog) -> Result<Overrides> {
    let set = set.as_object().ok_or_else(|| Error::invalid("set"))?;
    if let Some(unknown) = set.keys().find(|key| !KEYS.contains(&key.as_str())) {
        return Err(Error::invalid(unknown));
    }
    let display_name: Option<String> = field(set, "displayName")?;
    if display_name
        .as_ref()
        .is_some_and(|value| !text_is_valid(value))
    {
        return Err(Error::invalid("displayName"));
    }
    let kind = field(set, "kind")?;
    let context_window: Option<u64> = field(set, "contextWindow")?;
    if context_window.is_some_and(|value| value == 0 || value > SAFE_INTEGER) {
        return Err(Error::invalid("contextWindow"));
    }
    let capabilities = field(set, "capabilities")?;
    let aliases: Option<Vec<String>> = field(set, "aliases")?;
    if let Some(names) = &aliases {
        let mut seen = HashSet::new();
        if names.len() > 16
            || !names
                .iter()
                .all(|name| text_is_valid(name) && seen.insert(name))
        {
            return Err(Error::invalid("aliases"));
        }
        let conflict = catalog
            .models
            .iter()
            .filter(|model| model.provider == request.provider && model.id != request.id)
            .any(|model| {
                seen.contains(&model.id)
                    || model
                        .fields
                        .aliases
                        .iter()
                        .any(|alias| seen.contains(alias))
            });
        if conflict {
            return Err(Error::conflict(Some("aliases")));
        }
    }
    Ok(Overrides {
        display_name,
        kind,
        context_window,
        capabilities,
        aliases,
    })
}

fn clear_fields(current: &mut Overrides, clear: Option<&Value>) -> Result<()> {
    let Some(clear) = clear else {
        return Ok(());
    };
    if clear == "all" {
        *current = Overrides::default();
        return Ok(());
    }
    for key in clear.as_array().ok_or_else(|| Error::invalid("clear"))? {
        match key.as_str() {
            Some("displayName") => current.display_name = None,
            Some("kind") => current.kind = None,
            Some("contextWindow") => current.context_window = None,
            Some("capabilities") => current.capabilities = None,
            Some("aliases") => current.aliases = None,
            _ => return Err(Error::invalid("clear")),
        }
    }
    Ok(())
}

fn merge(current: Overrides, set: Overrides) -> Overrides {
    Overrides {
        display_name: set.display_name.or(current.display_name),
        kind: set.kind.or(current.kind),
        context_window: set.context_window.or(current.context_window),
        capabilities: set.capabilities.or(current.capabilities),
        aliases: set.aliases.or(current.aliases),
    }
}

fn manual_fields(id: &str, overrides: &Overrides) -> Fields {
    Fields {
        display_name: overrides.display_name.clone().unwrap_or_else(|| id.into()),
        kind: overrides.kind.unwrap_or(Kind::Unknown),
        context_window: overrides.context_window,
        capabilities: overrides.capabilities.clone().unwrap_or_default(),
        aliases: overrides.aliases.clone().unwrap_or_default(),
    }
}

pub fn apply(
    catalog: &Catalog,
    request: &Request,
    now: &str,
    metadata: &Metadata,
    vendor: Option<&str>,
) -> Result<Updated> {
    let mut overrides = Overrides::default();
    clear_fields(&mut overrides, request.clear.as_ref())?;
    let set = request.set.as_ref().map_or_else(
        || Ok(Overrides::default()),
        |set| validate(set, request, catalog),
    )?;
    let mut catalog = catalog.clone();
    if request.create {
        if !text_is_valid(&request.id) {
            return Err(Error::invalid("id"));
        }
        if catalog.models.iter().any(|model| {
            model.provider == request.provider
                && (model.id == request.id || model.fields.aliases.contains(&request.id))
        }) {
            return Err(Error::conflict(None));
        }
        let entry = Model {
            provider: request.provider.clone(),
            id: request.id.clone(),
            fields: manual_fields(&request.id, &set),
            status: Status::Manual,
            first_seen: now.into(),
            last_seen: now.into(),
            source: Source::Manual,
            overrides: set,
            api: None,
        };
        catalog.models.push(entry.clone());
        return Ok(Updated { catalog, entry });
    }
    let entry = catalog
        .models
        .iter_mut()
        .find(|model| model.provider == request.provider && model.id == request.id)
        .ok_or(Error {
            code: "not-found",
            field: None,
        })?;
    overrides = entry.overrides.clone();
    clear_fields(&mut overrides, request.clear.as_ref())?;
    entry.overrides = merge(overrides, set);
    if entry.source == Source::Manual {
        entry.fields = manual_fields(&entry.id, &entry.overrides);
    } else {
        (entry.fields, entry.source) = metadata.effective(
            vendor,
            &entry.id,
            entry.api.as_ref().unwrap_or(&Api::default()),
            &entry.overrides,
        );
    }
    let entry = entry.clone();
    Ok(Updated { catalog, entry })
}

pub fn remove_manual(catalog: &Catalog, provider: &str, id: &str) -> Result<Catalog> {
    let mut catalog = catalog.clone();
    let index = catalog
        .models
        .iter()
        .position(|entry| entry.provider == provider && entry.id == id)
        .ok_or(Error {
            code: "not-found",
            field: None,
        })?;
    if catalog.models[index].source != Source::Manual {
        return Err(Error {
            code: "not-manual",
            field: None,
        });
    }
    catalog.models.remove(index);
    Ok(catalog)
}
