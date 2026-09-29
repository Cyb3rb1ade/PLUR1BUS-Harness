//! `plur1bus skill|plugin|ext` (X1 Task 12; spec §8.3, §10.1; acceptance 1 and 3): install with the inspection
//! disclosure and the acknowledgments, enable and disable with the capability disclosure and the restart plan,
//! `ext inspect|pack|verify`, stdin input, and the offline mode (no supervisor: the same `ext::` code in-process under
//! the supervisor's single-instance lock), whose results and exit codes match the online path.
//!
//! Every test has its own temp home. Packages are signed with a throwaway key the code under test trusts through
//! `PLUR1BUS_TEST_EXT_PUBKEYS`; the online tests run `supervise --no-core` with the same key. No test touches a real
//! service manager, a real home or another harness install; stdin is never a terminal here, so every question is answered
//! by the flags.
mod common;

use plur1bus_ext::pack::PayloadFile;
use plur1bus_ext::testkit::{build_package_from, tamper, test_key, Tamper, TestKey};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(30);

// ---- homes ---------------------------------------------------------------------------------------------------------

struct Home {
    dir: tempfile::TempDir,
    home: PathBuf,
    key: TestKey,
}

impl Home {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("h");
        std::fs::create_dir_all(&home).unwrap();
        Home {
            home,
            key: test_key("test"),
            dir,
        }
    }

    fn pubkeys(&self) -> String {
        format!("{}={}", self.key.label, self.key.public_b64)
    }

    /// `plur1bus --home <home> …` with the test seams (the trusted key).
    fn cmd(&self) -> Command {
        let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
        c.arg("--home")
            .arg(&self.home)
            .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
            .env("PLUR1BUS_TEST_EXT_PUBKEYS", self.pubkeys())
            .stdin(Stdio::null());
        c
    }

    fn run(&self, args: &[&str]) -> Output {
        self.cmd().args(args).output().unwrap()
    }

    /// `run` with `bytes` on stdin.
    fn run_stdin(&self, args: &[&str], bytes: &[u8]) -> Output {
        let mut child = self
            .cmd()
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(bytes).unwrap();
        child.wait_with_output().unwrap()
    }

    /// `supervise --no-core` with the trusted test key.
    fn start(&self) -> common::Supervisor {
        let child = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
            .arg("--home")
            .arg(&self.home)
            .args(["supervise", "--no-core"])
            .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
            .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", "0.2")
            .env("PLUR1BUS_TEST_EXT_PUBKEYS", self.pubkeys())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let s = common::Supervisor {
            child,
            home: self.home.clone(),
        };
        common::wait_until("run/supervisor.token", WAIT, || {
            self.home.join("run/supervisor.token").exists()
        });
        drop(common::client(&self.home));
        s
    }

    fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let p = self.dir.path().join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    fn config(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.home.join("config.json")).unwrap())
            .unwrap()
    }

    /// config.json with the agents `bernd` and `anna`.
    fn two_agents(&self) {
        let mut c = plur1bus_config::defaults();
        c["agents"] = json!({
            "bernd": {"createdAt": "2026-09-28T10:00:00.000Z"},
            "anna": {"createdAt": "2026-09-28T10:00:00.000Z"}
        });
        plur1bus_config::validate(&c).unwrap();
        plur1bus_config::write_atomic(&self.home.join("config.json"), &c).unwrap();
    }

    fn index_enabled(&self, name: &str) -> Option<bool> {
        let t = std::fs::read_to_string(self.home.join("skills/index.json")).ok()?;
        let v: Value = serde_json::from_str(&t).ok()?;
        v["skills"]
            .as_array()?
            .iter()
            .find(|e| e["id"] == name)?
            .get("enabled")?
            .as_bool()
    }
}

/// The one JSON document a `--json` run printed on stdout.
fn doc(o: &Output) -> Value {
    let text = String::from_utf8_lossy(&o.stdout);
    serde_json::from_str(text.trim()).unwrap_or_else(|e| {
        panic!(
            "stdout is not one JSON document ({e}): {text}\nstderr: {}",
            String::from_utf8_lossy(&o.stderr)
        )
    })
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

fn code(o: &Output) -> i32 {
    o.status.code().unwrap_or(-1)
}

fn ok_doc(o: &Output, schema: &str) -> Value {
    assert_eq!(code(o), 0, "stdout: {}\nstderr: {}", stdout(o), stderr(o));
    let v = doc(o);
    assert_eq!(v["schema"], schema, "{v}");
    v
}

fn err_doc(o: &Output, exit: i32, error: &str, reason: &str) -> Value {
    let v = doc(o);
    assert_eq!(code(o), exit, "{v}\nstderr: {}", stderr(o));
    assert_eq!(v["schema"], "error/1", "{v}");
    assert_eq!(v["error"], error, "{v}");
    assert_eq!(v["reason"], reason, "{v}");
    v
}

// ---- packages ------------------------------------------------------------------------------------------------------

fn f(rel: &str, bytes: &[u8], exec: bool) -> PayloadFile {
    PayloadFile {
        rel: rel.to_string(),
        bytes: bytes.to_vec(),
        exec,
    }
}

fn base_caps() -> Value {
    json!({
        "network": { "mode": "none" },
        "filesystem": [],
        "processes": { "spawn": false },
        "harness": { "authority": "none" }
    })
}

fn template(name: &str, kind: &str, version: &str) -> Value {
    let mut t = json!({
        "$schema": "https://plur1bus.app/schema/p1x/1/p1x.schema.json",
        "format": 1,
        "id": format!("demo/{name}"),
        "name": name,
        "version": version,
        "kind": kind,
        "title": { "en": "Demo" },
        "summary": { "en": "A demo." },
        "publisher": { "id": "demo", "name": "Demo" },
        "licence": "MIT",
        "compat": { "harness": ">=0.0.0" },
        "requires": { "runtime": { "type": "none" } },
        "capabilities": base_caps()
    });
    if kind != "skill" {
        t["compat"]["moduleApi"] = json!(["1"]);
        t["requires"]["runtime"] = json!({ "type": "node", "range": ">=24" });
    }
    t
}

const RUN_SH: &[u8] = b"#!/bin/sh\necho hi\n";

fn skill_md(name: &str) -> Vec<u8> {
    format!("---\nname: {name}\ndescription: A demo.\n---\nbody\n").into_bytes()
}

fn skill_files(name: &str) -> Vec<PayloadFile> {
    vec![
        f("SKILL.md", &skill_md(name), false),
        f("scripts/run.sh", RUN_SH, true),
    ]
}

/// A signed skill `name` 1.0.0 with `scripts/run.sh`.
fn skill_pkg(h: &Home, name: &str) -> Vec<u8> {
    build_package_from(
        &template(name, "skill", "1.0.0"),
        skill_files(name),
        Some(&h.key),
    )
}

fn module_json(name: &str, needs: &[&str]) -> Vec<u8> {
    serde_json::to_vec_pretty(&json!({
        "name": name, "version": "1.0.0", "apiVersion": "1", "entry": "index.js",
        "scope": "installation", "priority": 500, "needs": needs
    }))
    .unwrap()
}

/// A signed module `name` 1.0.0 that needs `needs`.
fn module_pkg(h: &Home, name: &str, needs: &[&str]) -> Vec<u8> {
    build_package_from(
        &template(name, "module", "1.0.0"),
        vec![
            f("module.json", &module_json(name, needs), false),
            f("index.js", b"// fixture\n", false),
        ],
        Some(&h.key),
    )
}

/// An unsigned skill folder `<scratch>/<name>` with `scripts/run.sh` (executable on unix).
fn skill_folder(h: &Home, name: &str) -> PathBuf {
    let d = h.dir.path().join(name);
    std::fs::create_dir_all(d.join("scripts")).unwrap();
    std::fs::write(d.join("SKILL.md"), skill_md(name)).unwrap();
    let run = d.join("scripts/run.sh");
    std::fs::write(&run, RUN_SH).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    d
}

fn p(path: &Path) -> &str {
    path.to_str().unwrap()
}

/// The names under `dir` (empty when it does not exist).
fn entries(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|r| {
            r.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

/// Every file under `skills/`, `modules/`, `extensions/` and `config.json`, with its bytes: what a refusal or a dry
/// run must leave as it was.
fn guarded(home: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(root: &Path, p: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        if p.is_dir() {
            for e in std::fs::read_dir(p).unwrap().flatten() {
                walk(root, &e.path(), out);
            }
        } else if p.exists() {
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().into_owned();
            out.push((rel, std::fs::read(p).unwrap_or_default()));
        }
    }
    let mut out = Vec::new();
    for d in ["skills", "modules", "extensions", "config.json"] {
        walk(home, &home.join(d), &mut out);
    }
    out.sort();
    out
}

// ---- tests ---------------------------------------------------------------------------------------------------------

/// Acceptance 1 through the CLI, offline and through a running supervisor: a signed skill installs disabled, enables
/// for one agent only, and disables again; `--json` answers the documented ids.
#[test]
fn skill_install_signed_then_enable_for_one_agent_then_disable() {
    for online in [false, true] {
        let h = Home::new();
        h.two_agents();
        let _s = online.then(|| h.start());
        let pkg = h.write("demo-skill.p1x", &skill_pkg(&h, "demo-skill"));

        let v = ok_doc(
            &h.run(&["--json", "skill", "install", p(&pkg), "--yes"]),
            "skill.install/1",
        );
        assert_eq!(v["name"], "demo-skill", "{v}");
        assert_eq!(v["kind"], "skill");
        assert_eq!(v["state"], "installed");
        assert_eq!(v["replaced"], false);
        assert_eq!(h.index_enabled("demo-skill"), Some(false));

        let v = ok_doc(
            &h.run(&[
                "--json",
                "skill",
                "enable",
                "demo-skill",
                "--agent",
                "bernd",
                "--yes",
            ]),
            "skill.enable/1",
        );
        assert_eq!(v["name"], "demo-skill", "{v}");
        assert_eq!(v["state"], "enabled", "{v}");
        assert_eq!(h.index_enabled("demo-skill"), Some(true));
        assert_eq!(
            h.config()["agents"]["anna"]["skills"]["blocked"],
            json!(["demo-skill"]),
            "online={online}"
        );

        let names = |agent: &str| -> Vec<String> {
            let v = ok_doc(
                &h.run(&["--json", "skill", "list", "--agent", agent]),
                "skill.list/1",
            );
            v["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| i["name"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(names("bernd"), ["demo-skill"]);
        assert!(names("anna").is_empty());

        let v = ok_doc(
            &h.run(&["--json", "skill", "show", "demo-skill"]),
            "skill.show/1",
        );
        assert_eq!(v["item"]["id"], "demo/demo-skill", "{v}");

        let v = ok_doc(
            &h.run(&["--json", "skill", "disable", "demo-skill"]),
            "skill.disable/1",
        );
        assert_eq!(v["state"], "installed", "{v}");
        assert_eq!(h.index_enabled("demo-skill"), Some(false));
    }
}

/// Acceptance 3: an unsigned skill folder without `--allow-unsigned` is `E_APPROVAL_REQUIRED acknowledge-unsigned`,
/// exit 2, its scripts listed (in `data` and in the human disclosure), and nothing is written.
#[test]
fn an_unsigned_folder_skill_without_allow_unsigned_exits_2_with_its_scripts_listed() {
    for online in [false, true] {
        let h = Home::new();
        let _s = online.then(|| h.start());
        let dir = skill_folder(&h, "demo-scripts");

        let o = h.run(&["--json", "skill", "install", p(&dir), "--yes"]);
        let v = err_doc(&o, 2, "E_APPROVAL_REQUIRED", "acknowledge-unsigned");
        assert_eq!(v["data"]["trust"]["tier"], "unsigned", "{v}");
        let scripts: Vec<&str> = v["data"]["scripts"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["path"].as_str())
            .collect();
        assert_eq!(scripts, ["payload/scripts/run.sh"], "{v}");
        assert!(!h.home.join("skills").exists());
        assert!(!h.home.join("extensions").exists());

        let o = h.run(&["skill", "install", p(&dir)]);
        assert_eq!(code(&o), 2, "{}", stderr(&o));
        let out = stdout(&o);
        assert!(out.contains("scripts/run.sh"), "{out}");
        assert!(out.contains("#!/bin/sh"), "{out}");
        assert!(out.contains("contains 1 program"), "{out}");
        assert!(out.contains("unsigned"), "{out}");
        assert!(stderr(&o).contains("--allow-unsigned"), "{}", stderr(&o));
        assert!(!h.home.join("skills").exists());

        let v = ok_doc(
            &h.run(&[
                "--json",
                "skill",
                "install",
                p(&dir),
                "--allow-unsigned",
                "--yes",
            ]),
            "skill.install/1",
        );
        assert_eq!(v["name"], "demo-scripts", "{v}");
        assert!(h.home.join("skills/demo-scripts/SKILL.md").is_file());
    }
}

/// `install --dry-run` prints the inspection as `ext.inspect/1` and writes nothing outside `run/inspect/`.
#[test]
fn install_dry_run_prints_ext_inspect_1_and_writes_nothing() {
    for online in [false, true] {
        let h = Home::new();
        let _s = online.then(|| h.start());
        let before = guarded(&h.home);
        let pkg = h.write("demo-skill.p1x", &skill_pkg(&h, "demo-skill"));
        let v = ok_doc(
            &h.run(&["--json", "skill", "install", p(&pkg), "--dry-run"]),
            "ext.inspect/1",
        );
        assert!(v["inspectionId"].is_string(), "{v}");
        assert_eq!(v["manifest"]["name"], "demo-skill");
        assert_eq!(v["trust"]["tier"], "first-party");
        assert!(
            guarded(&h.home) == before,
            "online={online}: the dry run wrote"
        );
        // The human dry run shows the disclosure and says that nothing was installed.
        let o = h.run(&["skill", "install", p(&pkg), "--dry-run"]);
        assert_eq!(code(&o), 0, "{}", stderr(&o));
        assert!(stdout(&o).contains("demo/demo-skill"), "{}", stdout(&o));
        assert!(stdout(&o).contains("dry run"), "{}", stdout(&o));
        assert!(
            guarded(&h.home) == before,
            "online={online}: the dry run wrote"
        );
    }
}

/// `plugin install` refuses a skill package and `skill install` a module package, before anything is written.
#[test]
fn plugin_install_refuses_a_skill_package_and_skill_install_refuses_a_module_package() {
    for online in [false, true] {
        let h = Home::new();
        let _s = online.then(|| h.start());
        let before = guarded(&h.home);
        let skill = h.write("demo-skill.p1x", &skill_pkg(&h, "demo-skill"));
        let module = h.write("fixture.p1x", &module_pkg(&h, "fixture", &["core"]));

        let v = err_doc(
            &h.run(&["--json", "plugin", "install", p(&skill), "--yes"]),
            1,
            "E_INVALID_PARAMS",
            "package-invalid",
        );
        assert!(
            v["detail"]
                .as_str()
                .unwrap_or("")
                .contains("use skill install"),
            "{v}"
        );
        let v = err_doc(
            &h.run(&["--json", "skill", "install", p(&module), "--yes"]),
            1,
            "E_INVALID_PARAMS",
            "package-invalid",
        );
        assert!(
            v["detail"]
                .as_str()
                .unwrap_or("")
                .contains("use plugin install"),
            "{v}"
        );
        assert!(
            guarded(&h.home) == before,
            "online={online}: a wrong-kind install wrote"
        );
    }
}

/// I2: an offline install holds `run/supervisor.lock` from start to end. Held by someone else, the install is refused
/// and writes nothing; while the install holds it (here: still reading its package from stdin), a supervisor that
/// starts is refused, and the install then completes.
#[test]
fn offline_install_takes_the_supervisor_lock_and_a_starting_supervisor_is_refused() {
    let h = Home::new();
    let pkg = skill_pkg(&h, "demo-skill");
    let file = h.write("demo-skill.p1x", &pkg);

    std::fs::create_dir_all(h.home.join("run")).unwrap();
    let lock_path = h.home.join("run/supervisor.lock");
    let open_lock = || {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .unwrap()
    };
    {
        let held = open_lock();
        held.try_lock().unwrap();
        let o = h.run(&["--json", "skill", "install", p(&file), "--yes"]);
        let v = doc(&o);
        assert_eq!(v["error"], "E_NOT_AVAILABLE", "{v}");
        assert_eq!(v["reason"], "supervisor-running", "{v}");
        // G18: E_NOT_AVAILABLE exits 2, as online (`supervisor-unresponsive`).
        assert_eq!(code(&o), 2, "{v}");
        assert!(!h.home.join("skills").exists());
        assert!(!h.home.join("extensions").exists());
    }

    let mut install = h
        .cmd()
        .args(["--json", "skill", "install", "-", "--yes"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let probe = open_lock();
    let deadline = Instant::now() + WAIT;
    while probe.try_lock().is_ok() {
        probe.unlock().unwrap();
        assert!(
            Instant::now() < deadline,
            "the offline install never took the lock"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let sup = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .arg("--home")
        .arg(&h.home)
        .args(["supervise", "--no-core"])
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        !sup.status.success() && stderr(&sup).contains("is held but no supervisor answered"),
        "a supervisor started while the offline install held the lock: {:?} {}",
        sup.status,
        stderr(&sup)
    );
    assert!(!h.home.join("run/supervisor.token").exists());
    install.stdin.take().unwrap().write_all(&pkg).unwrap();
    let o = install.wait_with_output().unwrap();
    let v = ok_doc(&o, "skill.install/1");
    assert_eq!(v["name"], "demo-skill");
}

/// X1-R13: `enable` without `--yes` on a non-TTY is `E_APPROVAL_REQUIRED acknowledge-capabilities`, exit 2, with the
/// capabilities (and the authority) in `data`, offline and online (`error.data.ext`, X1-C19); nothing is enabled.
#[test]
fn enable_without_yes_on_a_non_tty_exits_2_with_the_capabilities() {
    for online in [false, true] {
        let h = Home::new();
        let _s = online.then(|| h.start());
        let pkg = h.write("demo-skill.p1x", &skill_pkg(&h, "demo-skill"));
        ok_doc(
            &h.run(&["--json", "skill", "install", p(&pkg), "--yes"]),
            "skill.install/1",
        );

        let v = err_doc(
            &h.run(&["--json", "skill", "enable", "demo-skill"]),
            2,
            "E_APPROVAL_REQUIRED",
            "acknowledge-capabilities",
        );
        assert_eq!(v["data"]["capabilities"], base_caps(), "{v}");
        assert_eq!(v["data"]["authority"], "none", "{v}");
        assert_eq!(h.index_enabled("demo-skill"), Some(false));

        let o = h.run(&["skill", "enable", "demo-skill"]);
        assert_eq!(code(&o), 2);
        assert!(stdout(&o).contains("network"), "{}", stdout(&o));
        assert!(stderr(&o).contains("--yes"), "{}", stderr(&o));
        assert_eq!(h.index_enabled("demo-skill"), Some(false));
    }
}

/// A module enable prints its dry-run plan (`will restart: …`, `will be held back: …`) before it applies.
#[test]
fn module_enable_prints_the_restart_plan_before_applying() {
    for online in [false, true] {
        let h = Home::new();
        let _s = online.then(|| h.start());
        let pkg = h.write("fixture.p1x", &module_pkg(&h, "fixture", &["core"]));
        // `--enable` needs the capabilities acknowledged: a module has the full authority of a harness process.
        let v = err_doc(
            &h.run(&["--json", "plugin", "install", p(&pkg), "--enable"]),
            2,
            "E_APPROVAL_REQUIRED",
            "acknowledge-capabilities",
        );
        assert_eq!(v["data"]["authority"], "full", "{v}");
        assert!(!h.home.join("modules").exists());
        ok_doc(
            &h.run(&["--json", "plugin", "install", p(&pkg), "--yes"]),
            "plugin.install/1",
        );
        assert_eq!(h.config()["modules"]["fixture"]["enabled"], false);

        let o = h.run(&["plugin", "enable", "fixture", "--yes"]);
        assert_eq!(code(&o), 0, "{}", stderr(&o));
        let out = stdout(&o);
        let plan = out.find("will restart:").unwrap_or_else(|| panic!("{out}"));
        assert!(out.contains("will be held back:"), "{out}");
        let applied = out
            .find("enabled fixture")
            .unwrap_or_else(|| panic!("{out}"));
        assert!(plan < applied, "{out}");
        assert_eq!(h.config()["modules"]["fixture"]["enabled"], true);

        let v = ok_doc(&h.run(&["--json", "plugin", "list"]), "plugin.list/1");
        assert_eq!(v["items"][0]["name"], "fixture", "{v}");
        assert_eq!(v["items"][0]["state"], "enabled", "{v}");
        if online {
            // Stop it over RPC, so no module process outlives the test.
            let o = h.run(&["--json", "plugin", "disable", "fixture", "--yes"]);
            ok_doc(&o, "plugin.disable/1");
        }
    }
}

/// `-` reads the package from stdin, offline and through the supervisor (which gets a spooled copy).
#[test]
fn install_from_stdin_works() {
    for online in [false, true] {
        let h = Home::new();
        let _s = online.then(|| h.start());
        let pkg = skill_pkg(&h, "demo-skill");
        let v = ok_doc(
            &h.run_stdin(&["--json", "skill", "install", "-", "--yes"], &pkg),
            "skill.install/1",
        );
        assert_eq!(v["name"], "demo-skill", "online={online}: {v}");
        assert!(h.home.join("skills/demo-skill/SKILL.md").is_file());
        let v = ok_doc(
            &h.run_stdin(&["--json", "ext", "inspect", "-"], &pkg),
            "ext.inspect/1",
        );
        assert_eq!(v["manifest"]["name"], "demo-skill");
        // The CLI's stdin spool is gone; only inspections are left in run/inspect/.
        assert!(
            entries(&h.home.join("run/inspect"))
                .iter()
                .all(|n| !n.starts_with("stdin-")),
            "{:?}",
            entries(&h.home.join("run/inspect"))
        );
    }
}

/// `ext pack` builds a package from `p1x.template.json` and `payload/`, and `ext verify` inspects it; neither needs
/// (or creates) a home.
#[test]
fn ext_pack_then_ext_verify_round_trips() {
    let h = Home::new();
    let src = h.dir.path().join("src");
    std::fs::create_dir_all(src.join("payload/scripts")).unwrap();
    std::fs::write(
        src.join("p1x.template.json"),
        serde_json::to_vec_pretty(&template("demo-skill", "skill", "1.2.0")).unwrap(),
    )
    .unwrap();
    std::fs::write(src.join("payload/SKILL.md"), skill_md("demo-skill")).unwrap();
    std::fs::write(src.join("payload/scripts/run.sh"), RUN_SH).unwrap();
    let out = h.dir.path().join("out.p1x");
    let nohome = h.dir.path().join("no-home");
    let bin = || {
        let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
        c.arg("--home").arg(&nohome).stdin(Stdio::null());
        c
    };

    let o = bin()
        .args(["--json", "ext", "pack", p(&src), "-o", p(&out)])
        .output()
        .unwrap();
    let v = ok_doc(&o, "ext.pack/1");
    assert_eq!(v["name"], "demo-skill", "{v}");
    assert_eq!(v["version"], "1.2.0");
    assert!(out.is_file());

    let o = bin()
        .args(["--json", "ext", "verify", p(&out)])
        .output()
        .unwrap();
    let v = ok_doc(&o, "ext.verify/1");
    assert_eq!(v["manifest"]["name"], "demo-skill", "{v}");
    assert_eq!(v["trust"]["tier"], "unsigned");
    assert_eq!(v["scripts"][0]["path"], "payload/scripts/run.sh", "{v}");
    assert!(!nohome.exists(), "pack or verify created a home");

    let o = bin().args(["ext", "verify", p(&out)]).output().unwrap();
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert!(stdout(&o).contains("demo/demo-skill"), "{}", stdout(&o));
}

/// A tampered package: `ext verify` names the reason and exits 1.
#[test]
fn ext_verify_of_a_tampered_package_prints_the_reason_and_exits_1() {
    let h = Home::new();
    let bad = h.write(
        "bad.p1x",
        &tamper(&skill_pkg(&h, "demo-skill"), Tamper::PayloadByte),
    );
    let o = h.run(&["ext", "verify", p(&bad)]);
    assert_eq!(code(&o), 1, "{}", stdout(&o));
    assert!(stderr(&o).contains("digest-mismatch"), "{}", stderr(&o));
    err_doc(
        &h.run(&["--json", "ext", "verify", p(&bad)]),
        1,
        "E_INVALID_PARAMS",
        "digest-mismatch",
    );
}

fn is_schema_id(s: &str) -> bool {
    let Some((path, major)) = s.rsplit_once('/') else {
        return false;
    };
    !major.is_empty()
        && major.chars().all(|c| c.is_ascii_digit())
        && path.split('.').all(|seg| {
            !seg.is_empty()
                && seg
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
}

/// Every new leaf command is `[experimental]`, and every `--json` document of the new commands carries its id.
#[test]
fn every_new_leaf_is_experimental_and_every_json_document_has_its_schema_id() {
    let h = Home::new();
    let md = h.run(&["__markdown"]);
    let md = stdout(&md);
    let leaves = [
        "skill list",
        "skill show",
        "skill install",
        "skill uninstall",
        "skill restore",
        "skill enable",
        "skill disable",
        "plugin list",
        "plugin show",
        "plugin install",
        "plugin uninstall",
        "plugin restore",
        "plugin enable",
        "plugin disable",
        "ext inspect",
        "ext pack",
        "ext verify",
    ];
    for leaf in leaves {
        let head = format!("## `plur1bus {leaf}`");
        let at = md.find(&head).unwrap_or_else(|| panic!("{head} missing"));
        let about = md[at + head.len()..]
            .trim_start()
            .lines()
            .next()
            .unwrap_or("");
        assert!(
            about.starts_with("[experimental] "),
            "{leaf}: about {about:?}"
        );
    }
    assert!(!md.contains("__worker"), "the worker is hidden");

    let pkg = h.write("demo-skill.p1x", &skill_pkg(&h, "demo-skill"));
    let cases: Vec<(Vec<&str>, &str)> = vec![
        (vec!["skill", "list"], "skill.list/1"),
        (vec!["plugin", "list"], "plugin.list/1"),
        (vec!["ext", "inspect", p(&pkg)], "ext.inspect/1"),
        (vec!["ext", "verify", p(&pkg)], "ext.verify/1"),
        (
            vec!["skill", "install", p(&pkg), "--yes"],
            "skill.install/1",
        ),
        (vec!["skill", "show", "demo-skill"], "skill.show/1"),
        (
            vec!["skill", "enable", "demo-skill", "--yes"],
            "skill.enable/1",
        ),
        (vec!["skill", "disable", "demo-skill"], "skill.disable/1"),
        (
            vec!["skill", "uninstall", "demo-skill", "--yes"],
            "skill.uninstall/1",
        ),
        (vec!["skill", "show", "nope"], "error/1"),
        (vec!["plugin", "show", "nope"], "error/1"),
    ];
    let mut trash = None;
    for (args, want) in cases {
        let mut all = vec!["--json"];
        all.extend(args.iter().copied());
        let o = h.run(&all);
        let v = doc(&o);
        let schema = v["schema"].as_str().unwrap_or("");
        assert_eq!(schema, want, "{args:?} -> {v}");
        assert!(schema == "error/1" || is_schema_id(schema), "{schema}");
        if want == "skill.uninstall/1" {
            trash = v["trashId"].as_str().map(str::to_string);
        }
    }
    let tid = trash.expect("the uninstall answered a trash id");
    let v = ok_doc(
        &h.run(&["--json", "skill", "restore", &tid]),
        "skill.restore/1",
    );
    assert_eq!(v["name"], "demo-skill", "{v}");
}

/// Review Focus 5 through the CLI: `install --enable` of the package already installed is a no-op, and the CLI says
/// that nothing was enabled (the engine answers `replaced: false, state: installed`), offline and online alike.
#[test]
fn installing_the_identical_package_with_enable_says_nothing_was_enabled() {
    for online in [false, true] {
        let h = Home::new();
        let _s = online.then(|| h.start());
        let pkg = h.write("demo-skill.p1x", &skill_pkg(&h, "demo-skill"));
        ok_doc(
            &h.run(&["--json", "skill", "install", p(&pkg), "--yes"]),
            "skill.install/1",
        );
        let o = h.run(&["--json", "skill", "install", p(&pkg), "--enable", "--yes"]);
        let v = ok_doc(&o, "skill.install/1");
        assert_eq!(
            (v["replaced"].clone(), v["state"].clone()),
            (json!(false), json!("installed")),
            "{v}"
        );
        let e = stderr(&o);
        assert!(
            e.contains("already installed from this very package")
                && e.contains("skill enable demo-skill"),
            "online={online}: {e}"
        );
        assert_eq!(h.index_enabled("demo-skill"), Some(false));
    }
}

/// X1-R18: uninstalling a bundled skill hides it; the result's `trashId` is `null` and the human text says so.
#[test]
fn uninstalling_a_bundled_skill_renders_a_null_trash_id() {
    let h = Home::new();
    std::fs::write(
        h.home.join("manifest.json"),
        json!({"skills": [{"name": "ops", "source": "bundled", "version": "1.2.0"}]}).to_string(),
    )
    .unwrap();
    std::fs::create_dir_all(h.home.join("skills/ops")).unwrap();
    std::fs::write(h.home.join("skills/ops/SKILL.md"), skill_md("ops")).unwrap();
    let v = ok_doc(
        &h.run(&["--json", "skill", "uninstall", "ops", "--yes"]),
        "skill.uninstall/1",
    );
    assert_eq!(v["trashId"], Value::Null, "{v}");
    let o = h.run(&["skill", "list"]);
    assert!(!stdout(&o).contains("ops"), "{}", stdout(&o));

    std::fs::write(
        h.home.join("manifest.json"),
        json!({"skills": [{"name": "ops2", "source": "bundled", "version": "1.2.0"}]}).to_string(),
    )
    .unwrap();
    std::fs::create_dir_all(h.home.join("skills/ops2")).unwrap();
    std::fs::write(h.home.join("skills/ops2/SKILL.md"), skill_md("ops2")).unwrap();
    let o = h.run(&["skill", "uninstall", "ops2", "--yes"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert!(stdout(&o).contains("hid ops2"), "{}", stdout(&o));
    assert!(!stdout(&o).contains("null"), "{}", stdout(&o));
}

/// X1-C19: an uninstall that enabled dependents block answers `required-by` with the dependents in `data`, offline and
/// online, and the human text names them and `--cascade`.
#[test]
fn an_uninstall_blocked_by_dependents_names_them() {
    for online in [false, true] {
        let h = Home::new();
        let a = h.write("fixture.p1x", &module_pkg(&h, "fixture", &["core"]));
        let b = h.write(
            "fixture-b.p1x",
            &module_pkg(&h, "fixture-b", &["core", "fixture"]),
        );
        for (pkg, name) in [(&a, "fixture"), (&b, "fixture-b")] {
            ok_doc(
                &h.run(&["--json", "plugin", "install", p(pkg), "--enable", "--yes"]),
                "plugin.install/1",
            );
            assert_eq!(h.config()["modules"][name]["enabled"], true);
        }
        // The modules are installed offline; the supervisor (no core) only answers the uninstall.
        let _s = online.then(|| h.start());
        let v = err_doc(
            &h.run(&["--json", "plugin", "uninstall", "fixture", "--yes"]),
            1,
            "E_CONFLICT",
            "required-by",
        );
        assert_eq!(
            v["data"]["dependents"],
            json!(["fixture-b"]),
            "online={online}: {v}"
        );
        let o = h.run(&["plugin", "uninstall", "fixture", "--yes"]);
        assert!(
            stderr(&o).contains("required by: fixture-b") && stderr(&o).contains("--cascade"),
            "{}",
            stderr(&o)
        );
        assert!(h.home.join("modules/fixture/module.json").is_file());
    }
}

/// Spec §8.3, X1-C24: outside a terminal a due tier or downgrade acknowledgment needs its `--allow-*` flag and `--yes`;
/// the flag alone is refused (exit 2, the hint names `--yes`) and writes nothing, offline and online.
#[test]
fn an_allow_flag_without_yes_outside_a_terminal_is_refused() {
    for online in [false, true] {
        let h = Home::new();
        let _s = online.then(|| h.start());
        let before = guarded(&h.home);
        let dir = skill_folder(&h, "demo-scripts");
        let v = err_doc(
            &h.run(&["--json", "skill", "install", p(&dir), "--allow-unsigned"]),
            2,
            "E_APPROVAL_REQUIRED",
            "acknowledge-unsigned",
        );
        assert_eq!(v["data"]["trust"]["tier"], "unsigned", "{v}");
        let o = h.run(&["skill", "install", p(&dir), "--allow-unsigned"]);
        assert_eq!(code(&o), 2, "{}", stderr(&o));
        assert!(
            stderr(&o).contains("--allow-unsigned --yes"),
            "{}",
            stderr(&o)
        );
        assert!(
            guarded(&h.home) == before,
            "online={online}: a refusal wrote"
        );
    }
}

/// Uninstall looks the name up before it asks: an unknown or invalid name is its own error, not "re-run with --yes";
/// the question for a bundled skill says it is hidden.
#[test]
fn uninstall_checks_the_name_before_asking_and_names_a_bundled_hide() {
    let h = Home::new();
    err_doc(
        &h.run(&["--json", "skill", "uninstall", "nope"]),
        1,
        "E_NOT_FOUND",
        "extension-unknown",
    );
    let o = h.run(&["--json", "skill", "uninstall", "Bad Name"]);
    assert_eq!(
        (code(&o), doc(&o)["error"].clone()),
        (1, json!("E_INVALID_PARAMS"))
    );
    std::fs::write(
        h.home.join("manifest.json"),
        json!({"skills": [{"name": "ops", "source": "bundled", "version": "1.2.0"}]}).to_string(),
    )
    .unwrap();
    std::fs::create_dir_all(h.home.join("skills/ops")).unwrap();
    std::fs::write(h.home.join("skills/ops/SKILL.md"), skill_md("ops")).unwrap();
    let o = h.run(&["skill", "uninstall", "ops"]);
    assert_eq!(code(&o), 2);
    assert!(
        stderr(&o).contains("hide the bundled skill ops"),
        "{}",
        stderr(&o)
    );
    assert!(!stderr(&o).contains("trash"), "{}", stderr(&o));
    // A module name under `skill uninstall` points to `plugin uninstall`.
    let pkg = h.write("fixture.p1x", &module_pkg(&h, "fixture", &["core"]));
    ok_doc(
        &h.run(&["--json", "plugin", "install", p(&pkg), "--yes"]),
        "plugin.install/1",
    );
    let v = err_doc(
        &h.run(&["--json", "skill", "uninstall", "fixture", "--yes"]),
        1,
        "E_NOT_FOUND",
        "extension-unknown",
    );
    assert_eq!(v["detail"], "use plugin uninstall fixture", "{v}");
    assert!(h.home.join("modules/fixture").is_dir());
}

/// Review Focus 5: `install --enable=<agent>` of the identical package on a skill already enabled for every agent is a
/// no-op; the CLI says the agent restriction was not applied and names `skill enable --agent`.
#[test]
fn a_no_op_install_with_an_agent_restriction_says_it_was_not_applied() {
    let h = Home::new();
    h.two_agents();
    let pkg = h.write("demo-skill.p1x", &skill_pkg(&h, "demo-skill"));
    ok_doc(
        &h.run(&["--json", "skill", "install", p(&pkg), "--enable", "--yes"]),
        "skill.install/1",
    );
    let o = h.run(&[
        "--json",
        "skill",
        "install",
        p(&pkg),
        "--enable=bernd",
        "--yes",
    ]);
    let v = ok_doc(&o, "skill.install/1");
    assert_eq!(v["state"], "enabled", "{v}");
    let e = stderr(&o);
    assert!(
        e.contains("agent restriction (bernd) was not applied")
            && e.contains("plur1bus skill enable demo-skill --agent bernd"),
        "{e}"
    );
    assert_eq!(
        h.config()["agents"]["anna"]["skills"]["blocked"],
        Value::Null
    );
}
