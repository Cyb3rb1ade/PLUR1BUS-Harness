use plur1bus_core::approvals::js_json::num_value;
use serde_json::{json, Value};

/// Host tool configuration, bounded before it can reach an executor.
#[derive(Clone, Debug)]
pub struct Config {
    pub(super) enabled: bool,
    pub(super) shell_allowed: bool,
    pub(super) shell: String,
    pub(super) timeout_ms: f64,
    pub(super) output_bytes: f64,
    pub(super) env_allow: Vec<String>,
    pub(super) deny_patterns: Vec<String>,
    pub(super) max_results: f64,
}

impl Default for Config {
    fn default() -> Self {
        Self::from_json(&Value::Null)
    }
}

impl Config {
    /// Parse optional overrides. Incorrectly typed values fall back to the default.
    pub fn from_json(input: &Value) -> Self {
        const ENV: &[&str] = &[
            "PATH",
            "LANG",
            "LC_ALL",
            "TZ",
            "TERM",
            "SystemRoot",
            "PATHEXT",
            "TEMP",
            "TMP",
        ];
        Self {
            enabled: input["enabled"].as_bool().unwrap_or(true),
            shell_allowed: input["shell"]["allowed"].as_bool().unwrap_or(false),
            shell: input["shell"]["default"]
                .as_str()
                .filter(|s| matches!(*s, "bash" | "zsh" | "pwsh"))
                .unwrap_or("bash")
                .to_owned(),
            timeout_ms: bounded(&input["exec"]["timeoutMs"], 30_000.0, 1.0, 300_000.0),
            output_bytes: bounded(&input["output"]["maxBytes"], 65_536.0, 32.0, 1_048_576.0),
            env_allow: strings(&input["env"]["allow"], ENV),
            deny_patterns: strings(&input["denyPatterns"], &[]),
            max_results: bounded(&input["search"]["maxResults"], 100.0, 1.0, 1000.0),
        }
    }

    /// The effective configuration in Hostctl wire form.
    pub fn to_json(&self) -> Value {
        json!({
            "enabled": self.enabled,
            "shell": {"allowed": self.shell_allowed, "default": self.shell},
            "exec": {"timeoutMs": num_value(self.timeout_ms)},
            "output": {"maxBytes": num_value(self.output_bytes)},
            "env": {"allow": self.env_allow},
            "denyPatterns": self.deny_patterns,
            "search": {"maxResults": num_value(self.max_results)},
        })
    }
}

fn bounded(value: &Value, default: f64, min: f64, max: f64) -> f64 {
    value.as_f64().map_or(default, |n| n.clamp(min, max))
}

fn strings(value: &Value, default: &[&str]) -> Vec<String> {
    value
        .as_array()
        .and_then(|values| values.iter().map(Value::as_str).collect::<Option<Vec<_>>>())
        .as_deref()
        .unwrap_or(default)
        .iter()
        .map(|s| (*s).to_owned())
        .collect()
}
