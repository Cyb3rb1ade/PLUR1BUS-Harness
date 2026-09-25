use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Joins path segments with an explicit separator, independent of the host OS —
/// mirrors Node's `path.win32`/`path.posix` (as opposed to plain `path`, which is
/// host-native). This keeps `resolve_home` testable for both platforms from a
/// single (possibly non-Windows) test host.
fn join_with(sep: char, base: &str, parts: &[&str]) -> String {
    let mut s = base.trim_end_matches(sep).to_string();
    for p in parts {
        s.push(sep);
        s.push_str(p.trim_matches(sep));
    }
    s
}

pub fn resolve_home(
    cli_home: Option<&Path>,
    env: &HashMap<String, String>,
    platform: &str,
    home_dir: &Path,
    local_app_data: Option<&Path>,
) -> PathBuf {
    if let Some(h) = cli_home {
        return h.to_path_buf();
    }
    if let Some(h) = env.get("PLUR1BUS_HOME") {
        return PathBuf::from(h);
    }
    if platform == "windows" {
        let lad = local_app_data
            .map(|p| p.to_string_lossy().to_string())
            .or_else(|| env.get("LOCALAPPDATA").cloned())
            .unwrap_or_else(|| join_with('\\', &home_dir.to_string_lossy(), &["AppData", "Local"]));
        return PathBuf::from(join_with('\\', &lad, &["PLUR1BUS"]));
    }
    PathBuf::from(join_with('/', &home_dir.to_string_lossy(), &[".plur1bus"]))
}

pub fn resolve_home_from_process(cli_home: Option<&Path>) -> PathBuf {
    let env: HashMap<String, String> = std::env::vars().collect();
    let platform = if cfg!(windows) { "windows" } else { "posix" };
    let home_dir = home::home_dir().unwrap_or_else(|| PathBuf::from("."));
    resolve_home(cli_home, &env, platform, &home_dir, None)
}

#[derive(Debug, Clone)]
pub struct Layout {
    pub home: PathBuf,
}
#[allow(dead_code)] // the full Layout surface is consumed by the commands added in Tasks 12–15
impl Layout {
    pub fn new(home: PathBuf) -> Self {
        Self { home }
    }
    pub fn config_path(&self) -> PathBuf {
        self.home.join("config.json")
    }
    pub fn state(&self) -> PathBuf {
        self.home.join("state")
    }
    pub fn journal(&self) -> PathBuf {
        self.state().join("journal")
    }
    pub fn agent_dir(&self, id: &str) -> PathBuf {
        self.home.join("agents").join(id)
    }
    pub fn workspace_dir(&self, id: &str) -> PathBuf {
        self.agent_dir(id).join("workspace")
    }
    pub fn run(&self) -> PathBuf {
        self.home.join("run")
    }
    pub fn core_token(&self) -> PathBuf {
        self.run().join("core.token")
    }
    pub fn core_socket(&self) -> PathBuf {
        self.run().join("core.sock")
    }
    pub fn core_pid(&self) -> PathBuf {
        self.run().join("core.pid")
    }
    pub fn runtime(&self) -> PathBuf {
        self.home.join("runtime")
    }
}

/// Same rule as packages/core/src/paths.ts coreAddress(): socket path on POSIX, a per-home pipe name on Windows.
#[allow(dead_code)] // consumed by the RPC-connecting commands added in Tasks 12–15
pub fn core_address(home: &Path, platform: &str) -> String {
    if platform == "windows" {
        format!(
            r"\\.\pipe\plur1bus-{}-core",
            &sha256_hex(home.to_string_lossy().to_lowercase().as_bytes())[..16]
        )
    } else {
        Layout::new(home.to_path_buf())
            .core_socket()
            .to_string_lossy()
            .to_string()
    }
}

fn sha256_hex(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parity_with_the_typescript_layout() {
        let env = HashMap::new();
        assert_eq!(
            resolve_home(None, &env, "posix", Path::new("/Users/c"), None),
            PathBuf::from("/Users/c/.plur1bus")
        );
        assert_eq!(
            resolve_home(
                None,
                &env,
                "windows",
                Path::new(r"C:\Users\c"),
                Some(Path::new(r"C:\Users\c\AppData\Local"))
            ),
            PathBuf::from(r"C:\Users\c\AppData\Local\PLUR1BUS")
        );
        let mut e2 = HashMap::new();
        e2.insert("PLUR1BUS_HOME".into(), "/y".into());
        assert_eq!(
            resolve_home(Some(Path::new("/x")), &e2, "posix", Path::new("/h"), None),
            PathBuf::from("/x")
        );
        assert_eq!(
            resolve_home(None, &e2, "posix", Path::new("/h"), None),
            PathBuf::from("/y")
        );
        let l = Layout::new(PathBuf::from("/h/.plur1bus"));
        assert_eq!(
            l.workspace_dir("bernd"),
            PathBuf::from("/h/.plur1bus/agents/bernd/workspace")
        );
        assert_eq!(
            core_address(Path::new("/h/.plur1bus"), "posix"),
            "/h/.plur1bus/run/core.sock"
        );
        assert!(
            core_address(Path::new(r"C:\Users\c\AppData\Local\PLUR1BUS"), "windows")
                .starts_with(r"\\.\pipe\plur1bus-")
        );
    }
}
