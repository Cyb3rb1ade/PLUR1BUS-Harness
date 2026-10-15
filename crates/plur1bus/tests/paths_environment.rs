//! The binary in odd environments, every one set per child process (never `set_var` in the test process): a home directory that
//! may not be written, spaces and umlauts, XDG variables that must not matter, paths beyond the file system's limits, a `--home`
//! that is a file, two installations side by side, and foreign files in a home that must stay byte-for-byte as they were.
//! Resolution of the home string itself is tested against Node in `src/paths.rs`.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

fn run(home_dir: &Path, cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
    c.args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", home_dir)
        .env("USERPROFILE", home_dir)
        .stdin(Stdio::null());
    for (k, v) in env {
        c.env(k, v);
    }
    c.output().unwrap()
}

fn json(o: &Output) -> Value {
    serde_json::from_slice(&o.stdout).unwrap_or_else(|e| {
        panic!(
            "not JSON ({e}): {:?} / {:?}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        )
    })
}

fn tree(root: &Path) -> BTreeMap<String, String> {
    fn go(base: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let rel = e
                .path()
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let ft = e.file_type().unwrap();
            if ft.is_dir() {
                out.insert(rel, "dir".into());
                go(base, &e.path(), out);
            } else if ft.is_file() {
                out.insert(
                    rel,
                    format!(
                        "{:x}",
                        Sha256::digest(fs::read(e.path()).unwrap_or_default())
                    ),
                );
            }
        }
    }
    let mut m = BTreeMap::new();
    go(root, root, &mut m);
    m
}

#[cfg(unix)]
fn is_root() -> bool {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() == 0 }
}

#[cfg(unix)]
#[test]
fn a_home_directory_that_may_not_be_written_is_a_clean_error_not_a_panic() {
    use std::os::unix::fs::PermissionsExt;
    if is_root() {
        return; // root writes anywhere; the case does not exist
    }
    let d = tempfile::tempdir().unwrap();
    let user = d.path().join("user");
    fs::create_dir(&user).unwrap();
    fs::set_permissions(&user, fs::Permissions::from_mode(0o555)).unwrap();
    for args in [
        vec!["--json", "config", "get"],
        vec!["--json", "agent", "create", "bernd"],
        vec!["--json", "config", "set", "core.logLevel", "debug", "--yes"],
    ] {
        let o = run(&user, d.path(), &args, &[]);
        let stderr = String::from_utf8_lossy(&o.stderr);
        assert!(!stderr.contains("panicked"), "{args:?}: {stderr}");
        assert_eq!(
            o.status.code(),
            Some(1),
            "{args:?}: {} / {stderr}",
            String::from_utf8_lossy(&o.stdout)
        );
        let v = json(&o);
        assert_eq!(v["schema"], "error/1", "{args:?}");
        assert!(
            v["error"].as_str().is_some_and(|c| c.starts_with("E_")),
            "{v}"
        );
    }
    assert!(
        !user.join(".plur1bus").exists(),
        "nothing was created in a directory that may not be written"
    );
    // Reading what is there still works: a read-only home with an existing installation.
    let existing = d.path().join("existing");
    fs::create_dir_all(existing.join(".plur1bus")).unwrap();
    fs::write(
        existing.join(".plur1bus/config.json"),
        r#"{"schemaVersion":1}"#,
    )
    .unwrap();
    fs::set_permissions(
        existing.join(".plur1bus"),
        fs::Permissions::from_mode(0o555),
    )
    .unwrap();
    let o = run(&existing, d.path(), &["--json", "module", "list"], &[]);
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    fs::set_permissions(
        existing.join(".plur1bus"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::set_permissions(&user, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn a_home_with_spaces_and_umlauts_works_for_create_list_and_remove() {
    let d = tempfile::tempdir().unwrap();
    for name in [
        "mit Leerzeichen",
        "Jürgen Müller",
        "日本語 ✓",
        "a'b\"c",
        "  führend und folgend  ",
    ] {
        let home = d.path().join(name).join(".plur1bus");
        let h = home.to_str().unwrap();
        assert_eq!(
            run(
                d.path(),
                d.path(),
                &["--home", h, "--json", "agent", "create", "bernd"],
                &[]
            )
            .status
            .code(),
            Some(0),
            "{name}"
        );
        let listed = json(&run(
            d.path(),
            d.path(),
            &["--home", h, "--json", "agent", "list"],
            &[],
        ));
        assert_eq!(listed["agents"][0]["agentId"], "bernd", "{name}: {listed}");
        assert!(home.join("config.json").is_file(), "{name}");
        assert_eq!(
            run(
                d.path(),
                d.path(),
                &["--home", h, "--json", "agent", "remove", "bernd"],
                &[]
            )
            .status
            .code(),
            Some(0),
            "{name}"
        );
    }
}

#[test]
fn xdg_variables_and_an_empty_plur1bus_home_do_not_move_the_default_home() {
    let d = tempfile::tempdir().unwrap();
    let user = d.path().join("user");
    let xdg = d.path().join("xdg");
    fs::create_dir_all(&user).unwrap();
    fs::create_dir_all(&xdg).unwrap();
    let env = [
        ("XDG_CONFIG_HOME", xdg.to_str().unwrap()),
        ("XDG_DATA_HOME", xdg.to_str().unwrap()),
        ("XDG_STATE_HOME", xdg.to_str().unwrap()),
        ("XDG_CACHE_HOME", xdg.to_str().unwrap()),
        ("PLUR1BUS_HOME", ""),
    ];
    let o = run(&user, d.path(), &["--json", "config", "get"], &env);
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    assert!(
        user.join(".plur1bus/config.json").is_file(),
        "the default home is ~/.plur1bus"
    );
    assert!(
        tree(&xdg).is_empty(),
        "something was written under an XDG directory: {:?}",
        tree(&xdg)
    );
    // PLUR1BUS_HOME, when set, wins over the default; --home wins over both.
    let from_env = d.path().join("from-env");
    let from_flag = d.path().join("from-flag");
    let o = run(
        &user,
        d.path(),
        &["--json", "config", "get"],
        &[("PLUR1BUS_HOME", from_env.to_str().unwrap())],
    );
    assert_eq!(o.status.code(), Some(0));
    assert!(from_env.join("config.json").is_file());
    let o = run(
        &user,
        d.path(),
        &[
            "--home",
            from_flag.to_str().unwrap(),
            "--json",
            "config",
            "get",
        ],
        &[("PLUR1BUS_HOME", from_env.to_str().unwrap())],
    );
    assert_eq!(o.status.code(), Some(0));
    assert!(from_flag.join("config.json").is_file());
}

#[test]
fn a_relative_home_is_resolved_against_the_working_directory_of_the_process() {
    let d = tempfile::tempdir().unwrap();
    let work = d.path().join("work dir");
    fs::create_dir_all(&work).unwrap();
    let o = run(
        d.path(),
        &work,
        &["--home", "rel/home", "--json", "config", "get"],
        &[],
    );
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    assert!(work.join("rel/home/config.json").is_file());
    let o = run(
        d.path(),
        &work.join("rel"),
        &["--home", "../rel/./home/../home", "--json", "config", "get"],
        &[],
    );
    assert_eq!(o.status.code(), Some(0));
    assert!(!work.join("rel/home/home").exists());
}

#[test]
fn a_home_beyond_the_file_systems_limits_is_a_clean_error_and_creates_nothing() {
    let d = tempfile::tempdir().unwrap();
    // A component beyond NAME_MAX (255) and a whole path beyond PATH_MAX.
    let long_name = d.path().join("n".repeat(300));
    let mut long_path = d.path().to_path_buf();
    for _ in 0..40 {
        long_path.push("d".repeat(200));
    }
    for home in [&long_name, &long_path] {
        for args in [
            vec!["--json", "config", "get"],
            vec!["--json", "agent", "list"],
            vec!["--json", "1staid", "check"],
        ] {
            let mut full: Vec<&str> = vec!["--home", home.to_str().unwrap()];
            full.extend(args.iter().copied());
            let o = run(d.path(), d.path(), &full, &[]);
            let stderr = String::from_utf8_lossy(&o.stderr);
            assert!(!stderr.contains("panicked"), "{args:?}: {stderr}");
            assert!(o.status.code().is_some(), "{args:?} was killed by a signal");
            // Either a clean failure with an error document, or (for read-only commands) an answer; never garbage on stdout.
            if o.status.code() != Some(0) {
                let v = json(&o);
                // A failing command prints an error document; `1staid check` prints its own document with the failing check in it.
                assert!(
                    v["schema"] == "error/1" || v["schema"] == "1staid.check/1",
                    "{args:?}: {v}"
                );
            }
        }
        assert!(
            !home.exists(),
            "a home beyond the limits cannot have been created"
        );
    }
}

#[test]
fn a_home_that_is_a_file_is_a_clean_error_and_the_file_is_untouched() {
    let d = tempfile::tempdir().unwrap();
    let file = d.path().join("i-am-a-file");
    fs::write(&file, "precious").unwrap();
    for args in [
        vec!["--json", "config", "get"],
        vec!["--json", "agent", "create", "bernd"],
        vec!["--json", "1staid", "check"],
    ] {
        let mut full: Vec<&str> = vec!["--home", file.to_str().unwrap()];
        full.extend(args.iter().copied());
        let o = run(d.path(), d.path(), &full, &[]);
        assert!(
            !String::from_utf8_lossy(&o.stderr).contains("panicked"),
            "{args:?}"
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "precious", "{args:?}");
    }
}

#[test]
fn two_installations_side_by_side_share_nothing() {
    let d = tempfile::tempdir().unwrap();
    let (a, b) = (d.path().join("A"), d.path().join("B"));
    let (ha, hb) = (a.to_str().unwrap(), b.to_str().unwrap());
    assert_eq!(
        run(
            d.path(),
            d.path(),
            &["--home", ha, "--json", "agent", "create", "only-in-a"],
            &[]
        )
        .status
        .code(),
        Some(0)
    );
    assert_eq!(
        run(
            d.path(),
            d.path(),
            &["--home", hb, "--json", "agent", "create", "only-in-b"],
            &[]
        )
        .status
        .code(),
        Some(0)
    );
    let la = json(&run(
        d.path(),
        d.path(),
        &["--home", ha, "--json", "agent", "list"],
        &[],
    ));
    let lb = json(&run(
        d.path(),
        d.path(),
        &["--home", hb, "--json", "agent", "list"],
        &[],
    ));
    let ids = |v: &Value| {
        v["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["agentId"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&la), ["only-in-a"]);
    assert_eq!(ids(&lb), ["only-in-b"]);
    // Their service identities differ, so registering one never takes over the other.
    let name_a = json(&run(
        d.path(),
        d.path(),
        &["--home", ha, "--json", "service", "status"],
        &[],
    ))["name"]
        .clone();
    let name_b = json(&run(
        d.path(),
        d.path(),
        &["--home", hb, "--json", "service", "status"],
        &[],
    ))["name"]
        .clone();
    assert_ne!(name_a, name_b);
    // And nothing was written outside the two homes and the temp dir's own entries.
    assert_eq!(
        tree(d.path())
            .keys()
            .filter(|k| !k.starts_with("A") && !k.starts_with("B"))
            .count(),
        0
    );
}

/// Foreign files in a home (the user's notes, another tool's state, an unknown file next to the config) are never overwritten,
/// moved, renamed or deleted by the everyday commands.
#[test]
fn foreign_files_in_a_home_survive_the_everyday_commands_byte_for_byte() {
    let d = tempfile::tempdir().unwrap();
    let home: PathBuf = d.path().join("home");
    let h = home.to_str().unwrap();
    let foreign = [
        ("README.txt", "my notes"),
        ("notes/todo.md", "- keep me"),
        ("state/foreign.db", "another tool's database"),
        ("state/journal/not-an-agent.txt", "stray file"),
        ("logs/foreign.log", "another log"),
        ("agents/stray-file.txt", "not an agent directory"),
        ("skills/readme.md", "a stray skill note"),
        ("config.json.user-backup", "{\"mine\":true}"),
        (".env", "SOME=thing"),
    ];
    for (p, c) in foreign {
        let f = home.join(p);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, c).unwrap();
    }
    let before: BTreeMap<String, String> = tree(&home);
    for args in [
        vec!["config", "get"],
        vec!["config", "set", "core.logLevel", "debug", "--yes"],
        vec!["config", "set", "core.logLevel", "info", "--yes"],
        vec!["agent", "create", "bernd"],
        vec!["agent", "list"],
        vec!["agent", "remove", "bernd", "--yes"],
        vec!["module", "list"],
        vec!["1staid", "check"],
        vec!["daemon", "status"],
        vec!["update", "status"],
        vec!["model", "list"],
        vec!["skill", "list"],
    ] {
        let mut full: Vec<&str> = vec!["--home", h, "--json"];
        full.extend(args.iter().copied());
        let o = run(d.path(), d.path(), &full, &[]);
        assert!(
            !String::from_utf8_lossy(&o.stderr).contains("panicked"),
            "{args:?}"
        );
        let after = tree(&home);
        for (path, hash) in &before {
            assert_eq!(
                after.get(path),
                Some(hash),
                "`{}` changed or removed {path}",
                args.join(" ")
            );
        }
    }
    for (p, c) in foreign {
        assert_eq!(fs::read_to_string(home.join(p)).unwrap(), c, "{p}");
    }
}
