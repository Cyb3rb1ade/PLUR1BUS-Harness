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
            vars: std::env::vars().map(|(key, value)| (key, value)).collect(),
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
    if let Some(profile) = env.get("OPENCLAW_PROFILE") {
        if !profile.eq_ignore_ascii_case("default")
            && !profile.is_empty()
            && profile.len() <= 64
            && profile
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            return home.join(format!(".openclaw-{profile}"));
        }
    }
    let fresh = home.join(".openclaw");
    let legacy = home.join(".clawdbot");
    if !fresh.exists() && legacy.exists() {
        legacy
    } else {
        fresh
    }
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
    let explicit_root = env.get("OPENCLAW_STATE_DIR").is_some()
        || env
            .get("OPENCLAW_PROFILE")
            .is_some_and(|profile| !profile.eq_ignore_ascii_case("default"));
    let mut roots = marker_ancestors(&store_path);
    if explicit_root && root.exists() {
        roots.push(root.clone());
    } else if has_marker(&root) || root.join("memory").join("lancedb-namespaced").exists() {
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

pub(crate) fn configured_store_violation(
    config_path: &Path,
    env: &HostEnvironment,
) -> Option<StoreViolation> {
    let config = fs::read(config_path)
        .ok()
        .and_then(|bytes| plur1bus_config::parse(std::str::from_utf8(&bytes).ok()?).ok())?;
    store_violation(&config, env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn env(home: &Path, platform: &str) -> HostEnvironment {
        HostEnvironment::injected(
            [("HOME".to_string(), home.to_string_lossy().into_owned())]
                .into_iter()
                .collect(),
            home.to_path_buf(),
            platform,
        )
    }

    fn config(path: &Path) -> Value {
        json!({ "engine": { "baseDbPathOverride": path } })
    }

    fn openclaw_root(home: &Path) -> PathBuf {
        let root = home.join(".openclaw");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("openclaw.json"), "{}").unwrap();
        root
    }

    #[test]
    fn refuses_the_state_directory_and_paths_below_it() {
        let home = tempdir().unwrap();
        let root = openclaw_root(home.path());
        for path in [
            root.clone(),
            root.join("memory/lancedb"),
            root.join("state/lancedb"),
        ] {
            assert!(store_violation(&config(&path), &env(home.path(), "linux")).is_some());
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_into_the_state_directory() {
        let home = tempdir().unwrap();
        let root = openclaw_root(home.path());
        let link = home.path().join("alias");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        assert!(store_violation(
            &config(&link.join("memory/lancedb")),
            &env(home.path(), "linux")
        )
        .is_some());
    }

    #[test]
    fn allows_sibling_directories_and_openclaw_lookalikes() {
        let home = tempdir().unwrap();
        openclaw_root(home.path());
        for name in [".openclaw-other", ".openclawx"] {
            assert!(store_violation(
                &config(&home.path().join(name).join("lancedb")),
                &env(home.path(), "linux")
            )
            .is_none());
        }
    }

    #[test]
    fn compares_paths_without_case_on_windows_and_macos() {
        let home = tempdir().unwrap();
        let root = openclaw_root(home.path());
        let differently_cased =
            PathBuf::from(root.to_string_lossy().to_uppercase()).join("memory/lancedb");
        for platform in ["win32", "darwin"] {
            assert!(
                store_violation(&config(&differently_cased), &env(home.path(), platform)).is_some()
            );
        }
    }

    #[test]
    fn recognizes_legacy_and_explicit_state_roots() {
        let home = tempdir().unwrap();
        let legacy = home.path().join(".clawdbot");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("clawdbot.json"), "{}").unwrap();
        assert!(store_violation(
            &config(&legacy.join("memory/lancedb")),
            &env(home.path(), "linux")
        )
        .is_some());

        let explicit = home.path().join("custom-state");
        fs::create_dir_all(&explicit).unwrap();
        let mut vars = HashMap::new();
        vars.insert(
            "OPENCLAW_STATE_DIR".into(),
            explicit.to_string_lossy().into_owned(),
        );
        let injected = HostEnvironment::injected(vars, home.path().to_path_buf(), "linux");
        assert!(store_violation(&config(&explicit.join("memory/lancedb")), &injected).is_some());
    }

    #[test]
    fn resolves_profile_openclaw_home_and_userprofile_roots() {
        let home = tempdir().unwrap();
        let profile = home.path().join(".openclaw-work");
        fs::create_dir_all(&profile).unwrap();
        let mut vars = HashMap::new();
        vars.insert("HOME".into(), home.path().to_string_lossy().into_owned());
        vars.insert("OPENCLAW_PROFILE".into(), "work".into());
        let injected = HostEnvironment::injected(vars, home.path().to_path_buf(), "linux");
        assert!(store_violation(&config(&profile.join("memory/lancedb")), &injected).is_some());

        let custom_home = home.path().join("openclaw-home");
        let custom_root = custom_home.join(".openclaw");
        fs::create_dir_all(&custom_root).unwrap();
        fs::write(custom_root.join("openclaw.json"), "{}").unwrap();
        let mut vars = HashMap::new();
        vars.insert("HOME".into(), home.path().to_string_lossy().into_owned());
        vars.insert(
            "OPENCLAW_HOME".into(),
            custom_home.to_string_lossy().into_owned(),
        );
        let injected = HostEnvironment::injected(vars, home.path().to_path_buf(), "linux");
        assert!(store_violation(&config(&custom_root.join("memory/lancedb")), &injected).is_some());

        let windows_home = home.path().join("windows-home");
        let windows_root = windows_home.join(".openclaw");
        fs::create_dir_all(&windows_root).unwrap();
        fs::write(windows_root.join("openclaw.json"), "{}").unwrap();
        let mut vars = HashMap::new();
        vars.insert(
            "USERPROFILE".into(),
            windows_home.to_string_lossy().into_owned(),
        );
        let injected = HostEnvironment::injected(vars, home.path().to_path_buf(), "win32");
        assert!(
            store_violation(&config(&windows_root.join("memory/lancedb")), &injected).is_some()
        );
    }

    #[test]
    fn recognizes_the_plugin_default_store_layout_without_a_config_marker() {
        let home = tempdir().unwrap();
        let root = home.path().join("custom-state");
        let store = root.join("memory/lancedb-namespaced");
        fs::create_dir_all(&store).unwrap();
        assert!(
            store_violation(&config(&store.join("agent")), &env(home.path(), "linux")).is_some()
        );
    }

    #[test]
    fn notice_requires_a_plugin_entry_and_reads_only_openclaw_config() {
        let home = tempdir().unwrap();
        let root = openclaw_root(home.path());
        let env = env(home.path(), "linux");
        assert!(!openclaw_plugin_found(&env));
        fs::write(
            root.join("openclaw.json"),
            json!({ "plugins": { "entries": { PLUGIN_ID: {} } } }).to_string(),
        )
        .unwrap();
        assert!(openclaw_plugin_found(&env));
    }
}
