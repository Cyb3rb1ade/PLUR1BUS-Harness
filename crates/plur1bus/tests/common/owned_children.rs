//! Test-only cleanup of native peers owned by one temporary supervisor home.
pub fn address(home: &std::path::Path, role: &str) -> String {
    #[cfg(windows)]
    {
        use sha2::Digest;
        let hash = format!(
            "{:x}",
            sha2::Sha256::digest(home.to_string_lossy().to_lowercase())
        );
        format!(r"\\.\pipe\plur1bus-{}-{role}", &hash[..16])
    }
    #[cfg(not(windows))]
    {
        home.join("run")
            .join(format!("{role}.sock"))
            .display()
            .to_string()
    }
}

fn recorded(path: &std::path::Path) -> Option<u32> {
    std::fs::read_to_string(path)
        .ok()?
        .split_whitespace()
        .next()?
        .parse::<u32>()
        .ok()
        .filter(|pid| *pid > 0)
}

fn another_supervisor(home: &std::path::Path, ours: u32) -> bool {
    recorded(&home.join("run/supervisor.pid")).is_some_and(|pid| {
        pid != ours && plur1bus_rpc::process::alive(pid) != plur1bus_rpc::process::Liveness::Gone
    })
}

fn peers(home: &std::path::Path) -> Vec<(u32, plur1bus_rpc::process::Incarnation)> {
    let mut peers = Vec::new();
    let Ok(entries) = std::fs::read_dir(home.join("run")) else {
        return peers;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(role) = name.strip_suffix(".pid") else {
            continue;
        };
        if !["core", "tools", "api"].contains(&role) && !role.starts_with("module-") {
            continue;
        }
        let Some(pid) = recorded(&entry.path()) else {
            continue;
        };
        if pid == std::process::id() {
            continue;
        }
        let address = address(home, role);
        if plur1bus_rpc::trust::verify_address(&address).is_err() {
            continue;
        }
        let Ok(stream) =
            plur1bus_rpc::transport::connect(&address, std::time::Duration::from_millis(50))
        else {
            continue;
        };
        if stream.peer_pid() != Some(pid) {
            continue;
        }
        if let Ok(incarnation) = plur1bus_rpc::process::incarnation_of(pid) {
            peers.push((pid, incarnation));
        }
    }
    peers
}

/// A failed test must not leave the tools child's long orphan grace running. Never touch peers handed to a new supervisor.
pub fn cleanup(home: &std::path::Path, supervisor_pid: u32) {
    use plur1bus_rpc::process::{alive, incarnation_of, Liveness};
    use std::time::{Duration, Instant};
    if another_supervisor(home, supervisor_pid) {
        return;
    }
    let start = Instant::now();
    let mut signalled = std::collections::BTreeMap::new();
    loop {
        if another_supervisor(home, supervisor_pid) {
            return;
        }
        if start.elapsed() < Duration::from_millis(500) {
            for (pid, incarnation) in peers(home) {
                if signalled.contains_key(&pid)
                    || incarnation_of(pid).ok().as_ref() != Some(&incarnation)
                {
                    continue;
                }
                #[cfg(unix)]
                // SAFETY: this private-home socket's kernel peer PID and process incarnation were both verified above.
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
                #[cfg(windows)]
                {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                }
                signalled.insert(pid, incarnation);
            }
        }
        let gone = signalled.iter().all(|(&pid, incarnation)| {
            alive(pid) == Liveness::Gone || incarnation_of(pid).ok().as_ref() != Some(incarnation)
        });
        if (start.elapsed() >= Duration::from_millis(500) && gone)
            || start.elapsed() >= Duration::from_secs(2)
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
