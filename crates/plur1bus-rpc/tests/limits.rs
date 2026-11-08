//! `limits::raise_open_files` (P4-10 security review M2, fix round 1b F1/F6), each case in a child process of its own:
//! the child starts under the limits a shell sets (`ulimit`), raises, and prints what is in force. No test changes this
//! test process's limits.
#![cfg(unix)]

use std::process::Command;

const CHILD: &str = "PLUR1BUS_LIMITS_CHILD";

/// The soft and hard limit in force after `raise_open_files` in a child started under `setup` (shell commands); `None`
/// when the shell refused `setup` (e.g. a hard limit above this process's own).
fn raised_in_child(setup: &str) -> Option<(u64, String)> {
    let exe = std::env::current_exe().unwrap();
    let out = Command::new("/bin/sh")
        .arg("-c")
        .arg(format!(
            r#"{setup} || exit 97; exec "$0" --exact child_probe --nocapture"#
        ))
        .arg(exe)
        .env(CHILD, "1")
        .output()
        .unwrap();
    if out.status.code() == Some(97) {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout
        .lines()
        .find_map(|l| l.strip_prefix("limits: "))
        .unwrap_or_else(|| {
            panic!(
                "no result from the child: {stdout} {}",
                String::from_utf8_lossy(&out.stderr)
            )
        });
    let mut parts = line.split_whitespace();
    let soft = parts.next().unwrap().parse().unwrap();
    let hard = parts.next().unwrap().to_owned();
    Some((soft, hard))
}

/// Puts the descriptor limit back as it was when dropped. The probe runs in a child process of its own, so nothing else
/// sees its limit; the guard keeps it so should the probe ever run inside a shared test process.
struct Restore(libc::rlimit);

impl Restore {
    fn now() -> Restore {
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: `limit` is a live, writable rlimit for the duration of the call.
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) },
            0
        );
        Restore(limit)
    }
}

impl Drop for Restore {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a live, initialised rlimit that the call only reads.
        unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &self.0) };
    }
}

/// Run as the child only (`PLUR1BUS_LIMITS_CHILD`): raises, checks that raising again changes nothing, prints the result.
#[test]
fn child_probe() {
    if std::env::var_os(CHILD).is_none() {
        return;
    }
    let _restore = Restore::now();
    let first = plur1bus_rpc::limits::raise_open_files().unwrap();
    assert_eq!(
        plur1bus_rpc::limits::raise_open_files(),
        Some(first),
        "raising again changes nothing"
    );
    let hard = Command::new("/bin/sh")
        .args(["-c", "ulimit -Hn"])
        .output()
        .unwrap();
    println!(
        "limits: {first} {}",
        String::from_utf8_lossy(&hard.stdout).trim()
    );
}

#[test]
fn a_finite_hard_limit_is_taken_whole() {
    // GitHub's ubuntu runners and systemd user units have a finite hard limit; launchd's soft default is 256.
    for hard in [4096_u64, 65536] {
        let Some((soft, in_force)) =
            raised_in_child(&format!("ulimit -Sn 256 && ulimit -Hn {hard}"))
        else {
            println!("skipped: this process's hard limit is below {hard}");
            continue;
        };
        assert_eq!(soft, hard, "the soft limit is the hard one");
        assert_eq!(in_force, hard.to_string(), "the hard limit is left alone");
    }
}

#[test]
fn an_unlimited_hard_limit_is_searched_up_to_the_kernels_cap() {
    let Some((soft, in_force)) = raised_in_child("ulimit -Sn 256 && ulimit -Hn unlimited") else {
        println!("skipped: the hard limit here is finite");
        return;
    };
    assert_eq!(in_force, "unlimited");
    assert!(soft > 256, "raised from launchd's default ({soft})");
    assert!(soft <= 1 << 20, "Node's ceiling ({soft})");
    #[cfg(target_os = "macos")]
    {
        let cap = Command::new("sysctl")
            .args(["-n", "kern.maxfilesperproc"])
            .output()
            .unwrap();
        let cap: u64 = String::from_utf8_lossy(&cap.stdout).trim().parse().unwrap();
        assert_eq!(
            soft,
            cap.min(1 << 20),
            "macOS: what a process can use, kern.maxfilesperproc"
        );
    }
}

#[test]
fn a_soft_limit_at_the_hard_one_stays() {
    let Some((soft, in_force)) = raised_in_child("ulimit -Sn 300 && ulimit -Hn 300") else {
        println!("skipped");
        return;
    };
    assert_eq!((soft, in_force.as_str()), (300, "300"));
}

/// Task review I6: macOS accepts (or a parent left) a soft limit above `kern.maxfilesperproc`, but a process can never
/// hold more descriptors than that cap: the count reported is the one the process can use.
#[cfg(target_os = "macos")]
#[test]
fn a_soft_limit_above_the_kernels_cap_counts_as_the_cap() {
    let cap = Command::new("sysctl")
        .args(["-n", "kern.maxfilesperproc"])
        .output()
        .unwrap();
    let cap: u64 = String::from_utf8_lossy(&cap.stdout).trim().parse().unwrap();
    let above = (cap + 1).max(1 << 20) - 1;
    let Some((soft, _)) = raised_in_child(&format!("ulimit -Hn unlimited && ulimit -Sn {above}"))
    else {
        println!("skipped: a soft limit above kern.maxfilesperproc cannot be set here");
        return;
    };
    assert_eq!(soft, cap, "what the process can use");
}
