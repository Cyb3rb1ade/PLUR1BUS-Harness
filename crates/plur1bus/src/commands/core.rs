use crate::output::Out;
use crate::paths::Layout;
use serde_json::json;
use std::path::PathBuf;
use std::process::Command;

/// Credential-free Windows peer inspection of the same connected handle Node inherited to stdin.
/// Never opens the pipe by name, reads from it, or writes to it. Unsupported/unknown is a refusal.
pub(crate) fn pipe_server_pid() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::{GetStdHandle, STD_INPUT_HANDLE};
        // SAFETY: the process's standard input is an opaque OS handle. The kernel validates it;
        // pipe_server_pid does not dereference it, consume bytes or mutate the parent's handle.
        let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        if let Some(pid) = plur1bus_rpc::win::pipe_server_pid(handle) {
            crate::output::say_raw(&pid.to_string());
            return;
        }
    }
    std::process::exit(2);
}

/// The Node runtime (HB8): $PLUR1BUS_NODE, then the install manifest's `node.path` (written by setup), then the
/// first `<home>/runtime/node-*/bin/node` by name (never a staged `*.tmp-*` tree), then `node` on PATH. Shared by
/// `core run`, `import` and the supervisor.
pub(crate) fn locate_node(layout: &Layout) -> PathBuf {
    locate_node_with(std::env::var_os("PLUR1BUS_NODE"), layout)
}

fn locate_node_with(env_node: Option<std::ffi::OsString>, layout: &Layout) -> PathBuf {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    env_node
        .map(PathBuf::from)
        .or_else(|| {
            crate::install::manifest::read(layout)
                .ok()
                .flatten()
                .map(|m| PathBuf::from(m.node.path))
                .filter(|p| p.is_file())
        })
        .or_else(|| {
            let mut found: Vec<PathBuf> = std::fs::read_dir(layout.runtime())
                .ok()?
                .filter_map(Result::ok)
                .filter(|e| {
                    let n = e.file_name().to_string_lossy().into_owned();
                    n.starts_with("node-") && !n.contains(".tmp-")
                })
                .map(|e| e.path().join("bin").join(exe))
                .filter(|p| p.is_file())
                .collect();
            found.sort();
            found.into_iter().next()
        })
        .unwrap_or_else(|| PathBuf::from("node"))
}

/// dist/core.js: $PLUR1BUS_CORE_JS, then <home>/runtime/core/core.js (installed by setup, H2). Not checked for
/// existence here.
pub(crate) fn locate_core_js(layout: &Layout) -> PathBuf {
    std::env::var_os("PLUR1BUS_CORE_JS")
        .map(PathBuf::from)
        .unwrap_or_else(|| layout.runtime().join("core").join("core.js"))
}

/// Credential-free extension downloads use the same runtime and installed Core payload as ordinary Core starts.
pub(crate) fn extension_source_fetch(layout: &Layout) -> crate::ext::source_fetch::NodeSourceFetch {
    crate::ext::source_fetch::NodeSourceFetch::new(
        layout.home.clone(),
        locate_node(layout),
        locate_core_js(layout),
    )
}

/// The native attestation helper (`plur1bus-attest`, issue #192) shipped beside this executable, as a canonical absolute path, or
/// `None`. The core pins whatever it is given again (`PLUR1BUS_ATTEST_BIN`: absolute, regular file, not group/world-writable), so a
/// path that fails there simply means "no attestation here"; nothing breaks. A value already in the environment wins, as it does for
/// `PLUR1BUS_CORE_JS`.
pub(crate) fn locate_attest_bin() -> Option<PathBuf> {
    if std::env::var_os("PLUR1BUS_ATTEST_BIN").is_some() {
        return None; // inherited by the child as it is
    }
    attest_beside(&std::env::current_exe().ok()?)
}

pub(crate) fn attest_beside(exe: &std::path::Path) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "plur1bus-attest.exe"
    } else {
        "plur1bus-attest"
    };
    let candidate = exe.parent()?.join(name);
    if !candidate.is_file() {
        return None;
    }
    std::fs::canonicalize(candidate).ok()
}

/// The environment entries that hand the helper's expected content to the core. Passed verbatim and not validated: a malformed
/// value must reach the core, which then runs no helper at all, instead of vanishing and leaving the helper unpinned.
pub(crate) fn attest_pin_env(
    sha256: Option<&str>,
    team_id: Option<&str>,
    win_thumbprint: Option<&str>,
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    [
        ("PLUR1BUS_ATTEST_SHA256", sha256),
        ("PLUR1BUS_ATTEST_TEAM_ID", team_id),
        ("PLUR1BUS_ATTEST_WIN_THUMBPRINT", win_thumbprint),
    ]
    .into_iter()
    .filter_map(|(k, v)| v.map(|v| (k.into(), v.into())))
    .collect()
}

/// What the core child's environment gains from [`locate_attest_bin`]: the helper beside this executable and, when the build baked
/// them, the pins it must match. An inherited `PLUR1BUS_ATTEST_BIN` (an operator's own helper) brings no baked pins: they describe
/// the shipped binary, not that one.
pub(crate) fn attest_env() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let Some(bin) = locate_attest_bin() else {
        return Vec::new();
    };
    let (sha, team, thumb) = crate::install::pins::attest_helper_pins();
    let mut env = vec![("PLUR1BUS_ATTEST_BIN".into(), bin.into_os_string())];
    env.extend(attest_pin_env(sha, team, thumb));
    env
}

/// Pin the Harness executable used for the fixed private remote-filesystem worker command. Only Core receives
/// this metadata. Empty values overwrite inherited descriptors when the executable cannot be verified.
pub(crate) fn native_worker_env() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    use sha2::{Digest, Sha256};
    use std::ffi::OsString;
    use std::io::Read;
    static WORKER: std::sync::OnceLock<Option<(OsString, OsString)>> = std::sync::OnceLock::new();
    let worker = WORKER.get_or_init(|| {
        let path = std::env::current_exe().ok()?.canonicalize().ok()?;
        let mut file = std::fs::File::open(&path).ok()?;
        if !file.metadata().ok()?.is_file() {
            return None;
        }
        let mut digest = Sha256::new();
        let mut block = [0u8; 64 * 1024];
        loop {
            let count = file.read(&mut block).ok()?;
            if count == 0 {
                break;
            }
            digest.update(&block[..count]);
        }
        Some((
            path.into_os_string(),
            format!("{:x}", digest.finalize()).into(),
        ))
    });
    let (path, digest) = worker.clone().unwrap_or_default();
    vec![
        ("PLUR1BUS_NATIVE_BIN".into(), path),
        ("PLUR1BUS_NATIVE_SHA256".into(), digest),
    ]
}

/// Native tools binary installed beside the CLI; explicit overrides also support local development.
pub(crate) fn locate_tools_bin(layout: &Layout) -> PathBuf {
    if let Some(path) = std::env::var_os("PLUR1BUS_TOOLS_BIN") {
        return PathBuf::from(path);
    }
    let name = if cfg!(windows) {
        "plur1bus-tools.exe"
    } else {
        "plur1bus-tools"
    };
    if let Some(path) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|dir| dir.join(name)))
        .filter(|p| p.is_file())
    {
        return path;
    }
    layout.home.join("runtime/bin").join(name)
}

/// Phase 4 (P4-10): which core serves `run/core.sock`. `Ts` is the TypeScript core alone (the default until the flip
/// PR); `Rust` is the front door `plur1bus-core` with the TypeScript core behind it as `core-legacy`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CoreImpl {
    Ts,
    Rust,
}

/// `PLUR1BUS_CORE_IMPL` (`ts` or `rust`; the tests' switch) wins, then `core.impl` in `config.json`, then `ts`. An unknown
/// value of the variable is an error, never a silent default.
pub(crate) fn core_impl(layout: &Layout) -> Result<CoreImpl, String> {
    let config = std::fs::read(layout.config_path())
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
    core_impl_from(
        std::env::var("PLUR1BUS_CORE_IMPL").ok().as_deref(),
        config.as_ref(),
    )
}

fn core_impl_from(
    env: Option<&str>,
    config: Option<&serde_json::Value>,
) -> Result<CoreImpl, String> {
    match env {
        Some("ts") => return Ok(CoreImpl::Ts),
        Some("rust") => return Ok(CoreImpl::Rust),
        None | Some("") => {}
        Some(other) => {
            return Err(format!(
                "PLUR1BUS_CORE_IMPL must be \"ts\" or \"rust\", got {other:?}"
            ))
        }
    }
    let configured = config
        .and_then(|c| c.pointer("/core/impl"))
        .and_then(serde_json::Value::as_str);
    Ok(if configured == Some("rust") {
        CoreImpl::Rust
    } else {
        CoreImpl::Ts
    })
}

/// The Rust core binary (P4-10): `$PLUR1BUS_CORE_BIN`, then `plur1bus-core` beside this executable, then
/// `<home>/runtime/bin/plur1bus-core`. Not checked for existence here.
pub(crate) fn locate_core_bin(layout: &Layout) -> PathBuf {
    let mut places = core_bin_places(layout);
    let last = places.pop().unwrap_or_default();
    places.into_iter().find(|p| p.is_file()).unwrap_or(last)
}

/// Where [`locate_core_bin`] looks, in order: `$PLUR1BUS_CORE_BIN` alone when it is set.
fn core_bin_places(layout: &Layout) -> Vec<PathBuf> {
    if let Some(path) = std::env::var_os("PLUR1BUS_CORE_BIN") {
        return vec![PathBuf::from(path)];
    }
    let name = if cfg!(windows) {
        "plur1bus-core.exe"
    } else {
        "plur1bus-core"
    };
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|dir| dir.join(name)))
        .into_iter()
        .chain([layout.home.join("runtime/bin").join(name)])
        .collect()
}

/// Final review FR-I1: `plur1bus-core` is shipped nowhere until the flip, so a `config.set` that switches `core.impl` to
/// `rust` (from anything else) is refused while no binary is found: the message (reason `core-binary-missing`) says
/// where it was looked for and that `rust` needs a developer build. `None` when the switch can go ahead.
pub(crate) fn rust_core_refusal(
    layout: &Layout,
    before: &serde_json::Value,
    after: &serde_json::Value,
) -> Option<String> {
    let rust = |c: &serde_json::Value| {
        c.pointer("/core/impl").and_then(serde_json::Value::as_str) == Some("rust")
    };
    if !rust(after) || rust(before) || locate_core_bin(layout).is_file() {
        return None;
    }
    let places: Vec<String> = core_bin_places(layout)
        .iter()
        .map(|p| p.display().to_string())
        .collect();
    Some(format!(
        "core.impl \"rust\" needs a developer build: no plur1bus-core binary at {} (build it with `cargo build -p plur1bus-core`, or set PLUR1BUS_CORE_BIN); nothing was changed",
        places.join(", ")
    ))
}

/// Why a core with `core.impl: "rust"` cannot start: no binary at `path`, and the way back (final review FR-I1).
pub(crate) fn core_bin_missing(path: &std::path::Path) -> String {
    format!(
        "plur1bus-core not found at {}: core.impl \"rust\" needs a developer build (or PLUR1BUS_CORE_BIN); `plur1bus config set core.impl ts` goes back to the TypeScript core",
        path.display()
    )
}

/// The environment the core process gets from the CLI or the supervisor, whichever implementation runs: the attestation
/// helper, the native worker pin and the tools binary; for the Rust front door also the located Node runtime and
/// core.js, from which it starts the legacy core.
pub(crate) fn core_env(
    layout: &Layout,
    imp: CoreImpl,
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let mut env = attest_env();
    env.extend(native_worker_env());
    env.push((
        "PLUR1BUS_TOOLS_BIN".into(),
        locate_tools_bin(layout).into_os_string(),
    ));
    if imp == CoreImpl::Rust {
        env.push(("PLUR1BUS_NODE".into(), locate_node(layout).into_os_string()));
        env.push((
            "PLUR1BUS_CORE_JS".into(),
            locate_core_js(layout).into_os_string(),
        ));
    }
    env
}

/// Locates the Node runtime ([`locate_node`]) and dist/core.js ([`locate_core_js`]) and runs the core in the
/// foreground: the TypeScript core, or with `core.impl: "rust"` the Rust front door with the TypeScript core behind it.
pub fn run(out: &Out, layout: &Layout) -> ! {
    let imp = match core_impl(layout) {
        Ok(imp) => imp,
        Err(e) => out.fail("E_CONFIG_INVALID", &e, json!({})),
    };
    let node = locate_node(layout);
    let core_js = locate_core_js(layout);
    if !core_js.exists() {
        out.fail(
            "E_CORE_UNAVAILABLE",
            &format!(
                "core.js not found at {} (set PLUR1BUS_CORE_JS or run setup)",
                core_js.display()
            ),
            json!({}),
        );
    }
    let program = match imp {
        CoreImpl::Ts => node.clone(),
        CoreImpl::Rust => locate_core_bin(layout),
    };
    if imp == CoreImpl::Rust && !program.is_file() {
        out.fail("E_CORE_UNAVAILABLE", &core_bin_missing(&program), json!({}));
    }
    let mut cmd = Command::new(&program);
    match imp {
        CoreImpl::Ts => {
            cmd.arg(&core_js).arg("--home").arg(&layout.home);
            if let Some(ti) = std::env::var_os("PLUR1BUS_TEST_INTERNALS") {
                cmd.arg("--test-internals").arg(ti);
            }
        }
        // The front door passes PLUR1BUS_TEST_INTERNALS on to the legacy core itself.
        CoreImpl::Rust => {
            cmd.arg("serve").arg("--home").arg(&layout.home);
        }
    }
    cmd.envs(core_env(layout, imp));
    let node = program;
    // RE-D173: with the Rust engine selected `core run` stays as the engine's owner; otherwise the start below is
    // unchanged (after one try-lock on run/engine.process.lock).
    if let Some(engine) = crate::engine_owner::prepare(out, layout) {
        crate::engine_owner::run(out, layout, engine, cmd, &node);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let e = cmd.exec();
        out.fail(
            "E_CORE_UNAVAILABLE",
            &format!("cannot exec {}: {e}", node.display()),
            json!({}),
        );
    }
    #[cfg(windows)]
    {
        match cmd.status() {
            Ok(s) => std::process::exit(crate::output::child_exit_code(&s)),
            Err(e) => out.fail(
                "E_CORE_UNAVAILABLE",
                &format!("cannot start {}: {e}", node.display()),
                json!({}),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::manifest::{self, CoreUnit, InstallManifest, NodeUnit, Unit};

    fn touch(p: &std::path::Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "").unwrap();
    }

    #[test]
    fn the_core_implementation_is_the_variable_then_the_config_then_ts() {
        let rust = serde_json::json!({"core": {"impl": "rust"}});
        let ts = serde_json::json!({"core": {"impl": "ts"}});
        assert_eq!(core_impl_from(None, None), Ok(CoreImpl::Ts));
        assert_eq!(core_impl_from(Some(""), Some(&rust)), Ok(CoreImpl::Rust));
        assert_eq!(core_impl_from(None, Some(&ts)), Ok(CoreImpl::Ts));
        assert_eq!(core_impl_from(Some("ts"), Some(&rust)), Ok(CoreImpl::Ts));
        assert_eq!(core_impl_from(Some("rust"), Some(&ts)), Ok(CoreImpl::Rust));
        assert_eq!(
            core_impl_from(None, Some(&serde_json::json!({"core": {"impl": "node"}}))),
            Ok(CoreImpl::Ts)
        );
        assert!(
            core_impl_from(Some("node"), None).is_err(),
            "never a silent default"
        );
    }

    #[test]
    fn the_rust_core_gets_node_and_core_js_and_the_typescript_core_does_not() {
        let layout = Layout::new(std::path::PathBuf::from("/h"));
        let keys = |imp| -> Vec<String> {
            core_env(&layout, imp)
                .into_iter()
                .map(|(k, _)| k.to_string_lossy().into_owned())
                .collect()
        };
        let rust = keys(CoreImpl::Rust);
        assert!(
            rust.contains(&"PLUR1BUS_NODE".into()) && rust.contains(&"PLUR1BUS_CORE_JS".into())
        );
        assert!(
            rust.contains(&"PLUR1BUS_TOOLS_BIN".into())
                && rust.contains(&"PLUR1BUS_NATIVE_BIN".into())
        );
        let ts = keys(CoreImpl::Ts);
        assert!(!ts.contains(&"PLUR1BUS_NODE".into()) && !ts.contains(&"PLUR1BUS_CORE_JS".into()));
    }

    #[test]
    fn native_worker_metadata_pins_this_canonical_executable() {
        use sha2::{Digest, Sha256};
        let env = native_worker_env();
        let path = env
            .iter()
            .find(|(key, _)| key == "PLUR1BUS_NATIVE_BIN")
            .unwrap();
        let digest = env
            .iter()
            .find(|(key, _)| key == "PLUR1BUS_NATIVE_SHA256")
            .unwrap();
        let exe = std::env::current_exe().unwrap().canonicalize().unwrap();
        assert_eq!(PathBuf::from(&path.1), exe);
        assert_eq!(
            digest.1,
            format!("{:x}", Sha256::digest(std::fs::read(exe).unwrap())).as_str()
        );
    }

    #[test]
    fn the_attest_helper_is_the_binary_beside_the_executable_and_only_when_it_exists() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join(if cfg!(windows) {
            "plur1bus.exe"
        } else {
            "plur1bus"
        });
        assert_eq!(attest_beside(&exe), None);
        let helper = dir.path().join(if cfg!(windows) {
            "plur1bus-attest.exe"
        } else {
            "plur1bus-attest"
        });
        touch(&helper);
        assert_eq!(
            attest_beside(&exe),
            Some(std::fs::canonicalize(&helper).unwrap())
        );
    }

    #[test]
    fn the_baked_attest_pins_travel_as_environment_verbatim() {
        let none = attest_pin_env(None, None, None);
        assert!(none.is_empty());
        let all = attest_pin_env(
            Some("ab".repeat(32).as_str()),
            Some("ABCDE12345"),
            Some("A1"),
        );
        let get = |k: &str| {
            all.iter()
                .find(|(n, _)| n == k)
                .map(|(_, v)| v.to_string_lossy().into_owned())
        };
        assert_eq!(get("PLUR1BUS_ATTEST_SHA256"), Some("ab".repeat(32)));
        assert_eq!(
            get("PLUR1BUS_ATTEST_TEAM_ID").as_deref(),
            Some("ABCDE12345")
        );
        // Not validated here: a malformed pin must reach the core, which then runs no helper (fail closed),
        // instead of vanishing and leaving the helper unpinned.
        assert_eq!(get("PLUR1BUS_ATTEST_WIN_THUMBPRINT").as_deref(), Some("A1"));
        let empty = attest_pin_env(Some(""), None, None);
        assert_eq!(empty.len(), 1);
    }

    #[test]
    fn locate_node_prefers_the_manifest_path() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().join("h"));
        let exe = if cfg!(windows) { "node.exe" } else { "node" };
        let first = layout.runtime().join("node-1.0.0").join("bin").join(exe);
        touch(&first);
        touch(
            &layout
                .runtime()
                .join("node-0.9.0.tmp-7")
                .join("bin")
                .join(exe),
        );
        assert_eq!(
            locate_node_with(None, &layout),
            first,
            "the first runtime/node-* by name, never a temp"
        );

        let pinned = dir.path().join("elsewhere").join(exe);
        touch(&pinned);
        let sha = "0".repeat(64);
        manifest::write(
            &layout,
            &InstallManifest {
                schema_version: 1,
                tools: None,
                installed_at: 1,
                updated_at: 1,
                channel: "stable".into(),
                target: "linux-x64".into(),
                binary: Unit {
                    version: "0.1.0".into(),
                    sha256: None,
                },
                node: NodeUnit {
                    version: "24.21.0".into(),
                    archive_sha256: sha.clone(),
                    binary_sha256: sha,
                    path: pinned.to_string_lossy().into_owned(),
                },
                core: CoreUnit {
                    version: "0.1.0".into(),
                    contract: crate::install::manifest::CORE_CONTRACT.into(),
                    rpc: "1.3.0".into(),
                    sha256: None,
                    source: "local".into(),
                },
                modules: vec![],
                skills: vec![],
                profile: None,
            },
        )
        .unwrap();
        assert_eq!(locate_node_with(None, &layout), pinned);
        assert_eq!(
            locate_node_with(Some("/opt/node".into()), &layout),
            PathBuf::from("/opt/node"),
            "PLUR1BUS_NODE wins"
        );
        std::fs::remove_file(&pinned).unwrap();
        assert_eq!(
            locate_node_with(None, &layout),
            first,
            "a vanished manifest path falls through"
        );
        std::fs::remove_dir_all(layout.runtime()).unwrap();
        assert_eq!(locate_node_with(None, &layout), PathBuf::from("node"));
    }
}
