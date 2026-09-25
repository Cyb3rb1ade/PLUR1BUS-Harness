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

fn is_sep(platform: &str, c: char) -> bool {
    if platform == "windows" {
        c == '\\' || c == '/'
    } else {
        c == '/'
    }
}

fn is_absolute(platform: &str, s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    if platform == "windows" {
        let b = s.as_bytes();
        b[0] == b'\\' || b[0] == b'/' || (s.len() >= 2 && b[1] == b':')
    } else {
        s.starts_with('/')
    }
}

/// Splits a raw (already-absolute) path string into its root prefix (`/` on
/// POSIX; `C:\` or `\` for a drive-letter or UNC/root-relative path on
/// Windows) and everything after it.
fn split_root(platform: &str, s: &str) -> (String, String) {
    let chars: Vec<char> = s.chars().collect();
    if platform == "windows" {
        if chars.len() >= 2 && chars[1] == ':' {
            let drive = format!("{}:", chars[0]);
            let mut i = 2;
            if i < chars.len() && is_sep(platform, chars[i]) {
                i += 1;
            }
            return (format!("{drive}\\"), chars[i..].iter().collect());
        }
        if !chars.is_empty() && is_sep(platform, chars[0]) {
            let mut i = 0;
            while i < chars.len() && is_sep(platform, chars[i]) {
                i += 1;
            }
            return ("\\".to_string(), chars[i..].iter().collect());
        }
        (String::new(), s.to_string())
    } else if let Some(stripped) = s.strip_prefix('/') {
        ("/".to_string(), stripped.to_string())
    } else {
        (String::new(), s.to_string())
    }
}

/// Lexically collapses `.` and `..` segments and duplicate separators —
/// no symlink resolution, no trailing separator. Mirrors what Node's
/// `path.resolve` does after joining onto an absolute base.
fn normalize_absolute(platform: &str, root: &str, sep: char, rest: &str) -> String {
    let mut stack: Vec<&str> = Vec::new();
    for seg in rest.split(|c| is_sep(platform, c)) {
        match seg {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            s => stack.push(s),
        }
    }
    let joined = stack.join(&sep.to_string());
    if joined.is_empty() {
        root.to_string()
    } else {
        format!("{root}{joined}")
    }
}

/// Absolutizes `input` against `cwd` (if it is not already absolute for
/// `platform`) and normalizes it lexically — the Rust equivalent of Node's
/// `path.resolve(input)` (POSIX or Windows variant, chosen by `platform`).
fn resolve_and_normalize(platform: &str, cwd: &Path, input: &str) -> PathBuf {
    let sep = if platform == "windows" { '\\' } else { '/' };
    let raw = if is_absolute(platform, input) {
        input.to_string()
    } else {
        join_with(sep, &cwd.to_string_lossy(), &[input])
    };
    let (root, rest) = split_root(platform, &raw);
    let root = if root.is_empty() {
        // cwd itself was not recognized as absolute (shouldn't happen for a real
        // process cwd); fall back to the platform's root so we still return an
        // absolute, normalized path rather than a relative one.
        if platform == "windows" {
            "\\".to_string()
        } else {
            "/".to_string()
        }
    } else {
        root
    };
    PathBuf::from(normalize_absolute(platform, &root, sep, &rest))
}

pub fn resolve_home(
    cli_home: Option<&Path>,
    env: &HashMap<String, String>,
    platform: &str,
    home_dir: &Path,
    local_app_data: Option<&Path>,
    cwd: &Path,
) -> PathBuf {
    if let Some(h) = cli_home {
        return resolve_and_normalize(platform, cwd, &h.to_string_lossy());
    }
    if let Some(h) = env.get("PLUR1BUS_HOME") {
        return resolve_and_normalize(platform, cwd, h);
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
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    resolve_home(cli_home, &env, platform, &home_dir, None, &cwd)
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
        let cwd = Path::new("/work");
        assert_eq!(
            resolve_home(None, &env, "posix", Path::new("/Users/c"), None, cwd),
            PathBuf::from("/Users/c/.plur1bus")
        );
        assert_eq!(
            resolve_home(
                None,
                &env,
                "windows",
                Path::new(r"C:\Users\c"),
                Some(Path::new(r"C:\Users\c\AppData\Local")),
                cwd,
            ),
            PathBuf::from(r"C:\Users\c\AppData\Local\PLUR1BUS")
        );
        let mut e2 = HashMap::new();
        e2.insert("PLUR1BUS_HOME".into(), "/y".into());
        assert_eq!(
            resolve_home(
                Some(Path::new("/x")),
                &e2,
                "posix",
                Path::new("/h"),
                None,
                cwd
            ),
            PathBuf::from("/x")
        );
        assert_eq!(
            resolve_home(None, &e2, "posix", Path::new("/h"), None, cwd),
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
        // Exact parity with the TS side, computed once via:
        //   node -e 'const c=require("crypto");const h="C:\\Users\\c\\AppData\\Local\\PLUR1BUS";
        //   console.log("\\\\.\\pipe\\plur1bus-"+c.createHash("sha256").update(h.toLowerCase()).digest("hex").slice(0,16)+"-core")'
        // => \\.\pipe\plur1bus-741b3e0a44818d49-core
        assert_eq!(
            core_address(Path::new(r"C:\Users\c\AppData\Local\PLUR1BUS"), "windows"),
            r"\\.\pipe\plur1bus-741b3e0a44818d49-core"
        );
    }

    #[test]
    fn relative_home_is_resolved_against_cwd_like_node_path_resolve() {
        let env = HashMap::new();
        let cwd = Path::new("/work");

        // relative --home with `.`/`..` segments
        assert_eq!(
            resolve_home(
                Some(Path::new("./h/../x")),
                &env,
                "posix",
                Path::new("/h"),
                None,
                cwd,
            ),
            PathBuf::from("/work/x")
        );

        // relative PLUR1BUS_HOME
        let mut e2 = HashMap::new();
        e2.insert("PLUR1BUS_HOME".into(), "h".into());
        assert_eq!(
            resolve_home(None, &e2, "posix", Path::new("/h"), None, cwd),
            PathBuf::from("/work/h")
        );

        // absolute --home is normalized (duplicate separators, `.`, `..`) but not
        // re-rooted at cwd
        assert_eq!(
            resolve_home(
                Some(Path::new("/a//b/./c/..")),
                &env,
                "posix",
                Path::new("/h"),
                None,
                cwd,
            ),
            PathBuf::from("/a/b")
        );

        // Windows platform: relative --home resolves against a Windows cwd
        assert_eq!(
            resolve_home(
                Some(Path::new(r"h\..\x")),
                &env,
                "windows",
                Path::new(r"C:\Users\c"),
                None,
                Path::new(r"C:\work"),
            ),
            PathBuf::from(r"C:\work\x")
        );
        // Windows: an already-absolute drive path is normalized in place
        assert_eq!(
            resolve_home(
                Some(Path::new(r"C:\a\\b\.\c\..")),
                &env,
                "windows",
                Path::new(r"C:\Users\c"),
                None,
                Path::new(r"C:\work"),
            ),
            PathBuf::from(r"C:\a\b")
        );
    }
}
