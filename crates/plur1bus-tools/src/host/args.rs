use super::catalog::{Operation, Spec};
use super::{Config, Failure};
use serde_json::{Map, Value};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) fn validate<'a>(
    config: &Config,
    spec: Spec,
    raw: &'a Value,
) -> Result<&'a Map<String, Value>, Failure> {
    let input = raw
        .as_object()
        .ok_or_else(|| Failure::invalid("Expected an object."))?;
    for name in spec.required {
        if !input.contains_key(*name) {
            return Err(Failure::invalid(format!("{name} is required.")));
        }
    }
    for (key, value) in input {
        if !spec.required.contains(&key.as_str()) && !spec.optional.contains(&key.as_str()) {
            return Err(Failure::invalid(format!("Unknown argument: {key}.")));
        }
        match key.as_str() {
            "path" | "destination" | "cwd" | "target" | "program" => text(value, key, 1, 4096)?,
            "oldText" | "query" | "id" => text(value, key, 1, 65_536)?,
            "newText" | "content" | "text" | "command" => text(value, key, 0, 65_536)?,
            "title" => text(value, key, 1, 200)?,
            "body" => text(value, key, 0, 2000)?,
            "offset" => integer(value, key, 0, MAX_SAFE_INTEGER)?,
            "length" => integer(value, key, 0, config.output_bytes as u64)?,
            "depth" => integer(value, key, 0, 16)?,
            "limit" => {
                let max = if spec.operation == Operation::Search {
                    config.max_results as u64
                } else {
                    1000
                };
                integer(value, key, 0, max)?;
            }
            "timeoutMs" => integer(value, key, 1, config.timeout_ms as u64)?,
            "pid" => integer(value, key, 2, u64::from(i32::MAX as u32))?,
            "mode" if matches!(value.as_str(), Some("name" | "content")) => (),
            "signal" if value == "SIGTERM" => (),
            "eof" if value.is_boolean() => (),
            "args" => {
                let args = value
                    .as_array()
                    .filter(|items| items.len() <= 256)
                    .ok_or_else(|| Failure::invalid("Use at most 256 string arguments."))?;
                for arg in args {
                    text(arg, "args", 0, 65_536)?;
                }
            }
            "env" => {
                let env = value
                    .as_object()
                    .ok_or_else(|| Failure::invalid("env must be an object."))?;
                for (var, value) in env {
                    if !config.env_allow.iter().any(|name| name == var)
                        || forbidden_env(var)
                        || var.eq_ignore_ascii_case("PATH")
                        || var.eq_ignore_ascii_case("PATHEXT")
                    {
                        return Err(Failure::denied(
                            "Environment key is unavailable to a tool call.",
                        ));
                    }
                    text(value, "env", 0, 65_536)?;
                }
            }
            _ => return Err(Failure::invalid(format!("Invalid value for {key}."))),
        }
    }
    Ok(input)
}

fn text(value: &Value, field: &str, min: usize, max: usize) -> Result<(), Failure> {
    if value.as_str().is_some_and(|s| {
        !s.contains('\0') && (min..=max).contains(&s.encode_utf16().take(max + 1).count())
    }) {
        Ok(())
    } else {
        Err(Failure::invalid(format!("Invalid string for {field}.")))
    }
}

fn integer(value: &Value, field: &str, min: u64, max: u64) -> Result<(), Failure> {
    if value
        .as_f64()
        .is_some_and(|n| n.fract() == 0.0 && n >= min as f64 && n <= max as f64)
    {
        Ok(())
    } else {
        Err(Failure::invalid(format!(
            "Use an integer between {min} and {max} for {field}."
        )))
    }
}

pub(super) fn forbidden_env(name: &str) -> bool {
    crate::exec::env::is_secretish_name(name) || {
        let upper = name.to_ascii_uppercase();
        ["LD_", "DYLD_", "SUDO_", "BASH_FUNC_"]
            .iter()
            .any(|prefix| upper.starts_with(prefix))
            || upper.contains("PRIVATE")
            || matches!(
                upper.as_str(),
                "BASH_ENV"
                    | "ENV"
                    | "PYTHONPATH"
                    | "PYTHONHOME"
                    | "PYTHONSTARTUP"
                    | "PSMODULEPATH"
                    | "PERL5OPT"
                    | "PERL5LIB"
                    | "RUBYOPT"
                    | "RUBYLIB"
                    | "NODE_PATH"
                    | "_JAVA_OPTIONS"
                    | "CLASSPATH"
                    | "GIT_SSH_COMMAND"
                    | "GIT_EXTERNAL_DIFF"
                    | "LESSOPEN"
                    | "PROMPT_COMMAND"
                    | "GCONV_PATH"
                    | "_JAVA_TOOL_OPTIONS"
                    | "JAVA_TOOL_OPTIONS"
                    | "JDK_JAVA_OPTIONS"
                    | "SSH_ASKPASS"
                    | "NODE_OPTIONS"
            )
    }
}
