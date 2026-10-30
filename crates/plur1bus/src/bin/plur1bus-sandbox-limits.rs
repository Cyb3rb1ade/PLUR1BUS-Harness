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
    // Fixed numeric observations only: never collect process names, commands, paths or environment.
    const TRACE_LIMIT: usize = 128;
    #[derive(Clone, Copy, Default)]
    enum Operation {
        #[default]
        Sample,
        BsdInfo,
        Alive,
        GroupSize,
        GroupList,
        GroupMember,
        ChildSize,
        ChildList,
        ChildMember,
        TaskInfo,
        Membership,
    }
    impl Operation {
        fn label(self) -> &'static str {
            match self {
                Self::Sample => "sample",
                Self::BsdInfo => "bsd-info",
                Self::Alive => "alive",
                Self::GroupSize => "group-size",
                Self::GroupList => "group-list",
                Self::GroupMember => "group-member",
                Self::ChildSize => "child-size",
                Self::ChildList => "child-list",
                Self::ChildMember => "child-member",
                Self::TaskInfo => "task-info",
                Self::Membership => "membership",
            }
        }
    }
    #[derive(Clone, Copy)]
    enum Cause {
        Deadline,
        IdentityUnavailable,
        ListSafetyCap,
        ListUnavailable,
        DescendantSafetyCap,
        TaskInfoUnavailable,
        AttachLimit,
    }
    impl Cause {
        fn label(self) -> &'static str {
            match self {
                Self::Deadline => "sample-deadline",
                Self::IdentityUnavailable => "identity-unavailable",
                Self::ListSafetyCap => "list-safety-cap",
                Self::ListUnavailable => "list-unavailable",
                Self::DescendantSafetyCap => "descendant-safety-cap",
                Self::TaskInfoUnavailable => "task-info-unavailable",
                Self::AttachLimit => "attach-limit",
            }
        }
    }
    #[derive(Clone, Copy, Default)]
    struct Observation {
        operation: Operation,
        pid: libc::pid_t,
        returned: i32,
        expected: i32,
        errno: i32,
        probe_returned: i32,
        probe_errno: i32,
        ppid: u32,
        pgid: u32,
        status: u32,
        start_seconds: u64,
        start_micros: u64,
        rss_bytes: u64,
    }
    #[derive(Clone, Copy)]
    struct Record {
        observation: Observation,
        sample: u64,
        attach: bool,
        elapsed_micros: u64,
        count: usize,
        rss_bytes: u64,
    }
    impl Record {
        fn json(self, cause: &str) -> String {
            let o = self.observation;
            // `cause` and operation are exclusively static enum labels, all other fields are numbers.
            format!(
                concat!(
                    "{{\"version\":1,\"cause\":\"{}\",\"operation\":\"{}\",\"phase\":\"{}\",",
                    "\"sample\":{},\"elapsedMicros\":{},\"pid\":{},\"returned\":{},\"expected\":{},\"errno\":{},",
                    "\"probeReturned\":{},\"probeErrno\":{},\"ppid\":{},\"pgid\":{},\"status\":{},",
                    "\"startSeconds\":{},\"startMicros\":{},\"processRssBytes\":{},\"count\":{},\"rssBytes\":{}}}"
                ),
                cause,
                o.operation.label(),
                if self.attach { "attach" } else { "runtime" },
                self.sample,
                self.elapsed_micros,
                o.pid,
                o.returned,
                o.expected,
                o.errno,
                o.probe_returned,
                o.probe_errno,
                o.ppid,
                o.pgid,
                o.status,
                o.start_seconds,
                o.start_micros,
                o.rss_bytes,
                self.count,
                self.rss_bytes
            )
        }
    }
    struct SampleError {
        cause: Cause,
        record: Record,
    }
    struct Diagnostics {
        started: Instant,
        sample: u64,
        attach: bool,
        last: Observation,
        count: usize,
        rss: u64,
        trace: bool,
        records: Vec<Record>,
        written: usize,
    }
    impl Diagnostics {
        fn new(trace: bool) -> Self {
            Self {
                started: Instant::now(),
                sample: 0,
                attach: true,
                last: Observation::default(),
                count: 0,
                rss: 0,
                trace,
                records: Vec::with_capacity(if trace { TRACE_LIMIT } else { 0 }),
                written: 0,
            }
        }
        fn begin(&mut self, started: Instant) {
            self.started = started;
            self.sample = self.sample.saturating_add(1);
            self.attach = self.sample == 1;
            self.count = 0;
            self.rss = 0;
            self.observe(Observation::default());
        }
        fn record(&self) -> Record {
            Record {
                observation: self.last,
                sample: self.sample,
                attach: self.attach,
                elapsed_micros: self.started.elapsed().as_micros().min(u64::MAX as u128) as u64,
                count: self.count,
                rss_bytes: self.rss,
            }
        }
        fn observe(&mut self, observation: Observation) {
            self.last = observation;
            if !self.trace {
                return;
            }
            let record = self.record();
            if self.records.len() < TRACE_LIMIT {
                self.records.push(record);
            } else {
                self.records[self.written % TRACE_LIMIT] = record;
            }
            self.written = self.written.saturating_add(1);
        }
        fn error(&self, cause: Cause) -> SampleError {
            SampleError {
                cause,
                record: self.record(),
            }
        }
        // No diagnostic I/O inside a timed sample. The target group has already been stopped here.
        fn emit(&self, failure: Option<&SampleError>, report_fd: bool) {
            if let Some(failure) = failure {
                let json = failure.record.json(failure.cause.label());
                eprintln!("sandbox watchdog detail: {json}");
                if report_fd {
                    use std::io::Write;
                    use std::os::fd::FromRawFd;
                    // Only --watch-tree-report owns fd 3; the forked target closes it before exec.
                    let mut file = unsafe { std::fs::File::from_raw_fd(3) };
                    let _ = writeln!(file, "{json}");
                }
            }
            if self.trace {
                eprintln!(
                    "sandbox watchdog trace: retained={} dropped={}",
                    self.records.len(),
                    self.written.saturating_sub(TRACE_LIMIT)
                );
                let start = if self.written > TRACE_LIMIT {
                    self.written % TRACE_LIMIT
                } else {
                    0
                };
                for i in 0..self.records.len() {
                    eprintln!(
                        "sandbox watchdog observation: {}",
                        self.records[(start + i) % self.records.len()].json("observation")
                    );
                }
            }
        }
    }

    fn check_time(deadline: Instant, diagnostics: &Diagnostics) -> Result<(), SampleError> {
        if Instant::now() >= deadline {
            Err(diagnostics.error(Cause::Deadline))
        } else {
            Ok(())
        }
    }
    fn bsd_info(
        pid: libc::pid_t,
        diagnostics: &mut Diagnostics,
    ) -> Result<Option<libc::proc_bsdinfo>, SampleError> {
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
        let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        let observation = Observation {
            operation: Operation::BsdInfo,
            pid,
            returned: got,
            expected: size,
            errno,
            ppid: info.pbi_ppid,
            pgid: info.pbi_pgid,
            status: info.pbi_status,
            start_seconds: info.pbi_start_tvsec,
            start_micros: info.pbi_start_tvusec,
            ..Observation::default()
        };
        diagnostics.observe(observation);
        if got == size {
            return Ok(Some(info));
        }
        let alive = unsafe { libc::kill(pid, 0) };
        let probe_errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        diagnostics.observe(Observation {
            operation: Operation::Alive,
            probe_returned: alive,
            probe_errno,
            ..observation
        });
        if alive != 0 && probe_errno == libc::ESRCH {
            return Ok(None);
        }
        Err(diagnostics.error(Cause::IdentityUnavailable))
    }
    fn identity(info: &libc::proc_bsdinfo) -> Identity {
        (info.pbi_start_tvsec, info.pbi_start_tvusec)
    }
    fn list_pids(
        pid: libc::pid_t,
        group: bool,
        deadline: Instant,
        diagnostics: &mut Diagnostics,
    ) -> Result<Vec<libc::pid_t>, SampleError> {
        type List =
            unsafe extern "C" fn(libc::pid_t, *mut libc::c_void, libc::c_int) -> libc::c_int;
        let list: List = if group {
            libc::proc_listpgrppids
        } else {
            libc::proc_listchildpids
        };
        check_time(deadline, diagnostics)?;
        let count = unsafe { list(pid, std::ptr::null_mut(), 0) };
        let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        diagnostics.observe(Observation {
            operation: if group {
                Operation::GroupSize
            } else {
                Operation::ChildSize
            },
            pid,
            returned: count,
            errno,
            ..Observation::default()
        });
        check_time(deadline, diagnostics)?;
        if !(0..65536).contains(&count) {
            return Err(diagnostics.error(Cause::ListSafetyCap));
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
        let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        diagnostics.observe(Observation {
            operation: if group {
                Operation::GroupList
            } else {
                Operation::ChildList
            },
            pid,
            returned: count,
            expected: pids.len() as i32,
            errno,
            ..Observation::default()
        });
        check_time(deadline, diagnostics)?;
        if count < 0 || count as usize >= pids.len() {
            return Err(diagnostics.error(Cause::ListUnavailable));
        }
        pids.truncate(count as usize);
        if diagnostics.trace {
            for &member in pids.iter().take(TRACE_LIMIT) {
                diagnostics.observe(Observation {
                    operation: if group {
                        Operation::GroupMember
                    } else {
                        Operation::ChildMember
                    },
                    pid: member,
                    ppid: if group { 0 } else { pid as u32 },
                    pgid: if group { pid as u32 } else { 0 },
                    ..Observation::default()
                });
            }
        }
        Ok(pids)
    }
    fn sample(
        root: libc::pid_t,
        tasks: usize,
        memory: u64,
        known: &mut HashMap<libc::pid_t, Identity>,
        diagnostics: &mut Diagnostics,
    ) -> Result<(usize, u64), SampleError> {
        let started = Instant::now();
        let deadline = started + Duration::from_millis(40);
        diagnostics.begin(started);
        let mut queue: Vec<_> = known
            .iter()
            .map(|(&pid, &id)| (pid, Source::Known(id)))
            .collect();
        queue.extend(
            list_pids(root, true, deadline, diagnostics)?
                .into_iter()
                .map(|pid| (pid, Source::Group)),
        );
        queue.push((root, Source::Group));
        let mut seen = HashSet::new();
        let mut next = HashMap::new();
        let mut rss = 0u64;
        while let Some((pid, source)) = queue.pop() {
            check_time(deadline, diagnostics)?;
            if pid <= 0 {
                continue;
            }
            let Some(info) = bsd_info(pid, diagnostics)? else {
                continue;
            };
            check_time(deadline, diagnostics)?;
            let id = identity(&info);
            // Enumeration races must never turn a reused PID into an unrelated retained descendant.
            let belongs = match source {
                Source::Group => info.pbi_pgid == root as u32,
                Source::Child(parent) => info.pbi_ppid == parent as u32,
                Source::Known(expected) => id == expected,
            };
            diagnostics.observe(Observation {
                operation: Operation::Membership,
                returned: i32::from(belongs),
                ..diagnostics.last
            });
            if !belongs || !seen.insert((pid, id)) {
                continue;
            }
            diagnostics.count = seen.len();
            if seen.len() > 65536 {
                return Err(diagnostics.error(Cause::DescendantSafetyCap));
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
            let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
            let task_observation = Observation {
                operation: Operation::TaskInfo,
                returned: got,
                expected: size,
                errno,
                rss_bytes: task.pti_resident_size,
                ..diagnostics.last
            };
            diagnostics.observe(task_observation);
            check_time(deadline, diagnostics)?;
            let Some(after) = bsd_info(pid, diagnostics)? else {
                continue;
            };
            check_time(deadline, diagnostics)?;
            if identity(&after) != id {
                continue;
            }
            if got != size {
                // Keep the original task-query return/errno even after the identity recheck.
                diagnostics.observe(task_observation);
                return Err(diagnostics.error(Cause::TaskInfoUnavailable));
            }
            next.insert(pid, id);
            rss = rss.saturating_add(task.pti_resident_size);
            diagnostics.rss = rss;
            if rss > memory {
                return Ok((seen.len(), rss));
            }
            queue.extend(
                list_pids(pid, false, deadline, diagnostics)?
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
        let trace = std::env::var("PLUR1BUS_TEST_WATCHDOG_TRACE").as_deref() == Ok("1");
        if trace && std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() != Ok("1") {
            return Err("watchdog trace requires PLUR1BUS_ALLOW_TEST_INTERNALS=1".into());
        }
        let report_fd = args[0] == "--watch-tree-report";
        let mut diagnostics = Diagnostics::new(trace);
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
                if report_fd {
                    libc::close(3);
                }
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
            libc::signal(libc::SIGTERM, terminate as *const () as libc::sighandler_t);
            libc::signal(libc::SIGINT, terminate as *const () as libc::sighandler_t);
        }
        // Attach and validate observation BEFORE releasing the target's exec gate.
        let mut known = HashMap::new();
        let attached = sample(pid, tasks, memory, &mut known, &mut diagnostics);
        if !matches!(attached, Ok((count, rss)) if count <= tasks && rss <= memory) {
            terminate(0);
            unsafe {
                libc::close(gate[1]);
                libc::waitpid(pid, std::ptr::null_mut(), 0);
            }
            let failure = attached
                .err()
                .unwrap_or_else(|| diagnostics.error(Cause::AttachLimit));
            diagnostics.emit(Some(&failure), report_fd);
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
                diagnostics.emit(None, report_fd);
                std::process::exit(if libc::WIFEXITED(status) {
                    libc::WEXITSTATUS(status)
                } else {
                    128 + libc::WTERMSIG(status)
                });
            }
            let mut failure = None;
            let exceeded = match sample(pid, tasks, memory, &mut known, &mut diagnostics) {
                Ok((count, _)) if count > tasks => Some((121, "task-limit-exceeded")),
                Ok((_, rss)) if rss > memory => Some((122, "rss-limit-exceeded")),
                Err(error) => {
                    failure = Some(error);
                    Some((125, "sandbox-unavailable"))
                }
                _ => None,
            };
            if let Some((code, reason)) = exceeded {
                terminate(0);
                unsafe {
                    libc::waitpid(pid, std::ptr::null_mut(), 0);
                }
                diagnostics.emit(failure.as_ref(), report_fd);
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
            Some("--watch-tree" | "--watch-tree-report") => return watchdog::run(&args),
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
