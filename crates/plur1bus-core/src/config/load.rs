//! `config-load.ts`: the core reads `config.json` itself. [`load_config`] creates the defaults when the file is missing and
//! rewrites it (after a private backup) when an additive migration applies; [`read_config_file`] never writes. Both refuse a
//! file that is too large, unreadable, not JSON, nested too deeply or carrying a `__proto__` key, with texts that never
//! quote file content (the JSON parser's own message carries a snippet of the input, which can be a secret).
//!
//! [`validate_config`] is the TypeScript `validateConfig`: the structure scan, then `plur1bus_config::validate_filled` (the
//! schema and the cross-field rules of the TypeScript `validate`, shared with the CLI and the supervisor), then the
//! shared-engine privacy gate.
use super::policy::assert_shared_engine_privacy;
use plur1bus_config::{config_warnings, js_number, validate_filled, ConfigWarning};
use serde_json::{Map, Value};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// A real config.json is a few KB; anything beyond this is refused before it is read into memory.
pub const MAX_CONFIG_BYTES: u64 = 8 * 1024 * 1024;
const MAX_DEPTH: usize = 64;

/// Why a configuration could not be loaded. [`Invalid`](ConfigLoadError::Invalid) is the TypeScript `ConfigInvalid`.
#[derive(Debug)]
pub enum ConfigLoadError {
    /// `ConfigInvalid`: the file (or value) is not an acceptable configuration. `errors` never quote file content.
    Invalid {
        /// The path of the file.
        path: PathBuf,
        /// The error list.
        errors: Vec<String>,
    },
    /// A failure of the writes `load_config` performs (creating the defaults, the backup, the migration rewrite).
    Io(io::Error),
}

impl ConfigLoadError {
    fn invalid(path: &Path, errors: Vec<String>) -> Self {
        Self::Invalid {
            path: path.to_path_buf(),
            errors,
        }
    }

    /// The error list of an invalid configuration.
    pub fn errors(&self) -> &[String] {
        match self {
            Self::Invalid { errors, .. } => errors,
            Self::Io(_) => &[],
        }
    }
}

impl std::fmt::Display for ConfigLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid { path, errors } => {
                write!(f, "{}: {}", path.display(), errors.join("; "))
            }
            Self::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ConfigLoadError {}

impl From<io::Error> for ConfigLoadError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// Iterative (no stack use) scan for keys that poison merge consumers and for absurd nesting. At most 10 errors. Members
/// are visited in key order (`serde_json` sorts them), so with several forbidden keys the order of the messages can differ
/// from TypeScript's insertion order.
pub fn structure_errors(value: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    let mut stack: Vec<(&Value, String, usize)> = vec![(value, String::new(), 0)];
    while let Some((v, path, depth)) = stack.pop() {
        if errors.len() >= 10 {
            break;
        }
        if !matches!(v, Value::Object(_) | Value::Array(_)) {
            continue;
        }
        if depth > MAX_DEPTH {
            let shown = if path.is_empty() { "/" } else { path.as_str() };
            errors.push(format!("{shown} is nested deeper than {MAX_DEPTH} levels"));
            continue;
        }
        match v {
            Value::Array(items) => {
                for (i, x) in items.iter().enumerate() {
                    stack.push((x, format!("{path}/{i}"), depth + 1));
                }
            }
            Value::Object(map) => {
                for (k, x) in map {
                    if k == "__proto__" {
                        errors.push(format!("{path}/{k} is a forbidden key"));
                    } else {
                        stack.push((x, format!("{path}/{k}"), depth + 1));
                    }
                }
            }
            _ => {}
        }
    }
    errors
}

/// A validated configuration with the warnings `validate` reports for it.
#[derive(Debug, Clone, PartialEq)]
pub struct Validated {
    /// The configuration with the schema defaults filled in.
    pub config: Value,
    /// `configurationWarnings(config)`: bounded, value-free notices.
    pub warnings: Vec<ConfigWarning>,
}

/// `validateConfig` with the warnings of its `ok` result. Never panics: a value the schema walk cannot handle is reported
/// as invalid.
pub fn validate_config_with_warnings(value: &Value) -> Result<Validated, Vec<String>> {
    let bad = structure_errors(value);
    if !bad.is_empty() {
        return Err(bad);
    }
    let config = validate_filled(value)?;
    if let Err(e) = assert_shared_engine_privacy(&config, None) {
        return Err(vec![format!(
            "{}: {}",
            e.reason.as_deref().unwrap_or("local-only"),
            e.message
        )]);
    }
    let warnings = config_warnings(&config);
    Ok(Validated { config, warnings })
}

/// `validateConfig`: the validated configuration (schema defaults filled in) or the error list.
pub fn validate_config(value: &Value) -> Result<Value, Vec<String>> {
    validate_config_with_warnings(value).map(|v| v.config)
}

fn errno_code(e: &io::Error) -> &'static str {
    match e.raw_os_error() {
        Some(21) => return "EISDIR",
        Some(20) => return "ENOTDIR",
        Some(1) => return "EPERM",
        Some(5) => return "EIO",
        Some(24) => return "EMFILE",
        _ => {}
    }
    match e.kind() {
        io::ErrorKind::NotFound => "ENOENT",
        io::ErrorKind::PermissionDenied => "EACCES",
        _ => "error",
    }
}

/// V8's `position N` of a JSON syntax error is a UTF-16 index into the text; serde_json reports a line and column, from
/// which this derives the same index for the offending character. It is a diagnostic only: the two parsers do not always
/// stop at the same character.
fn syntax_position(text: &str, e: &serde_json::Error) -> Option<usize> {
    let (line, column) = (e.line(), e.column());
    if line == 0 || column == 0 {
        return None;
    }
    let mut start = 0usize;
    for _ in 1..line {
        start += text[start..].find('\n')? + 1;
    }
    let line_text = &text[start..];
    let line_end = line_text.find('\n').unwrap_or(line_text.len());
    let at = (start + (column - 1).min(line_end)).min(text.len());
    let at = (0..=at).rev().find(|i| text.is_char_boundary(*i))?;
    Some(text[..at].encode_utf16().count())
}

/// The file as parsed JSON. Failures are [`ConfigLoadError::Invalid`] with texts that never quote file content.
fn read_json(path: &Path) -> Result<Value, ConfigLoadError> {
    let too_large = || {
        ConfigLoadError::invalid(
            path,
            vec![format!("file too large (limit {MAX_CONFIG_BYTES} bytes)")],
        )
    };
    let unreadable = |e: &io::Error| {
        ConfigLoadError::invalid(path, vec![format!("not readable: {}", errno_code(e))])
    };
    let size = fs::metadata(path).map_err(|e| unreadable(&e))?.len();
    if size > MAX_CONFIG_BYTES {
        return Err(too_large());
    }
    let bytes = fs::read(path).map_err(|e| unreadable(&e))?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(too_large());
    }
    let text = String::from_utf8_lossy(&bytes);
    serde_json::from_str::<Value>(&text).map_err(|e| {
        if e.to_string().contains("recursion limit") {
            // serde_json refuses nesting beyond 128 levels itself; TypeScript parses it and the structure scan reports it.
            return ConfigLoadError::invalid(
                path,
                vec![format!("/ is nested deeper than {MAX_DEPTH} levels")],
            );
        }
        let at = syntax_position(&text, &e)
            .map(|n| format!(" (syntax error at position {n})"))
            .unwrap_or_default();
        ConfigLoadError::invalid(path, vec![format!("not JSON{at}")])
    })
}

/// The result of `migrate`.
struct Migrated {
    config: Value,
    from: f64,
    applied: bool,
}

/// `migrate` for schema version 1 (no registered migrations): a config that already says 1 gets an explicit empty
/// `modelProfiles` map (RULING C4: additive, no version bump), idempotently.
fn migrate(value: &Value) -> Migrated {
    let from = match value.get("schemaVersion") {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        // `Number(x)` of the other JSON values; none of them equals 1 and passes the schema, so only the error list matters.
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(f64::NAN),
        Some(Value::Bool(true)) => 1.0,
        Some(Value::Null) | Some(Value::Bool(false)) | None => 0.0,
        Some(_) => f64::NAN,
    };
    let mut config = value.clone();
    let additive = from == 1.0
        && config.as_object_mut().is_some_and(|o| {
            !o.contains_key("modelProfiles") && {
                o.insert("modelProfiles".into(), Value::Object(Map::new()));
                true
            }
        });
    Migrated {
        config,
        from,
        applied: additive,
    }
}

fn migrate_checked(path: &Path, raw: &Value) -> Result<Migrated, ConfigLoadError> {
    let bad = structure_errors(raw);
    if !bad.is_empty() {
        return Err(ConfigLoadError::invalid(path, bad));
    }
    Ok(migrate(raw))
}

/// `writeConfigAtomic`: a temporary file beside the target (created `0600` on Unix, a stale one of the same name does not
/// lend its permissions), written, synced and renamed over the target; no temporary file is left behind on failure.
pub fn write_config_atomic(path: &Path, config: &Value) -> io::Result<()> {
    plur1bus_config::write_atomic(path, config).map(|_| ())
}

/// A private copy (`0600`) of the file as it was before a migration rewrote it.
fn write_backup(path: &Path, from: f64) -> io::Result<()> {
    use std::io::Write;
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".bak-{}", js_number(from)));
    let bak = PathBuf::from(name);
    let _ = fs::remove_file(&bak);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&bak)?;
    file.write_all(&fs::read(path)?)?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&bak, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// `loadConfig` (H1: the core reads config.json itself): the configuration and whether the file was created. A missing
/// file is created with the defaults; a pre-C4 file is backed up (`config.json.bak-1`, `0600`) and rewritten migrated.
pub fn load_config(path: &Path) -> Result<(Value, bool), ConfigLoadError> {
    if !path.exists() {
        let defaults = plur1bus_config::defaults();
        write_config_atomic(path, &defaults)?;
        return Ok((defaults, true));
    }
    let migrated = migrate_checked(path, &read_json(path)?)?;
    let config = validate_config(&migrated.config)
        .map_err(|errors| ConfigLoadError::invalid(path, errors))?;
    if migrated.applied {
        write_backup(path, migrated.from)?;
        write_config_atomic(path, &config)?;
    }
    Ok((config, false))
}

/// `readConfigFile`: config.json as it is, never written (the supervisor owns it): the defaults when it is missing,
/// migrated in memory. Fails like [`load_config`].
pub fn read_config_file(path: &Path) -> Result<Value, ConfigLoadError> {
    if !path.exists() {
        return Ok(plur1bus_config::defaults());
    }
    let migrated = migrate_checked(path, &read_json(path)?)?;
    validate_config(&migrated.config).map_err(|errors| ConfigLoadError::invalid(path, errors))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    const MARK: &str = "zxq-plain-marker-value";

    fn file() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("config.json");
        (d, p)
    }

    fn invalid(r: Result<impl std::fmt::Debug, ConfigLoadError>) -> Vec<String> {
        match r {
            Err(e @ ConfigLoadError::Invalid { .. }) => e.errors().to_vec(),
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn creates_defaults_when_missing_and_loads_them_back() {
        let (_d, p) = file();
        let (first, created) = load_config(&p).unwrap();
        assert!(created);
        assert_eq!(first["schemaVersion"], 1);
        let on_disk: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(on_disk["core"]["recall"]["softBudgetMs"], 400);
        let (second, created) = load_config(&p).unwrap();
        assert!(!created);
        assert_eq!(second, first);
    }

    #[test]
    fn rejects_an_invalid_file_and_does_not_rewrite_it() {
        let (_d, p) = file();
        let raw = r#"{ "schemaVersion": 1, "core": { "logLevel": "loud" } }"#;
        fs::write(&p, raw).unwrap();
        assert!(invalid(load_config(&p))
            .iter()
            .any(|s| s.contains("logLevel")));
        assert_eq!(fs::read_to_string(&p).unwrap(), raw);
    }

    #[test]
    fn security_limits_are_rejected_without_rewriting() {
        let (_d, p) = file();
        for bad in [
            json!({"approvals": {"maxGrantDays": 366}}),
            json!({"breakglass": {"reasonMinChars": 501, "reasonMaxChars": 500}}),
            json!({"breakglass": {"maxWindowMinutes": 1441}}),
        ] {
            let mut v = json!({"schemaVersion": 1});
            v.as_object_mut()
                .unwrap()
                .extend(bad.as_object().unwrap().clone());
            let raw = v.to_string();
            fs::write(&p, &raw).unwrap();
            invalid(load_config(&p));
            assert_eq!(fs::read_to_string(&p).unwrap(), raw);
        }
    }

    #[test]
    fn a_json_syntax_error_never_echoes_file_content() {
        let (_d, p) = file();
        fs::write(
            &p,
            format!(r#"{{"channels": {{"telegram": {{"webhook": {{"secret": {MARK}}}}}}}}}"#),
        )
        .unwrap();
        for errors in [invalid(load_config(&p)), invalid(read_config_file(&p))] {
            assert!(!errors.join(",").contains(MARK));
        }
    }

    #[test]
    fn a_file_that_cannot_be_read_is_invalid() {
        let (_d, p) = file();
        fs::create_dir(&p).unwrap();
        invalid(load_config(&p));
        invalid(read_config_file(&p));
    }

    #[test]
    fn a_huge_file_is_refused_before_it_is_parsed() {
        let (_d, p) = file();
        fs::write(
            &p,
            format!(
                r#"{{"schemaVersion":1,"pad":"{}"}}"#,
                "a".repeat(9 * 1024 * 1024)
            ),
        )
        .unwrap();
        for errors in [invalid(load_config(&p)), invalid(read_config_file(&p))] {
            assert!(errors.iter().any(|s| s.contains("too large")));
        }
    }

    #[test]
    fn proto_keys_in_free_form_sections_are_refused() {
        let (_d, p) = file();
        fs::write(
            &p,
            r#"{"schemaVersion":1,"engine":{"__proto__":{"polluted":1}}}"#,
        )
        .unwrap();
        for errors in [invalid(load_config(&p)), invalid(read_config_file(&p))] {
            assert!(
                errors.iter().any(|s| s.contains("/engine/__proto__")),
                "{errors:?}"
            );
        }
        let nested: Value = serde_json::from_str(
            r#"{"schemaVersion":1,"modules":{"m":{"enabled":true,"deep":[{"__proto__":{}}]}}}"#,
        )
        .unwrap();
        assert!(validate_config(&nested).is_err());
    }

    #[test]
    fn absurd_nesting_is_invalid_not_a_stack_overflow() {
        let (_d, p) = file();
        let n = 200_000;
        fs::write(
            &p,
            format!(
                r#"{{"schemaVersion":1,"engine":{{"x":{}{}}}}}"#,
                "[".repeat(n),
                "]".repeat(n)
            ),
        )
        .unwrap();
        invalid(load_config(&p));
    }

    #[cfg(unix)]
    #[test]
    fn migration_backup_and_rewrite_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let (d, p) = file();
        let mut v = plur1bus_config::defaults();
        v.as_object_mut().unwrap().remove("modelProfiles");
        fs::write(&p, v.to_string()).unwrap();
        load_config(&p).unwrap();
        let bak = fs::read_dir(d.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .find(|n| n.contains(".bak-"))
            .expect("backup written");
        assert_eq!(
            fs::metadata(d.path().join(bak))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_loose_temp_file_does_not_make_config_world_readable() {
        use std::os::unix::fs::PermissionsExt;
        let (_d, p) = file();
        let tmp = PathBuf::from(format!("{}.tmp-{}", p.display(), std::process::id()));
        fs::write(&tmp, "stale").unwrap();
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o644)).unwrap();
        write_config_atomic(&p, &plur1bus_config::defaults()).unwrap();
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn a_failed_rename_leaves_no_temp_file_behind() {
        let (d, p) = file();
        fs::create_dir(&p).unwrap();
        assert!(write_config_atomic(&p, &plur1bus_config::defaults()).is_err());
        let left: Vec<_> = fs::read_dir(d.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    fn recall(soft: u64, hard: u64) -> Value {
        let mut c = plur1bus_config::defaults();
        c["core"]["recall"]["softBudgetMs"] = json!(soft);
        c["core"]["recall"]["hardBudgetMs"] = json!(hard);
        c
    }

    #[test]
    fn soft_above_hard_budget_is_refused_at_or_below_is_accepted() {
        for (soft, hard) in [(601, 600), (5000, 100), (1_000_000, 999_999)] {
            let e = validate_config(&recall(soft, hard)).unwrap_err();
            assert!(
                e.iter()
                    .any(|s| s == "/core/recall softBudgetMs must not exceed hardBudgetMs"),
                "{e:?}"
            );
        }
        for (soft, hard) in [(600, 600), (400, 600), (50, 100), (50, 50_000)] {
            assert!(
                validate_config(&recall(soft, hard)).is_ok(),
                "{soft} <= {hard}"
            );
        }
    }

    #[test]
    fn the_budget_rule_holds_for_a_file_with_defaults() {
        let (_d, p) = file();
        for patch in [json!({"softBudgetMs": 700}), json!({"hardBudgetMs": 300})] {
            fs::write(
                &p,
                json!({"schemaVersion": 1, "core": {"recall": patch}}).to_string(),
            )
            .unwrap();
            for errors in [invalid(load_config(&p)), invalid(read_config_file(&p))] {
                assert!(errors
                    .iter()
                    .any(|s| s.contains("softBudgetMs must not exceed hardBudgetMs")));
            }
        }
        fs::write(&p, json!({"schemaVersion": 1, "core": {"recall": {"softBudgetMs": 500, "hardBudgetMs": 800}}}).to_string()).unwrap();
        assert_eq!(
            load_config(&p).unwrap().0["core"]["recall"]["hardBudgetMs"],
            800
        );
    }

    #[test]
    fn structure_errors_name_proto_keys_and_pass_clean_values() {
        assert!(structure_errors(&json!({"schemaVersion": 1})).is_empty());
        let v: Value = serde_json::from_str(r#"{"a":{"__proto__":1}}"#).unwrap();
        assert!(structure_errors(&v).iter().any(|s| s.contains("__proto__")));
    }
}
