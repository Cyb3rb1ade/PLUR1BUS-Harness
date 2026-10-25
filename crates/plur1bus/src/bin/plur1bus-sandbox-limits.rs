//! Trusted exec-only launcher: resource limits apply before the OS sandbox and target start.
//!
//! The outer mode never sets a process limit: it would count the user's tasks system-wide. The Linux inner modes
//! only set RLIMIT_NPROC in a different user namespace, counted separately by the kernel since Linux 5.14.
#[cfg(unix)]
fn exec(program: &str, args: &[String]) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    Err(std::process::Command::new(program)
        .args(args)
        .exec()
        .to_string())
}

#[cfg(target_os = "linux")]
fn shares_userns(outer: &str) -> bool {
    outer.is_empty()
        || std::fs::read_link("/proc/self/ns/user")
            .map(|own| own.to_string_lossy() == outer)
            .unwrap_or(true)
}

#[cfg(target_os = "linux")]
fn set_tasks(n: libc::rlim_t) -> Result<(), String> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::getrlimit(libc::RLIMIT_NPROC, &mut limit) } != 0 {
        return Err(format!(
            "read process limit failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    limit.rlim_max = n.min(limit.rlim_max);
    limit.rlim_cur = limit.rlim_max;
    if unsafe { libc::setrlimit(libc::RLIMIT_NPROC, &limit) } != 0 {
        return Err(format!(
            "set process limit failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn task_cap(args: &[String]) -> Result<(), String> {
    if args.len() < 5 || args[3] != "--" {
        return Err("expected --tasks n outer-userns -- program [args]".into());
    }
    let n: libc::rlim_t = args[1].parse().map_err(|_| "invalid task limit")?;
    if n == 0 {
        return Err("task limit must be positive".into());
    }
    if shares_userns(&args[2]) {
        eprintln!(
            "sandbox launcher: process cap skipped: the sandbox shares the caller's user namespace"
        );
    } else if let Err(e) = set_tasks(n) {
        // The cap is best effort: an unavailable kernel facility must not prevent the program from starting.
        eprintln!("sandbox launcher: process cap skipped: {e}");
    }
    exec(&args[4], &args[5..])
}

#[cfg(target_os = "linux")]
fn probe_tasks(args: &[String]) -> Result<(), String> {
    if args.len() != 2 {
        return Err("expected --probe-tasks outer-userns".into());
    }
    if shares_userns(&args[1]) {
        println!("shared-userns");
        return Ok(());
    }
    let mut count = 0;
    for pid in std::fs::read_dir("/proc")
        .map_err(|e| e.to_string())?
        .flatten()
    {
        if !pid
            .file_name()
            .as_encoded_bytes()
            .iter()
            .all(u8::is_ascii_digit)
        {
            continue;
        }
        // Tasks may exit between the two directory reads.
        if let Ok(tasks) = std::fs::read_dir(pid.path().join("task")) {
            count += tasks.flatten().count();
        }
    }
    set_tasks(count as libc::rlim_t + 1)?;
    let mut pipe = [0; 2];
    if unsafe { libc::pipe(pipe.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let mut children = Vec::new();
    for _ in 0..4 {
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            break;
        }
        if pid == 0 {
            // Only async-signal-safe operations after fork; each child drops its copy of the writer.
            unsafe {
                libc::close(pipe[1]);
                let mut byte = 0u8;
                while libc::read(pipe[0], (&mut byte as *mut u8).cast(), 1) < 0
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR)
                {
                }
                libc::_exit(0);
            }
        }
        children.push(pid);
    }
    unsafe {
        libc::close(pipe[0]);
        libc::close(pipe[1]);
    }
    for pid in &children {
        while unsafe { libc::waitpid(*pid, std::ptr::null_mut(), 0) } < 0 {
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                break;
            }
        }
    }
    println!(
        "{}",
        match children.len() {
            0 => "per-user",
            1..=2 => "enforced",
            _ => "not-enforced",
        }
    );
    Ok(())
}

#[cfg(all(unix, not(target_os = "linux")))]
fn task_cap(_: &[String]) -> Result<(), String> {
    Err("the task cap mode is Linux-only".into())
}
#[cfg(all(unix, not(target_os = "linux")))]
fn probe_tasks(_: &[String]) -> Result<(), String> {
    Err("the task cap mode is Linux-only".into())
}
#[cfg(unix)]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let run = || -> Result<(), String> {
        match args.first().map(String::as_str) {
            Some("--tasks") => return task_cap(&args),
            Some("--probe-tasks") => return probe_tasks(&args),
            _ => {}
        }
        if args.len() < 3 {
            return Err("expected cpu-seconds memory-bytes program [args]".into());
        }
        let cpu: libc::rlim_t = args[0].parse().map_err(|_| "invalid cpu limit")?;
        let memory: libc::rlim_t = args[1].parse().map_err(|_| "invalid memory limit")?;
        if cpu == 0 || memory == 0 {
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
        exec(&args[2], &args[3..])
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
