//! Configuration disclosure policy: embedded declarations plus the installed modules' own schemas.
use crate::{modules, paths::Layout};
use serde_json::Value;
use std::collections::BTreeSet;
use std::{fmt, fs, io};

/// Metadata failures must never turn a public view into an unmasked fallback.
#[derive(Debug)]
pub enum ConfigRedactionError {
    RegistryUnavailable,
    ModulePolicyUnavailable(String),
}

impl fmt::Display for ConfigRedactionError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RegistryUnavailable => out.write_str(
                "configuration sensitivity metadata is unavailable; repair the installed module registry",
            ),
            Self::ModulePolicyUnavailable(name) => write!(
                out,
                "sensitivity metadata for module {name} is unavailable; repair its manifest or use direct property, map and item annotations"
            ),
        }
    }
}

impl std::error::Error for ConfigRedactionError {}

/// Content-based registry stamp detects repair, replacement and removal even on coarse filesystem clocks.
pub(crate) fn registry_stamp(layout: &Layout) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    match fs::read_dir(layout.home.join("modules")) {
        Ok(entries) => {
            let mut paths: Vec<_> = entries
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .filter(|entry| {
                    !entry.file_name().to_string_lossy().starts_with('.')
                        && !entry.file_name().to_string_lossy().contains(".tmp-")
                })
                .map(|entry| entry.path().join("module.json"))
                .collect();
            paths.sort();
            for path in paths {
                digest.update(path.as_os_str().as_encoded_bytes());
                match fs::read(path) {
                    Ok(bytes) => digest.update(bytes),
                    Err(error) => digest.update(format!("{:?}", error.kind()).as_bytes()),
                }
                digest.update([0]);
            }
        }
        Err(error) => digest.update(format!("{:?}", error.kind()).as_bytes()),
    }
    digest.finalize().into()
}

/// One immutable policy snapshot used by public output and, later, by the log/bundle registry.
pub struct ConfigDisclosurePolicy {
    modules: Vec<(String, Value)>,
}

impl ConfigDisclosurePolicy {
    pub fn load(layout: &Layout, config: &Value) -> Result<Self, ConfigRedactionError> {
        let Some(configured) = config
            .get("modules")
            .and_then(Value::as_object)
            .filter(|map| !map.is_empty())
        else {
            return Ok(Self {
                modules: Vec::new(),
            });
        };
        let entries = match fs::read_dir(layout.home.join("modules")) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Self {
                    modules: Vec::new(),
                })
            }
            Err(_) => return Err(ConfigRedactionError::RegistryUnavailable),
        };
        let mut policies = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|_| ConfigRedactionError::RegistryUnavailable)?;
            if !entry
                .file_type()
                .map_err(|_| ConfigRedactionError::RegistryUnavailable)?
                .is_dir()
            {
                continue;
            }
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if name.starts_with('.') || name.contains(".tmp-") || !configured.contains_key(&name) {
                continue;
            }
            let unavailable = || ConfigRedactionError::ModulePolicyUnavailable(name.clone());
            let raw =
                fs::read_to_string(entry.path().join("module.json")).map_err(|_| unavailable())?;
            let manifest = modules::parse_manifest(&raw).map_err(|_| unavailable())?;
            if manifest.name != name {
                return Err(unavailable());
            }
            if let Some(schema) = manifest.config_schema {
                if !plur1bus_config::supports_config_disclosure_policy(&schema) {
                    return Err(unavailable());
                }
                jsonschema::options()
                    .build(&schema)
                    .map_err(|_| unavailable())?;
                policies.push((name, schema));
            }
        }
        Ok(Self { modules: policies })
    }

    /// Validated schemas for configured installed modules; this snapshot performs no further filesystem reads.
    pub(crate) fn module_schemas(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.modules
            .iter()
            .map(|(name, schema)| (name.as_str(), schema))
    }

    /// Remove recognized module values before the Harness unknown-member fallback sees them.
    pub(crate) fn harness_config(&self, config: &Value) -> Value {
        let mut base = config.clone();
        if let Some(modules) = base.get_mut("modules").and_then(Value::as_object_mut) {
            for (name, _) in &self.modules {
                modules.remove(name);
            }
        }
        base
    }

    pub fn project(&self, config: &Value) -> Value {
        let base = self.harness_config(config);
        let mut public = plur1bus_config::redact_config(&base);
        for (name, schema) in &self.modules {
            if let Some(value) = config.get("modules").and_then(|modules| modules.get(name)) {
                let mut projected = plur1bus_config::redact_with_schema(value, schema);
                if let (Some(enabled), Some(object)) = (
                    value.get("enabled").filter(|value| value.is_boolean()),
                    projected.as_object_mut(),
                ) {
                    object.insert("enabled".into(), enabled.clone());
                }
                let value = projected;
                if let Some(modules) = public.get_mut("modules").and_then(Value::as_object_mut) {
                    modules.insert(name.clone(), value);
                }
            }
        }
        public
    }

    /// Complete validated references bypass the bundle's independent name and pattern backstops.
    pub fn reference_paths(&self, config: &Value) -> BTreeSet<String> {
        let schema: Value =
            serde_json::from_str(plur1bus_config::SCHEMA_JSON).expect("embedded schema");
        let mut paths: BTreeSet<_> =
            plur1bus_config::reference_paths_with_schema(&self.harness_config(config), &schema)
                .into_iter()
                .collect();
        for (name, schema) in &self.modules {
            if let Some(value) = config.get("modules").and_then(|modules| modules.get(name)) {
                let prefix = format!("/modules/{}", name.replace('~', "~0").replace('/', "~1"));
                paths.extend(
                    plur1bus_config::reference_paths_with_schema(value, schema)
                        .into_iter()
                        .map(|path| format!("{prefix}{path}")),
                );
            }
        }
        paths
    }

    /// Literals for unstructured output; declared reference metadata and endpoint host/path material stay public.
    pub fn secret_values(&self, config: &Value) -> Vec<String> {
        let mut values: BTreeSet<String> =
            plur1bus_config::config_text_secret_values(&self.harness_config(config))
                .into_iter()
                .collect();
        for (name, schema) in &self.modules {
            if let Some(value) = config.get("modules").and_then(|modules| modules.get(name)) {
                values.extend(plur1bus_config::secret_text_values_with_schema(
                    value, schema,
                ));
            }
        }
        values.into_iter().collect()
    }

    /// Bounded value-free reference guidance from the same configured installed module snapshot.
    pub fn reference_warnings(
        &self,
        config: &Value,
    ) -> Vec<plur1bus_config::ConfigReferenceWarning> {
        let mut warnings = plur1bus_config::config_reference_warnings(&self.harness_config(config));
        for (name, schema) in &self.modules {
            if let Some(value) = config.get("modules").and_then(|modules| modules.get(name)) {
                warnings.extend(
                    plur1bus_config::reference_warnings_with_schema(value, schema)
                        .into_iter()
                        .map(|mut warning| {
                            warning.key = if warning.key.is_empty() {
                                format!("modules.{name}")
                            } else {
                                format!("modules.{name}.{}", warning.key)
                            };
                            warning
                        }),
                );
            }
        }
        warnings.sort_by(|left, right| left.key.cmp(&right.key));
        warnings.dedup_by(|left, right| left.key == right.key);
        warnings.truncate(50);
        warnings
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_modules_use_original_values_and_each_owns_its_reference_definitions() {
        use serde_json::json;
        let schema = |prefix: &str| {
            json!({"type":"object","$defs":{"name":{"type":"string","pattern":format!("^{prefix}[.]constant$")}},"properties":{
                "label":{"type":"string"},
                "reference":{"type":"string","x-sensitive":true,"x-secret-reference":{"$ref":"#/$defs/name"}},
                "literal":{"type":"string","x-sensitive":true}
            }})
        };
        let secret = uuid::Uuid::new_v4().to_string();
        let config = json!({"modules":{
            "first":{"enabled":false,"label":"first public label","reference":"first.constant","literal":secret},
            "second":{"enabled":true,"label":"second public label","reference":"second.constant","literal":secret},
            "absent":{"literal":secret}
        }});
        let policy = ConfigDisclosurePolicy {
            modules: vec![
                ("first".into(), schema("first")),
                ("second".into(), schema("second")),
            ],
        };
        let projected = policy.project(&config);
        for name in ["first", "second"] {
            assert_eq!(
                projected["modules"][name]["label"],
                config["modules"][name]["label"]
            );
            assert_eq!(
                projected["modules"][name]["reference"],
                config["modules"][name]["reference"]
            );
            assert_eq!(
                projected["modules"][name]["enabled"],
                config["modules"][name]["enabled"]
            );
            assert_eq!(projected["modules"][name]["literal"], "••••");
        }
        assert_eq!(projected["modules"]["absent"]["literal"], "••••");
        assert_eq!(policy.secret_values(&config), [secret]);
        assert_eq!(
            policy.reference_paths(&config),
            [
                "/modules/first/reference".to_owned(),
                "/modules/second/reference".to_owned()
            ]
            .into_iter()
            .collect()
        );
    }

    #[test]
    fn direct_member_capabilities_match_the_typescript_vectors() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/config-schema/test/fixtures/disclosure-policies.json"
        ))
        .unwrap();
        for vector in vectors.as_array().unwrap() {
            assert_eq!(
                plur1bus_config::supports_config_disclosure_policy(&vector["schema"]),
                vector["supported"].as_bool().unwrap(),
                "{}",
                vector["name"]
            );
        }
    }
}
