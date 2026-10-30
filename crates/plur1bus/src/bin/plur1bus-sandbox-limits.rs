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
        if args[0] == "--tasks-required" {
            return Err("sandbox-unavailable: shared user namespace".into());
        }
        eprintln!(
            "sandbox launcher: process cap skipped: the sandbox shares the caller's user namespace"
        );
    } else if let Err(e) = set_tasks(n) {
        if args[0] == "--tasks-required" {
            return Err(e);
        }
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
#[cfg(target_os = "macos")]
mod watchdog {
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::{AtomicI32, Ordering};
    use std::time::{Duration, Instant};

    static GROUP: AtomicI32 = AtomicI32::new(0);
    extern "C" fn terminate(_: libc::c_int) {
        let group = GROUP.load(Ordering::Relaxed);
        if group > 0 {
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
        }
    }
    type Identity = (u64, u64);
    enum Source {
        Group,
        Child(libc::pid_t),
        Known(Identity),
    }
    fn check_time(deadline: Instant) -> Result<(), String> {
        if Instant::now() >= deadline {
            Err("watchdog sample deadline exceeded".into())
        } else {
            Ok(())
        }
    }
    fn bsd_info(pid: libc::pid_t) -> Result<Option<libc::proc_bsdinfo>, String> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as libc::c_int;
        let got = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        if got == size {
            return Ok(Some(info));
        }
        if unsafe { libc::kill(pid, 0) } != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            return Ok(None);
        }
        Err("watchdog process identity unavailable".into())
    }
    fn identity(info: &libc::proc_bsdinfo) -> Identity {
        (info.pbi_start_tvsec, info.pbi_start_tvusec)
    }
    fn list_pids(
        pid: libc::pid_t,
        group: bool,
        deadline: Instant,
    ) -> Result<Vec<libc::pid_t>, String> {
        type List =
            unsafe extern "C" fn(libc::pid_t, *mut libc::c_void, libc::c_int) -> libc::c_int;
        let list: List = if group {
            libc::proc_listpgrppids
        } else {
            libc::proc_listchildpids
        };
        check_time(deadline)?;
        let count = unsafe { list(pid, std::ptr::null_mut(), 0) };
        check_time(deadline)?;
        if !(0..65536).contains(&count) {
            return Err("watchdog PID list exceeds safety cap".into());
        }
        // libproc returns PID count (buffer size remains bytes). Leave bounded room for new forks.
        let mut pids = vec![0; (count as usize + 64).min(65537)];
        let count = unsafe {
            list(
                pid,
                pids.as_mut_ptr().cast(),
                (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int,
            )
        };
        check_time(deadline)?;
        if count < 0 || count as usize >= pids.len() {
            return Err("watchdog PID list unavailable or truncated".into());
        }
        pids.truncate(count as usize);
        Ok(pids)
    }
    fn sample(
        root: libc::pid_t,
        tasks: usize,
        memory: u64,
        known: &mut HashMap<libc::pid_t, Identity>,
    ) -> Result<(usize, u64), String> {
        let deadline = Instant::now() + Duration::from_millis(40);
        let mut queue: Vec<_> = known
            .iter()
            .map(|(&pid, &id)| (pid, Source::Known(id)))
            .collect();
        queue.extend(
            list_pids(root, true, deadline)?
                .into_iter()
                .map(|pid| (pid, Source::Group)),
        );
        queue.push((root, Source::Group));
        let mut seen = HashSet::new();
        let mut next = HashMap::new();
        let mut rss = 0u64;
        while let Some((pid, source)) = queue.pop() {
            check_time(deadline)?;
            if pid <= 0 {
                continue;
            }
            let Some(info) = bsd_info(pid)? else {
                continue;
            };
            check_time(deadline)?;
            let id = identity(&info);
            // Enumeration races must never turn a reused PID into an unrelated retained descendant.
            let belongs = match source {
                Source::Group => info.pbi_pgid == root as u32,
                Source::Child(parent) => info.pbi_ppid == parent as u32,
                Source::Known(expected) => id == expected,
            };
            if !belongs || !seen.insert((pid, id)) {
                continue;
            }
            if seen.len() > 65536 {
                return Err("watchdog descendant scan exceeds safety cap".into());
            }
            if seen.len() > tasks {
                return Ok((seen.len(), rss));
            }
            let mut task: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of_val(&task) as libc::c_int;
            let got = unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDTASKINFO,
                    0,
                    (&mut task as *mut libc::proc_taskinfo).cast(),
                    size,
                )
            };
            check_time(deadline)?;
            let Some(after) = bsd_info(pid)? else {
                continue;
            };
            check_time(deadline)?;
            if identity(&after) != id {
                continue;
            }
            if got != size {
                return Err("watchdog proc_pidinfo failed".into());
            }
            next.insert(pid, id);
            rss = rss.saturating_add(task.pti_resident_size);
            if rss > memory {
                return Ok((seen.len(), rss));
            }
            queue.extend(
                list_pids(pid, false, deadline)?
                    .into_iter()
                    .map(|child| (child, Source::Child(pid))),
            );
        }
        *known = next;
        Ok((seen.len(), rss))
    }
    pub(super) fn run(args: &[String]) -> Result<(), String> {
        use std::os::unix::process::CommandExt;
        if args.len() < 5 || args[3] != "--" {
            return Err("expected --watch-tree tasks rss -- program [args]".into());
        }
        let tasks: usize = args[1].parse().map_err(|_| "invalid watchdog task limit")?;
        let memory: u64 = args[2].parse().map_err(|_| "invalid watchdog RSS limit")?;
        if tasks == 0 || memory == 0 {
            return Err("watchdog limits must be positive".into());
        }
        let mut command = std::process::Command::new(&args[4]);
        command.args(&args[5..]);
        // A pipe, rather than pre_exec(SIGSTOP), avoids Command::spawn waiting for exec forever.
        let mut gate = [0; 2];
        if unsafe { libc::pipe(gate.as_mut_ptr()) } != 0 {
            return Err("watchdog gate unavailable".into());
        }
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            unsafe {
                libc::close(gate[0]);
                libc::close(gate[1]);
            }
            return Err("watchdog fork failed".into());
        }
        if pid == 0 {
            unsafe {
                libc::close(gate[1]);
                if libc::setpgid(0, 0) != 0 {
                    libc::_exit(125);
                }
                let mut byte = 0u8;
                if libc::read(gate[0], (&mut byte as *mut u8).cast(), 1) != 1 {
                    libc::_exit(125);
                }
                libc::close(gate[0]);
            }
            let _ = command.exec();
            unsafe {
                libc::_exit(125);
            }
        }
        unsafe {
            libc::close(gate[0]);
            libc::setpgid(pid, pid);
        }
        GROUP.store(pid, Ordering::Relaxed);
        unsafe {
            libc::signal(libc::SIGTERM, terminate as libc::sighandler_t);
            libc::signal(libc::SIGINT, terminate as libc::sighandler_t);
        }
        // Attach and validate observation BEFORE releasing the target's exec gate.
        let mut known = HashMap::new();
        let attached = sample(pid, tasks, memory, &mut known);
        if !matches!(attached, Ok((count, rss)) if count <= tasks && rss <= memory) {
            terminate(0);
            unsafe {
                libc::close(gate[1]);
                libc::waitpid(pid, std::ptr::null_mut(), 0);
            }
            return Err("sandbox-unavailable: watchdog attach failed".into());
        }
        unsafe {
            libc::write(gate[1], b"x".as_ptr().cast(), 1);
            libc::close(gate[1]);
        }
        loop {
            let started = Instant::now();
            let mut status = 0;
            let done = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if done == pid {
                terminate(0);
                std::process::exit(if libc::WIFEXITED(status) {
                    libc::WEXITSTATUS(status)
                } else {
                    128 + libc::WTERMSIG(status)
                });
            }
            let exceeded = match sample(pid, tasks, memory, &mut known) {
                Ok((count, _)) if count > tasks => Some((121, "task-limit-exceeded")),
                Ok((_, rss)) if rss > memory => Some((122, "rss-limit-exceeded")),
                Err(_) => Some((125, "sandbox-unavailable")),
                _ => None,
            };
            if let Some((code, reason)) = exceeded {
                terminate(0);
                unsafe {
                    libc::waitpid(pid, std::ptr::null_mut(), 0);
                }
                eprintln!("sandbox launcher: {reason}");
                std::process::exit(code);
            }
            std::thread::sleep(Duration::from_millis(50).saturating_sub(started.elapsed()));
        }
    }
}

#[cfg(unix)]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let run = || -> Result<(), String> {
        match args.first().map(String::as_str) {
            #[cfg(target_os = "macos")]
            Some("--watch-tree") => return watchdog::run(&args),
            Some("--tasks" | "--tasks-required") => return task_cap(&args),
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
