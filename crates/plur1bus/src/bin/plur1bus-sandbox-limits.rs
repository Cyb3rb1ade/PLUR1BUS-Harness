//! Trusted exec-only launcher: resource limits apply before the OS sandbox and target start.
#[cfg(unix)]
fn main() {
    use std::os::unix::process::CommandExt;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let run = || -> Result<(), String> {
        if args.len() < 4 {
            return Err("expected cpu-seconds memory-bytes process-count program [args]".into());
        }
        let cpu: libc::rlim_t = args[0].parse().map_err(|_| "invalid cpu limit")?;
        let memory: libc::rlim_t = args[1].parse().map_err(|_| "invalid memory limit")?;
        let count: libc::rlim_t = args[2].parse().map_err(|_| "invalid process limit")?;
        if cpu == 0 || memory == 0 || count == 0 {
            return Err("limits must be positive".into());
        }
        // No privilege gain, core dumps, or processes escaping via a new user namespace on Linux.
        #[cfg(target_os = "linux")]
        unsafe {
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err("no_new_privs failed".into());
            }
        }
        let limits = [
            (libc::RLIMIT_CPU, cpu),
            (libc::RLIMIT_AS, memory),
            (libc::RLIMIT_NPROC, count),
            (libc::RLIMIT_CORE, 0),
        ];
        for (resource, value) in limits {
            // Darwin rejects RLIMIT_AS. Seatbelt disallows fork; the parent bounds RSS via ps.
            #[cfg(target_os = "macos")]
            if resource == libc::RLIMIT_AS {
                continue;
            }
            let limit = libc::rlimit {
                rlim_cur: value,
                rlim_max: value,
            };
            if unsafe { libc::setrlimit(resource, &limit) } != 0 {
                return Err(format!(
                    "resource limit {resource} failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        Err(std::process::Command::new(&args[3])
            .args(&args[4..])
            .exec()
            .to_string())
    };
    if let Err(e) = run() {
        eprintln!("sandbox launcher: {e}");
        std::process::exit(125);
    }
}
#[cfg(not(unix))]
fn main() {
    eprintln!("sandbox launcher: restricted-token backend unavailable");
    std::process::exit(125);
}
