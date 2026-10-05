use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

const PLUGIN_ID: &str = "memory-lancedb-namespaced";

#[derive(Clone, Debug)]
pub(crate) struct HostEnvironment {
    vars: HashMap<String, String>,
    homedir: PathBuf,
    platform: String,
}

impl HostEnvironment {
    pub(crate) fn current() -> Self {
        Self {
            vars: std::env::vars_os()
                .map(|(key, value)| {
                    (
                        key.to_string_lossy().into_owned(),
                        value.to_string_lossy().into_owned(),
                    )
                })
                .collect(),
            homedir: home::home_dir()
                .or_else(|| std::env::current_dir().ok())
                .unwrap_or_else(|| PathBuf::from(".")),
            platform: if cfg!(windows) {
                "win32".to_string()
            } else if cfg!(target_os = "macos") {
                "darwin".to_string()
            } else {
                "linux".to_string()
            },
        }
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn injected(
        vars: HashMap<String, String>,
        homedir: PathBuf,
        platform: &str,
    ) -> Self {
        Self {
            vars,
            homedir,
            platform: platform.to_string(),
        }
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.vars
            .get(name)
            .or_else(|| {
                (self.platform == "win32")
                    .then(|| {
                        self.vars
                            .iter()
                            .find(|(key, _)| key.eq_ignore_ascii_case(name))
                            .map(|(_, value)| value)
                    })
                    .flatten()
            })
            .map(String::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::trim)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoreViolation {
    pub(crate) store_path: PathBuf,
    pub(crate) state_root: PathBuf,
}

impl StoreViolation {
    pub(crate) fn message(&self) -> String {
        format!(
            "Harness store path {} is inside OpenClaw state directory {}; choose a path under the harness home",
            self.store_path.display(),
            self.state_root.display()
        )
    }
}

fn openclaw_home(env: &HostEnvironment) -> PathBuf {
    let os_home = env
        .get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| env.homedir.clone());
    let value = env
        .get("OPENCLAW_HOME")
        .map(|path| expand_tilde(path, &os_home))
        .unwrap_or(os_home);
    absolute(&value)
}

fn state_root(env: &HostEnvironment) -> PathBuf {
    let home = openclaw_home(env);
    if let Some(path) = env.get("OPENCLAW_STATE_DIR") {
        return absolute(&expand_tilde(path, &home));
    }
    if let Some(profile) = openclaw_profile(env) {
        return home.join(format!(".openclaw-{profile}"));
    }
    let fresh = home.join(".openclaw");
    let legacy = home.join(".clawdbot");
    if !fresh.is_dir() && legacy.is_dir() {
        legacy
    } else {
        fresh
    }
}

fn openclaw_profile(env: &HostEnvironment) -> Option<&str> {
    env.get("OPENCLAW_PROFILE").filter(|profile| {
        let bytes = profile.as_bytes();
        !profile.eq_ignore_ascii_case("default")
            && !bytes.is_empty()
            && bytes.len() <= 64
            && bytes[0].is_ascii_alphanumeric()
            && bytes[1..]
                .iter()
                .all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
    })
}

fn expand_tilde(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return home.join(rest);
    }
    PathBuf::from(path)
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

fn canonical_or_resolved(path: &Path) -> PathBuf {
    let path = lexical_normalize(&absolute(path));
    let mut existing = path.as_path();
    let mut suffix = Vec::new();
    while fs::canonicalize(existing).is_err() {
        let Some(name) = existing.file_name() else {
            return path;
        };
        suffix.push(name.to_os_string());
        let Some(parent) = existing.parent() else {
            return path;
        };
        existing = parent;
    }
    let mut resolved = fs::canonicalize(existing).unwrap_or_else(|_| existing.to_path_buf());
    for component in suffix.iter().rev() {
        resolved.push(component);
    }
    lexical_normalize(&resolved)
}

fn comparison_path(path: &Path, platform: &str) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    let value = value.trim_end_matches('/');
    if platform == "win32" || platform == "darwin" {
        value.to_lowercase()
    } else {
        value.to_string()
    }
}

fn is_within(path: &Path, root: &Path, platform: &str) -> bool {
    let path = comparison_path(path, platform);
    let root = comparison_path(root, platform);
    path == root
        || path
            .strip_prefix(&root)
            .is_some_and(|tail| tail.starts_with('/'))
}

fn has_marker(root: &Path) -> bool {
    root.join("openclaw.json").is_file() || root.join("clawdbot.json").is_file()
}

fn marker_ancestors(path: &Path) -> Vec<PathBuf> {
    path.ancestors()
        .filter(|root| has_marker(root))
        .map(Path::to_path_buf)
        .collect()
}

fn plugin_store_roots(path: &Path) -> Vec<PathBuf> {
    path.ancestors()
        .filter(|store| {
            store.file_name().is_some_and(|name| {
                name.to_string_lossy()
                    .eq_ignore_ascii_case("lancedb-namespaced")
            }) && store
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("memory"))
        })
        .filter_map(|store| store.parent()?.parent().map(Path::to_path_buf))
        .collect()
}

pub(crate) fn store_violation(config: &Value, env: &HostEnvironment) -> Option<StoreViolation> {
    let configured = config.get("engine")?.get("baseDbPathOverride")?.as_str()?;
    let home = env
        .get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| env.homedir.clone());
    let store_path = canonical_or_resolved(&expand_tilde(configured.trim(), &home));
    let root = state_root(env);
    let explicit_root = env.get("OPENCLAW_STATE_DIR").is_some() || openclaw_profile(env).is_some();
    let mut roots = marker_ancestors(&store_path);
    if root.is_dir()
        && (explicit_root
            || has_marker(&root)
            || root.join("memory").join("lancedb-namespaced").exists())
    {
        roots.push(root.clone());
    }
    roots.extend(plugin_store_roots(&store_path));
    roots
        .into_iter()
        .map(|path| canonical_or_resolved(&path))
        .find(|state_root| is_within(&store_path, state_root, &env.platform))
        .map(|state_root| StoreViolation {
            store_path,
            state_root,
        })
}

pub(crate) fn openclaw_plugin_found(env: &HostEnvironment) -> bool {
    let config_path = state_root(env).join("openclaw.json");
    let Ok(text) = fs::read_to_string(config_path) else {
        return false;
    };
    let Ok(config) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    config
        .get("plugins")
        .and_then(|plugins| plugins.get("entries"))
        .and_then(|entries| entries.get(PLUGIN_ID))
        .is_some()
}

pub(crate) fn host_mode_notice(env: &HostEnvironment) -> Option<&'static str> {
    openclaw_plugin_found(env).then_some(
        "OpenClaw host mode found: separate memory until you migrate (`plur1bus import`) or switch the plugin to thin client",
    )
}

pub(crate) fn configured_store_violation(
    config_path: &Path,
    env: &HostEnvironment,
) -> Option<StoreViolation> {
    let config = fs::read(config_path)
        .ok()
        .and_then(|bytes| plur1bus_config::parse(std::str::from_utf8(&bytes).ok()?).ok())?;
    store_violation(&config, env)
}
