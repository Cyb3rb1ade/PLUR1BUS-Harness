//! `supervisor.maxCores` (docs/superpowers/specs/2026-10-24-cpu-core-limit-design.md): the supervisor binds itself and
//! its core to the first `maxCores` CPUs the system allows it, reports it in `daemon.status`, and a change applies at
//! once. Linux only: there `/proc` shows every thread's CPUs.
#![cfg(target_os = "linux")]
mod common;

use common::{
    assert_valid, client, start_with_core, start_with_core_using, wait_child, wait_until, WAIT,
};
use plur1bus_rpc::Client;
use serde_json::{json, Value};
use std::process::Command;

/// The CPUs one thread may run on (`Cpus_allowed_list` of `/proc/<pid>/task/<tid>/status`).
fn allowed(status: &str) -> Vec<usize> {
    let list = status
        .lines()
        .find_map(|l| l.strip_prefix("Cpus_allowed_list:"))
        .unwrap()
        .trim();
    list.split(',')
        .flat_map(|r| match r.split_once('-') {
            Some((a, b)) => (a.parse().unwrap()..=b.parse().unwrap()).collect::<Vec<usize>>(),
            None => vec![r.parse().unwrap()],
        })
        .collect()
}

/// The CPUs of every thread of `pid`.
fn threads(pid: u32) -> Vec<Vec<usize>> {
    std::fs::read_dir(format!("/proc/{pid}/task"))
        .unwrap()
        .flatten()
        .filter_map(|t| std::fs::read_to_string(t.path().join("status")).ok())
        .map(|s| allowed(&s))
        .collect()
}

fn cpu(c: &mut Client) -> Value {
    let st = c.call("daemon.status", json!({})).unwrap();
    assert_valid("methods/daemon.status/result", &st);
    st["cpu"].clone()
}

#[test]
fn max_cores_binds_the_core_and_a_change_applies_live() {
    let start = allowed(&std::fs::read_to_string("/proc/self/status").unwrap());
    if start.len() < 2 {
        eprintln!("skipped: this host offers one CPU");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(
        home.join("config.json"),
        json!({ "schemaVersion": 1, "supervisor": { "maxCores": 1 } }).to_string(),
    )
    .unwrap();
    let events = dir.path().join("events.jsonl");
    let sup = start_with_core(&home, &events, "0.2", &[]);
    let mut c = client(&home);
    let core = wait_child(&mut c, "a ready core", WAIT, |ch| {
        ch["process"]["state"] == "ready"
    });
    let pid = core["pid"].as_u64().unwrap() as u32;

    let limited = cpu(&mut c);
    assert_eq!(limited["state"], "limited", "{limited}");
    assert_eq!(limited["maxCores"], 1, "{limited}");
    assert_eq!(limited["effective"], 1, "{limited}");
    assert!(limited["detected"].as_u64().unwrap() >= 2, "{limited}");
    let first = vec![start[0]];
    for p in [sup.child.id(), pid] {
        let t = threads(p);
        assert!(!t.is_empty());
        assert!(t.iter().all(|cpus| *cpus == first), "process {p}: {t:?}");
    }
    // The CLI shows it: one line for people, the raw object in `--json`.
    let detected = limited["detected"].as_u64().unwrap();
    let status = |json: bool| {
        let mut cmd = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
        cmd.arg("--home").arg(&home).args(["daemon", "status"]);
        if json {
            cmd.arg("--json");
        }
        String::from_utf8(cmd.output().unwrap().stdout).unwrap()
    };
    let human = status(false);
    assert!(
        human.contains(&format!("cpu: 1 of {detected} cores (supervisor.maxCores)")),
        "{human}"
    );
    let doc: Value = serde_json::from_str(&status(true)).unwrap();
    assert_eq!(doc["schema"], "daemon.status/1", "{doc}");
    assert_eq!(doc["cpu"], limited, "{doc}");

    let r = c
        .call(
            "config.set",
            json!({ "changes": [{ "key": "supervisor.maxCores", "value": 0 }] }),
        )
        .unwrap();
    assert_valid("methods/config.set/result", &r);
    assert_eq!(
        r["restart"]["core"], false,
        "a live key restarts nothing: {r}"
    );
    wait_until("the limit to be removed", WAIT, || {
        cpu(&mut c)["state"] == "unlimited"
    });
    assert_eq!(cpu(&mut c)["effective"], cpu(&mut c)["detected"]);
    for p in [sup.child.id(), pid] {
        let t = threads(p);
        assert!(t.iter().all(|cpus| *cpus == start), "process {p}: {t:?}");
    }
    let same = wait_child(&mut c, "the same core", WAIT, |ch| ch["pid"] == core["pid"]);
    assert_eq!(same["restarts"], 0, "{same}");
}

/// A supervisor started on one CPU (say by `plur1bus daemon restart` run from a process an earlier supervisor had
/// bound) still detects every core the system allows, and without a limit it widens itself and its core to all of them.
#[test]
fn a_supervisor_started_on_one_cpu_detects_every_core_and_widens_without_a_limit() {
    let start = allowed(&std::fs::read_to_string("/proc/self/status").unwrap());
    if start.len() < 2 {
        eprintln!("skipped: this host offers one CPU");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(
        home.join("config.json"),
        json!({ "schemaVersion": 1 }).to_string(),
    )
    .unwrap();
    let events = dir.path().join("events.jsonl");
    let first = start[0];
    let sup = start_with_core_using(&home, &events, "0.2", &[], move |cmd| {
        use std::os::unix::process::CommandExt;
        // SAFETY: only async-signal-safe calls between fork and exec: a zeroed set, CPU_SET below CPU_SETSIZE and one
        // syscall.
        unsafe {
            cmd.pre_exec(move || {
                let mut set: libc::cpu_set_t = std::mem::zeroed();
                libc::CPU_SET(first, &mut set);
                if libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &set) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    });
    let mut c = client(&home);
    let core = wait_child(&mut c, "a ready core", WAIT, |ch| {
        ch["process"]["state"] == "ready"
    });
    let status = cpu(&mut c);
    assert_eq!(status["state"], "unlimited", "{status}");
    assert_eq!(
        status["detected"].as_u64(),
        Some(start.len() as u64),
        "{status}"
    );
    assert_eq!(status["effective"], status["detected"], "{status}");
    for p in [sup.child.id(), core["pid"].as_u64().unwrap() as u32] {
        let t = threads(p);
        assert!(t.iter().all(|cpus| *cpus == start), "process {p}: {t:?}");
    }
}
