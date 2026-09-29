use crate::supervisor::state::{Role, RoleKind};
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

/// The platform default home (`~/.plur1bus` or `%LOCALAPPDATA%\PLUR1BUS`), ignoring `--home` and `$PLUR1BUS_HOME`:
/// the home whose OS service keeps the plain name (S10).
pub fn default_home() -> PathBuf {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.remove("PLUR1BUS_HOME");
    let platform = if cfg!(windows) { "windows" } else { "posix" };
    let home_dir = home::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    resolve_home(None, &env, platform, &home_dir, None, &cwd)
}

#[derive(Debug, Clone)]
pub struct Layout {
    pub home: PathBuf,
}
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
    pub fn core_pid(&self) -> PathBuf {
        self.run().join("core.pid")
    }
    /// The supervisor's RPC token and the nonce `core.adopt` proves (S3).
    pub fn supervisor_token(&self) -> PathBuf {
        self.run().join("supervisor.token")
    }
    /// `<pid> <instanceId>\n` of the running supervisor.
    pub fn supervisor_pid(&self) -> PathBuf {
        self.run().join("supervisor.pid")
    }
    /// The pid recorded in `run/core.pid` (`Endpoint::Core`) or `run/supervisor.pid` (`Endpoint::Supervisor`), the
    /// first field of `<pid> <instanceId>`. Clients pass it as `ConnectOptions::expected_server_pid` (ruling S11).
    /// `None` for `Endpoint::Module`: a module's pid file is per module (`Layout::endpoints(role).pid`).
    pub fn recorded_pid(&self, endpoint: plur1bus_rpc::Endpoint) -> Option<u32> {
        let file = match endpoint {
            plur1bus_rpc::Endpoint::Core => self.core_pid(),
            plur1bus_rpc::Endpoint::Supervisor => self.supervisor_pid(),
            plur1bus_rpc::Endpoint::Module => return None,
        };
        std::fs::read_to_string(file)
            .ok()?
            .split_whitespace()
            .next()?
            .parse()
            .ok()
    }
    /// Held with an exclusive OS file lock for the supervisor's whole life: the single-instance guard.
    pub fn supervisor_lock(&self) -> PathBuf {
        self.run().join("supervisor.lock")
    }
    pub fn logs(&self) -> PathBuf {
        self.home.join("logs")
    }
    /// `logs/<role>.log`, the process's own JSON-lines log (S17).
    pub fn log_file(&self, role: &str) -> PathBuf {
        self.logs().join(format!("{role}.log"))
    }
    /// `logs/<role>.out.log`, a child's captured stdout/stderr (S17).
    #[allow(dead_code)] // written by the child output pump (Task 6)
    pub fn out_log(&self, role: &str) -> PathBuf {
        self.logs().join(format!("{role}.out.log"))
    }
    pub fn runtime(&self) -> PathBuf {
        self.home.join("runtime")
    }
    /// `<home>/manifest.json`, the install manifest `setup` writes (HB9).
    pub fn install_manifest(&self) -> PathBuf {
        self.home.join("manifest.json")
    }
    /// `<home>/skills`: one `<name>/SKILL.md` directory per skill (⟂EXT 5).
    #[allow(dead_code)] // setup's skills step (2a-H3b-b Task 4)
    pub fn skills(&self) -> PathBuf {
        self.home.join("skills")
    }
    /// `<home>/extensions`: `state.json`, the package cache, staging, the trash and the catalogue cache (X1).
    #[allow(dead_code)] // the ext state layer (X1 Task 5)
    pub fn extensions(&self) -> PathBuf {
        self.home.join("extensions")
    }
    /// `<home>/data/ext/<name>`: an extension's own data, kept at uninstall (X1-R31).
    #[allow(dead_code)] // the ext lifecycle (X1 Tasks 7, 9)
    pub fn ext_data(&self, name: &str) -> PathBuf {
        self.home.join("data").join("ext").join(name)
    }
    /// `<home>/imports`: the skills importer's lock and its rollback data; the ext code takes the same lock (X1-R14).
    #[allow(dead_code)] // the ext state layer (X1 Task 5)
    pub fn imports(&self) -> PathBuf {
        self.home.join("imports")
    }
    /// `<home>/models`: the embedding and reranker model cache.
    #[allow(dead_code)] // the models.cache check (2a-H3b-b Task 6)
    pub fn models(&self) -> PathBuf {
        self.home.join("models")
    }
    /// `<home>/modules`: one `<name>/module.json` directory per installed module.
    #[allow(dead_code)] // setup's modules.bundled step (2a-H3b-b Task 4)
    pub fn modules_dir(&self) -> PathBuf {
        self.home.join("modules")
    }
    /// `logs/audit.log` (HB12).
    #[allow(dead_code)] // audit::append's writers (2a-H3b-b Tasks 4, 7)
    pub fn audit_log(&self) -> PathBuf {
        self.logs().join("audit.log")
    }
    /// A supervised child's address and run files. The core keeps its paths (`run/core.{sock,token,pid}`, the
    /// `-core` pipe); a module has `run/module-<name>.{sock,token,pid}` and the `-module-<name>` pipe.
    pub fn endpoints(&self, role: &Role, platform: &str) -> Endpoints {
        match role.kind {
            RoleKind::Core => Endpoints {
                address: core_address(&self.home, platform),
                token: self.core_token(),
                pid: self.core_pid(),
            },
            RoleKind::Module => Endpoints {
                address: module_address(&self.home, platform, &role.name),
                token: self.run().join(format!("module-{}.token", role.name)),
                pid: self.run().join(format!("module-{}.pid", role.name)),
            },
        }
    }
}

/// Where a supervised child listens and where it keeps its token and `<pid> <instanceId>` file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    pub address: String,
    pub token: PathBuf,
    pub pid: PathBuf,
}

/// Same rule as packages/core/src/paths.ts coreAddress(): socket path on POSIX, a per-home pipe name on Windows.
pub fn core_address(home: &Path, platform: &str) -> String {
    address(home, platform, "core")
}

/// Same rule as packages/core/src/paths.ts supervisorAddress(): `run/supervisor.sock` on POSIX, the per-home
/// `-supervisor` pipe on Windows.
pub fn supervisor_address(home: &Path, platform: &str) -> String {
    address(home, platform, "supervisor")
}

/// A module's address: `run/module-<name>.sock` on POSIX, the per-home `-module-<name>` pipe on Windows.
pub fn module_address(home: &Path, platform: &str, name: &str) -> String {
    address(home, platform, &format!("module-{name}"))
}

/// `\\.\pipe\plur1bus-<first 16 hex of sha256(lower-cased home)>-<role>` on Windows, `<home>/run/<role>.sock` elsewhere.
fn address(home: &Path, platform: &str, role: &str) -> String {
    if platform == "windows" {
        format!(
            r"\\.\pipe\plur1bus-{}-{role}",
            &sha256_hex(home.to_string_lossy().to_lowercase().as_bytes())[..16]
        )
    } else {
        // Build with '/' explicitly: `platform` decides the format, not the host's path separator.
        format!(
            "{}/run/{role}.sock",
            home.to_string_lossy().trim_end_matches('/')
        )
    }
}

fn sha256_hex(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn module_address_parity() {
        // The same strings as module-api's `module address parity` (paths.test.ts); the hash is computed from the rule.
        assert_eq!(
            module_address(Path::new("/tmp/p1b"), "linux", "fixture"),
            "/tmp/p1b/run/module-fixture.sock"
        );
        assert_eq!(
            module_address(Path::new("/tmp/p1b"), "macos", "fixture"),
            "/tmp/p1b/run/module-fixture.sock"
        );
        let home = r"C:\Users\A B\AppData\Local\PLUR1BUS";
        let digest = format!(
            "{:x}",
            Sha256::digest(r"c:\users\a b\appdata\local\plur1bus".as_bytes())
        );
        let hash16 = &digest[..16];
        assert_eq!(
            module_address(Path::new(home), "windows", "fixture"),
            format!(r"\\.\pipe\plur1bus-{hash16}-module-fixture")
        );
    }
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
    fn supervisor_paths_mirror_the_typescript_layout() {
        let l = Layout::new(PathBuf::from("/h/.plur1bus"));
        assert_eq!(l.core_pid(), PathBuf::from("/h/.plur1bus/run/core.pid"));
        assert_eq!(
            l.supervisor_token(),
            PathBuf::from("/h/.plur1bus/run/supervisor.token")
        );
        assert_eq!(
            l.supervisor_pid(),
            PathBuf::from("/h/.plur1bus/run/supervisor.pid")
        );
        assert_eq!(
            l.log_file("supervisor"),
            PathBuf::from("/h/.plur1bus/logs/supervisor.log")
        );
        assert_eq!(
            l.out_log("core"),
            PathBuf::from("/h/.plur1bus/logs/core.out.log")
        );
        assert_eq!(
            supervisor_address(Path::new("/h/.plur1bus"), "posix"),
            "/h/.plur1bus/run/supervisor.sock"
        );
        assert_eq!(
            l.install_manifest(),
            PathBuf::from("/h/.plur1bus/manifest.json")
        );
        assert_eq!(l.skills(), PathBuf::from("/h/.plur1bus/skills"));
        assert_eq!(l.models(), PathBuf::from("/h/.plur1bus/models"));
        assert_eq!(l.modules_dir(), PathBuf::from("/h/.plur1bus/modules"));
        assert_eq!(l.audit_log(), PathBuf::from("/h/.plur1bus/logs/audit.log"));
        // Same hash as the core pipe above, `-supervisor` suffix (paths.ts pipeName(home, "supervisor")).
        assert_eq!(
            supervisor_address(Path::new(r"C:\Users\c\AppData\Local\PLUR1BUS"), "windows"),
            r"\\.\pipe\plur1bus-741b3e0a44818d49-supervisor"
        );
    }

    #[test]
    fn core_endpoints_match_the_old_paths() {
        use crate::supervisor::state::Role;
        let l = Layout::new(PathBuf::from("/h/.plur1bus"));
        let e = l.endpoints(&Role::core(), "posix");
        assert_eq!(e.address, "/h/.plur1bus/run/core.sock");
        assert_eq!(e.address, core_address(&l.home, "posix"));
        assert_eq!(e.token, PathBuf::from("/h/.plur1bus/run/core.token"));
        assert_eq!(e.token, l.core_token());
        assert_eq!(e.pid, PathBuf::from("/h/.plur1bus/run/core.pid"));
        assert_eq!(e.pid, l.core_pid());

        let w = Layout::new(PathBuf::from(r"C:\Users\c\AppData\Local\PLUR1BUS"));
        let e = w.endpoints(&Role::core(), "windows");
        assert_eq!(e.address, r"\\.\pipe\plur1bus-741b3e0a44818d49-core");
        assert_eq!(e.address, core_address(&w.home, "windows"));
        assert_eq!(e.token, w.core_token());
        assert_eq!(e.pid, w.core_pid());

        // A module gets its own run files and its own pipe (the core's hash, `-module-<name>` suffix).
        let m = l.endpoints(&Role::module("fixture"), "posix");
        assert_eq!(m.address, "/h/.plur1bus/run/module-fixture.sock");
        assert_eq!(
            m.token,
            PathBuf::from("/h/.plur1bus/run/module-fixture.token")
        );
        assert_eq!(m.pid, PathBuf::from("/h/.plur1bus/run/module-fixture.pid"));
        assert_eq!(
            w.endpoints(&Role::module("fixture"), "windows").address,
            r"\\.\pipe\plur1bus-741b3e0a44818d49-module-fixture"
        );
        assert_eq!(
            module_address(&w.home, "windows", "fixture"),
            r"\\.\pipe\plur1bus-741b3e0a44818d49-module-fixture"
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

    /// The vectors use `sys.platform`/`process.platform` ids; this crate says `windows`/`posix` (F22).
    fn rust_platform(p: &str) -> &'static str {
        if p == "win32" {
            "windows"
        } else {
            "posix"
        }
    }

    #[test]
    fn address_matches_the_shared_vectors() {
        // Hand-committed, hashes computed independently; the Python client and module-api read the same file.
        let vectors: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../clients/python/plur1bus-memory-client/tests/fixtures/address-vectors.json"
        ))
        .unwrap();
        assert!(vectors.len() >= 10);
        for v in &vectors {
            let home = v["home"].as_str().unwrap();
            let platform = rust_platform(v["platform"].as_str().unwrap());
            assert_eq!(
                core_address(Path::new(home), platform),
                v["address"].as_str().unwrap(),
                "{platform} {home:?}"
            );
        }
    }

    #[test]
    fn resolve_home_matches_the_shared_vectors() {
        let vectors: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../clients/python/plur1bus-memory-client/tests/fixtures/home-vectors.json"
        ))
        .unwrap();
        for v in &vectors {
            let env: HashMap<String, String> = v["env"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, s)| (k.clone(), s.as_str().unwrap().to_string()))
                .collect();
            let lad = v
                .get("localAppData")
                .and_then(|s| s.as_str())
                .map(Path::new);
            let got = resolve_home(
                None,
                &env,
                rust_platform(v["platform"].as_str().unwrap()),
                Path::new(v["homeDir"].as_str().unwrap()),
                lad,
                Path::new(v["cwd"].as_str().unwrap()),
            );
            assert_eq!(got, PathBuf::from(v["home"].as_str().unwrap()), "{v}");
        }
    }

    #[test]
    fn recorded_pid_reads_the_first_field_of_each_pid_file() {
        use plur1bus_rpc::Endpoint;
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        assert_eq!(layout.recorded_pid(Endpoint::Core), None);
        std::fs::create_dir_all(layout.run()).unwrap();
        std::fs::write(
            layout.core_pid(),
            "4242 11111111-2222-4333-8444-555555555555\n",
        )
        .unwrap();
        std::fs::write(layout.supervisor_pid(), "77 x\n").unwrap();
        assert_eq!(layout.recorded_pid(Endpoint::Core), Some(4242));
        assert_eq!(layout.recorded_pid(Endpoint::Supervisor), Some(77));
        std::fs::write(layout.core_pid(), "not-a-pid\n").unwrap();
        assert_eq!(layout.recorded_pid(Endpoint::Core), None);
    }
}
