//! The config.json service: the same schema the TypeScript side uses (packages/config-schema), validated with the
//! `jsonschema` crate. In H1 the CLI calls this directly; in H2 the supervisor owns it and the CLI goes through config.*.
use serde_json::{Map, Value};
use std::{fs, io, path::Path};

pub const SCHEMA_JSON: &str =
    include_str!("../../../packages/config-schema/schema/config.schema.json");
pub type Config = Value;

#[derive(Debug)]
pub enum ConfigError {
    NotJson(String),
    Invalid(Vec<String>),
    Io(io::Error),
    UnknownKey(String),
}
impl From<io::Error> for ConfigError {
    fn from(e: io::Error) -> Self {
        ConfigError::Io(e)
    }
}
impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::NotJson(s) => write!(f, "not JSON: {s}"),
            ConfigError::Invalid(v) => write!(f, "invalid: {}", v.join("; ")),
            ConfigError::Io(e) => write!(f, "io: {e}"),
            ConfigError::UnknownKey(k) => write!(f, "unknown key: {k}"),
        }
    }
}
impl std::error::Error for ConfigError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartClass {
    Live,
    Core,
    Module,
}
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Restart {
    pub live: Vec<String>,
    pub core: bool,
    pub modules: Vec<String>,
}
/// The result of a recursive tree diff between two configs (see `restart_plan`), before it is
/// attached to a `Plan`'s `before`/`after`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChangePlan {
    pub changed: Vec<String>,
    pub restart: Restart,
}
#[derive(Debug, Clone)]
pub struct Plan {
    pub before: Config,
    pub after: Config,
    pub changed: Vec<String>,
    pub restart: Restart,
}
#[derive(Debug)]
pub struct Loaded {
    pub config: Config,
    pub created: bool,
}

fn schema() -> &'static Value {
    static S: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    S.get_or_init(|| serde_json::from_str(SCHEMA_JSON).expect("embedded schema"))
}
fn validator() -> &'static jsonschema::Validator {
    static V: std::sync::OnceLock<jsonschema::Validator> = std::sync::OnceLock::new();
    V.get_or_init(|| {
        jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .build(schema())
            .expect("schema compiles")
    })
}

pub fn validate(v: &Value) -> Result<(), Vec<String>> {
    let errs: Vec<String> = validator()
        .iter_errors(v)
        .map(|e| {
            let path = e.instance_path.to_string();
            format!(
                "{} {}",
                if path.is_empty() {
                    "/".to_string()
                } else {
                    path
                },
                e
            )
        })
        .collect();
    if errs.is_empty() {
        Ok(())
    } else {
        Err(errs)
    }
}

/// Defaults are read from the schema's `default` keywords, depth-first — the same values ajv's useDefaults fills in.
fn fill_defaults(node: &Value, into: &mut Value) {
    if let (Some(props), Some(obj)) = (
        node.get("properties").and_then(Value::as_object),
        into.as_object_mut(),
    ) {
        for (k, sub) in props {
            if !obj.contains_key(k) {
                if let Some(d) = sub.get("default") {
                    obj.insert(k.clone(), d.clone());
                }
            }
            if let Some(child) = obj.get_mut(k) {
                if child.is_object() {
                    fill_defaults(sub, child);
                }
            }
        }
    }
}

pub fn defaults() -> Config {
    let mut v = serde_json::json!({ "$schema": schema()["$id"], "schemaVersion": 1 });
    fill_defaults(schema(), &mut v);
    v
}

pub fn load(path: &Path) -> Result<Loaded, ConfigError> {
    if !path.exists() {
        let d = defaults();
        write_atomic(path, &d)?;
        return Ok(Loaded {
            config: d,
            created: true,
        });
    }
    let text = fs::read_to_string(path)?;
    let mut v: Value =
        serde_json::from_str(&text).map_err(|e| ConfigError::NotJson(e.to_string()))?;
    fill_defaults(schema(), &mut v); // the TS loader fills defaults through ajv useDefaults; do the same so both sides see one shape
    validate(&v).map_err(ConfigError::Invalid)?;
    Ok(Loaded {
        config: v,
        created: false,
    })
}

pub fn write_atomic(path: &Path, config: &Config) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    fs::write(
        &tmp,
        format!("{}\n", serde_json::to_string_pretty(config).unwrap()),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)) {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

pub fn restart_class_of(key: &str) -> RestartClass {
    let mut node = schema();
    let mut cls = node
        .get("x-restart")
        .and_then(Value::as_str)
        .unwrap_or("core");
    for part in key.split('.') {
        let next = node
            .get("properties")
            .and_then(|p| p.get(part))
            .or_else(|| node.get("additionalProperties").filter(|a| a.is_object()));
        match next {
            Some(n) => {
                node = n;
                if let Some(c) = n.get("x-restart").and_then(Value::as_str) {
                    cls = c;
                }
            }
            None => break,
        }
    }
    match cls {
        "live" => RestartClass::Live,
        c if c.starts_with("module:") => RestartClass::Module,
        _ => RestartClass::Core,
    }
}

fn module_name(key: &str) -> Option<String> {
    let mut node = schema();
    let mut cls: Option<&str> = None;
    for part in key.split('.') {
        match node
            .get("properties")
            .and_then(|p| p.get(part))
            .or_else(|| node.get("additionalProperties").filter(|a| a.is_object()))
        {
            Some(n) => {
                node = n;
                if let Some(c) = n.get("x-restart").and_then(Value::as_str) {
                    cls = Some(c);
                }
            }
            None => break,
        }
    }
    cls.and_then(|c| c.strip_prefix("module:"))
        .map(String::from)
}

/// Value equality matching TS's `JSON.stringify(a) === JSON.stringify(b)` for the leaf comparison
/// in `diff`: JS has one numeric type, so `1` and `1.0` stringify identically and must compare
/// equal here too, even though serde_json's derived `PartialEq` treats `Number::from(1)` and
/// `Number::from_f64(1.0)` as different. Two numbers compare equal when their exact i64/u64
/// values match (no precision loss for large integers) or, failing that, when their `f64` views
/// match. Everything else (objects, arrays, strings, bools, null, and any number/non-number pair)
/// falls back to `PartialEq`, which already matches `JSON.stringify` for those shapes.
fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            if let (Some(xi), Some(yi)) = (x.as_i64(), y.as_i64()) {
                return xi == yi;
            }
            if let (Some(xu), Some(yu)) = (x.as_u64(), y.as_u64()) {
                return xu == yu;
            }
            x.as_f64() == y.as_f64()
        }
        _ => a == b,
    }
}

/// Recursive tree diff between `a` and `b`, identical in shape to
/// `packages/config-schema/src/index.ts`'s `diff`: at each level, for every key in the union of
/// both sides, recurse when both values are plain objects (non-null, non-array); otherwise, if the
/// values differ (see `json_eq`), push the full dotted path. Additions and removals of an
/// open-map entry (e.g. `agents.bernd`) are therefore reported at the entry, symmetrically,
/// because a missing side is treated as absent rather than as an empty object.
fn diff(a: &Value, b: &Value, path: &mut Vec<String>, out: &mut Vec<String>) {
    let a_obj = matches!(a, Value::Object(_));
    let b_obj = matches!(b, Value::Object(_));
    if a_obj && b_obj {
        let am = a.as_object().unwrap();
        let bm = b.as_object().unwrap();
        let mut keys: std::collections::BTreeSet<&String> = am.keys().collect();
        keys.extend(bm.keys());
        for k in keys {
            path.push(k.clone());
            diff(
                am.get(k).unwrap_or(&Value::Null),
                bm.get(k).unwrap_or(&Value::Null),
                path,
                out,
            );
            path.pop();
        }
    } else if !json_eq(a, b) && !path.is_empty() {
        out.push(path.join("."));
    }
}

/// The restart plan for going from `before` to `after`: the dotted paths that changed (see
/// `diff`), and their classification per `restart_class_of`. Parity with the TypeScript
/// `restartPlan` in `packages/config-schema/src/index.ts` is asserted by
/// `tests/config.rs::restart_plan_matches_the_typescript_fixture_cases` against
/// `packages/config-schema/fixtures/restart-plan-cases.json`.
pub fn restart_plan(before: &Value, after: &Value) -> ChangePlan {
    let mut changed = Vec::new();
    diff(before, after, &mut Vec::new(), &mut changed);
    changed.sort();
    let mut restart = Restart::default();
    for k in &changed {
        match restart_class_of(k) {
            RestartClass::Live => restart.live.push(k.clone()),
            RestartClass::Core => restart.core = true,
            RestartClass::Module => {
                if let Some(m) = module_name(k) {
                    if !restart.modules.contains(&m) {
                        restart.modules.push(m);
                    }
                }
            }
        }
    }
    ChangePlan { changed, restart }
}

pub fn get(config: &Config, key: Option<&str>) -> Option<Value> {
    match key {
        None => Some(config.clone()),
        Some(k) => k.split('.').try_fold(config, |n, p| n.get(p)).cloned(),
    }
}

pub fn set(config: &Config, key: &str, value: Value) -> Result<Plan, ConfigError> {
    let mut after = config.clone();
    let parts: Vec<&str> = key.split('.').collect();
    let (last, dirs) = parts
        .split_last()
        .ok_or_else(|| ConfigError::UnknownKey(key.into()))?;
    let mut node = &mut after;
    for p in dirs {
        node = node
            .as_object_mut()
            .ok_or_else(|| ConfigError::UnknownKey(key.into()))?
            .entry(*p)
            .or_insert_with(|| Value::Object(Map::new()));
    }
    node.as_object_mut()
        .ok_or_else(|| ConfigError::UnknownKey(key.into()))?
        .insert((*last).to_string(), value);
    validate(&after).map_err(ConfigError::Invalid)?;
    let plan = restart_plan(config, &after);
    Ok(Plan {
        before: config.clone(),
        after,
        changed: plan.changed,
        restart: plan.restart,
    })
}
