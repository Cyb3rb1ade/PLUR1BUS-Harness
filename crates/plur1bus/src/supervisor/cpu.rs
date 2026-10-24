//! `supervisor.maxCores`: the CPU cores every PLUR1BUS process may run on
//! (`docs/superpowers/specs/2026-10-24-cpu-core-limit-design.md`).
//!
//! At start the supervisor records the CPUs the system lets it run on ([`Host`]): every CPU it may use (a container,
//! a cgroup or a Windows job still limits them), not the affinity it inherited, because a supervisor started by a
//! process an earlier supervisor had bound (`plur1bus daemon restart` from a tool) would otherwise take the old limit
//! for the whole host. [`std::thread::available_parallelism`] caps the count by a cgroup CPU quota. A limit below that
//! count binds the supervisor and every process it runs to the first `maxCores` of those CPUs; 0, or a limit at or
//! above the count, uses every one of them, so an inherited narrowing (also one from `taskset` or a unit's
//! `CPUAffinity=`) is undone at start. The binding is CPU affinity, which every new thread and child process inherits,
//! so what starts later keeps it, and [`apply`] binds what already runs, at start and for every new running
//! configuration. Linux binds every thread of the supervisor's process tree and of each child's process group, which
//! also covers an adopted child that is no descendant. Windows binds the supervisor and each running child; what those
//! started before a change keeps its binding until it restarts. macOS has no interface to bind a process to cores, so
//! a limit there is reported as unsupported. Thread and process counts are never limited.
use super::state::Health;
use super::{Shared, SupervisorState};
use serde_json::{json, Value};

/// The CPUs this host offers the supervisor, as it saw them at start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Host {
    /// CPU ids the supervisor may run on, ascending; empty where the OS names none (macOS).
    pub cpus: Vec<usize>,
    /// How many cores that is in practice, at least 1: fewer than `cpus` when a cgroup CPU quota caps them.
    pub count: usize,
}

impl Host {
    /// Every CPU the system lets this process run on, whatever affinity the calling thread inherited, and how many
    /// cores that is in practice. Called once at supervisor start.
    pub fn detect() -> Host {
        let (cpus, parallel) = os::allowed();
        let count = match cpus.len() {
            0 => parallel,
            n => parallel.min(n),
        };
        Host {
            cpus,
            count: count.max(1),
        }
    }
}

/// The CPUs a limit of `max` binds every process to on `host`, or `None` while every core stays in use (0, or a limit
/// at or above the host's count). Empty when the OS names no CPU ids.
pub fn plan(host: &Host, max: u64) -> Option<Vec<usize>> {
    let max = usize::try_from(max).unwrap_or(usize::MAX);
    (max != 0 && max < host.count).then(|| host.cpus.iter().copied().take(max).collect())
}

/// `supervisor.maxCores` of a running configuration; 0 (no limit) when absent.
pub fn configured(config: &Value) -> u64 {
    config["supervisor"]["maxCores"].as_u64().unwrap_or(0)
}

/// Whether the limit holds: `daemon.status.cpu.state` and its `reason`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    /// Every core the host offers.
    Unlimited,
    /// Every process is bound to [`Cores::bound`].
    Limited,
    /// The OS cannot bind processes to cores.
    Unsupported(String),
    /// The binding could not be applied; processes keep the binding they had.
    Failed(String),
}

/// The supervisor's CPU binding ([`SupervisorState::cpu`]), as `daemon.status` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cores {
    pub host: Host,
    /// `supervisor.maxCores` of the running configuration (0: no limit).
    pub max: u64,
    /// The CPUs every process is bound to; `None` while every process may use all of `host.cpus`.
    pub bound: Option<Vec<usize>>,
    pub state: State,
}

impl Cores {
    /// `host`, with the supervisor running on `inherited`: a narrower set than `host.cpus` counts as a binding, which
    /// [`apply`] then replaces (by the limit, or by every CPU).
    pub fn new(host: Host, inherited: Vec<usize>) -> Cores {
        let narrowed = !host.cpus.is_empty() && !inherited.is_empty() && inherited != host.cpus;
        Cores {
            host,
            max: 0,
            bound: narrowed.then_some(inherited),
            state: State::Unlimited,
        }
    }

    /// The host and the affinity the calling thread runs on. Called once at supervisor start, before anything is bound.
    pub fn detect() -> Cores {
        Cores::new(Host::detect(), os::own_cpus().unwrap_or_default())
    }

    /// `daemon.status.cpu`.
    pub fn status_json(&self) -> Value {
        let (state, reason) = match &self.state {
            State::Unlimited => ("unlimited", None),
            State::Limited => ("limited", None),
            State::Unsupported(r) => ("unsupported", Some(r)),
            State::Failed(r) => ("failed", Some(r)),
        };
        let effective = self.bound.as_ref().map_or(self.host.count, Vec::len);
        let mut v = json!({
            "detected": self.host.count, "maxCores": self.max, "effective": effective, "state": state,
        });
        if let Some(r) = reason {
            v["reason"] = json!(r);
        }
        v
    }
}

/// What a binding reached besides the root that had to take it: threads (Linux) or processes (Windows) bound, and how
/// many refused it, with the first refusal.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Bound {
    pub bound: usize,
    pub refused: usize,
    pub first_refusal: Option<String>,
}

/// Where a binding starts: the supervisor first (its own threads must take it), then every child whose process runs.
fn roots(st: &SupervisorState) -> Vec<u32> {
    let mut roots = vec![std::process::id()];
    roots.extend(
        st.slots
            .iter()
            .filter_map(|s| s.child.as_ref())
            .filter(|c| {
                matches!(
                    c.health,
                    Health::Starting
                        | Health::Ready
                        | Health::Degraded(_)
                        | Health::Orphaned { .. }
                        | Health::Stopping
                )
            })
            .filter_map(|c| c.pid),
    );
    roots
}

/// The state after limit `max` with plan `target`, binding through `bind` where processes must change. A plan of no
/// CPUs (the OS names none) is unsupported; no limit while anything is narrowed (a removed limit, an inherited
/// narrowing) binds to every CPU of the host; a refused binding keeps the binding the processes had.
fn settle(
    current: &Cores,
    max: u64,
    target: Option<Vec<usize>>,
    roots: &[u32],
    bind: impl Fn(&[u32], &[usize]) -> Result<Bound, String>,
) -> (Cores, Option<Bound>) {
    let mut next = Cores {
        max,
        ..current.clone()
    };
    let reached = match target {
        // Nothing narrowed: every process already runs on all of `host.cpus`.
        None if current.bound.is_none() => {
            next.state = State::Unlimited;
            None
        }
        None => match bind(roots, &current.host.cpus) {
            Ok(b) => {
                next.bound = None;
                next.state = State::Unlimited;
                Some(b)
            }
            Err(e) => {
                next.state = State::Failed(e);
                None
            }
        },
        Some(ids) if ids.is_empty() => {
            next.state = State::Unsupported(os::UNSUPPORTED.into());
            None
        }
        Some(ids) => match bind(roots, &ids) {
            Ok(b) => {
                next.bound = Some(ids);
                next.state = State::Limited;
                Some(b)
            }
            Err(e) => {
                next.state = State::Failed(e);
                None
            }
        },
    };
    (next, reached)
}

/// Applies `config`'s `supervisor.maxCores` (the running configuration) to the supervisor and every process it runs,
/// and records the outcome. Nothing happens while neither the limit nor its plan changed, unless the last binding
/// failed, which is tried again.
pub fn apply(shared: &Shared, config: &Value) {
    let max = configured(config);
    let (current, roots) = {
        let st = shared.lock();
        (st.cpu.clone(), roots(&st))
    };
    let target = plan(&current.host, max);
    if current.max == max && current.bound == target && !matches!(current.state, State::Failed(_)) {
        return;
    }
    let (next, reached) = settle(&current, max, target, &roots, os::bind);
    log(shared, &current, &next, reached.as_ref());
    shared.lock().cpu = next;
}

/// The CPUs an adopted child gets: the limit's while one holds, else every CPU of the host (an earlier supervisor may
/// have bound it); `None` when the OS names no CPU ids.
fn adopted_cpus(c: &Cores) -> Option<Vec<usize>> {
    c.bound
        .clone()
        .or_else(|| (!c.host.cpus.is_empty()).then(|| c.host.cpus.clone()))
}

/// Binds a child the supervisor adopted (started by an earlier supervisor, so no descendant of this one) like the rest.
/// An `apply` running at the same moment may store its outcome a little later; the next change corrects that.
pub fn bind_adopted(shared: &Shared, pid: u32) {
    let Some(cpus) = adopted_cpus(&shared.lock().cpu) else {
        return;
    };
    match os::bind(&[pid], &cpus) {
        Ok(b) => log_refusals(shared, &b),
        Err(e) => shared.log.warn(
            "cannot bind an adopted process to its cpu cores",
            json!({ "pid": pid, "err": e }),
        ),
    }
}

fn log(shared: &Shared, before: &Cores, after: &Cores, reached: Option<&Bound>) {
    let fields =
        json!({ "maxCores": after.max, "detected": after.host.count, "cpus": after.bound });
    match &after.state {
        State::Limited => shared.log.info("cpu cores limited", fields),
        State::Unlimited if before.bound.is_some() => {
            shared.log.info("cpu cores: every core in use", fields)
        }
        State::Unlimited => {}
        State::Unsupported(reason) if before.state != after.state => shared.log.warn(
            "cpu core limit not enforced",
            json!({ "maxCores": after.max, "reason": reason }),
        ),
        State::Unsupported(_) => {}
        State::Failed(err) => shared.log.warn(
            "cpu core limit could not be applied",
            json!({ "maxCores": after.max, "err": err }),
        ),
    }
    if let Some(b) = reached {
        log_refusals(shared, b);
    }
}

fn log_refusals(shared: &Shared, b: &Bound) {
    if b.refused > 0 {
        shared.log.warn(
            "some processes refused the cpu core binding",
            json!({ "refused": b.refused, "first": b.first_refusal }),
        );
    }
}

/// How many cores the calling thread may use in practice: its CPUs, on Linux also capped by a cgroup CPU quota.
fn parallelism() -> usize {
    std::thread::available_parallelism().map_or(1, |n| n.get())
}

#[cfg(target_os = "linux")]
mod os {
    use super::Bound;
    use std::collections::{BTreeSet, HashMap};
    use std::io;

    /// Reported when the CPUs this process may run on could not be read.
    pub const UNSUPPORTED: &str = "the supervisor could not read the CPUs it may run on";
    const SETSIZE: usize = libc::CPU_SETSIZE as usize;

    fn empty_set() -> libc::cpu_set_t {
        // SAFETY: cpu_set_t is a plain bit array; all zeros is the empty set.
        unsafe { std::mem::zeroed() }
    }

    /// The CPUs the calling thread may run on.
    pub fn own_cpus() -> io::Result<Vec<usize>> {
        let mut set = empty_set();
        // SAFETY: the size passed is the size of `set`.
        if unsafe { libc::sched_getaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &mut set) }
            != 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: CPU_ISSET only reads `set`, at ids below CPU_SETSIZE.
        Ok((0..SETSIZE)
            .filter(|&c| unsafe { libc::CPU_ISSET(c, &set) })
            .collect())
    }

    /// Every CPU this process may run on, and how many cores that is in practice. A scratch thread widens its own
    /// affinity to every CPU id, which the kernel narrows to what the cpuset allows, and reads both back, so the
    /// calling thread keeps the affinity it inherited. Without that thread, the calling thread's own CPUs.
    pub fn allowed() -> (Vec<usize>, usize) {
        let read = || (own_cpus().unwrap_or_default(), super::parallelism());
        std::thread::Builder::new()
            .name("cpu-detect".into())
            .spawn(move || {
                let mut set = empty_set();
                for c in 0..SETSIZE {
                    // SAFETY: c is below CPU_SETSIZE, the size of `set`.
                    unsafe { libc::CPU_SET(c, &mut set) };
                }
                // SAFETY: the size passed is the size of `set`. A refusal keeps the inherited CPUs, which `read`
                // then reports.
                unsafe { libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &set) };
                read()
            })
            .ok()
            .and_then(|t| t.join().ok())
            .unwrap_or_else(read)
    }

    /// (ppid, process group) from a `/proc/<pid>/stat` line. The command name before them is in parentheses and may
    /// hold spaces and parentheses itself, so the fields start after the last `)`.
    pub fn stat_fields(stat: &str) -> Option<(u32, u32)> {
        let mut f = stat.get(stat.rfind(')')? + 1..)?.split_whitespace();
        let _state = f.next()?;
        Some((f.next()?.parse().ok()?, f.next()?.parse().ok()?))
    }

    /// pid → (ppid, process group) of every process `/proc` lists.
    fn processes() -> HashMap<u32, (u32, u32)> {
        let mut out = HashMap::new();
        let Ok(dir) = std::fs::read_dir("/proc") else {
            return out;
        };
        for e in dir.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
                continue;
            };
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
            if let Some(f) = stat_fields(&stat) {
                out.insert(pid, f);
            }
        }
        out
    }

    /// `roots`, their descendants, and the members of every process group a root other than the supervisor leads: a
    /// process whose parent exited keeps the group of the child that started it. The supervisor's own group may be a
    /// terminal's, so it never counts.
    fn tree(roots: &[u32]) -> BTreeSet<u32> {
        let procs = processes();
        let own = std::process::id();
        let leaders: BTreeSet<u32> = roots.iter().copied().filter(|&p| p != own).collect();
        let mut out: BTreeSet<u32> = roots
            .iter()
            .copied()
            .filter(|p| procs.contains_key(p))
            .collect();
        out.extend(
            procs
                .iter()
                .filter(|(_, (_, g))| leaders.contains(g))
                .map(|(p, _)| *p),
        );
        loop {
            let more: Vec<u32> = procs
                .iter()
                .filter(|(p, (parent, _))| !out.contains(p) && out.contains(parent))
                .map(|(p, _)| *p)
                .collect();
            if more.is_empty() {
                return out;
            }
            out.extend(more);
        }
    }

    /// Binds every thread of `roots` and of their [`tree`] to `cpus`, twice: a thread or process that one not yet bound
    /// created during the first pass is caught by the second. A thread of `roots[0]` that refuses fails the call.
    pub fn bind(roots: &[u32], cpus: &[usize]) -> Result<Bound, String> {
        let mut set = empty_set();
        for &c in cpus.iter().filter(|&&c| c < SETSIZE) {
            // SAFETY: c is below CPU_SETSIZE, the size of `set`.
            unsafe { libc::CPU_SET(c, &mut set) };
        }
        let mut last = Bound::default();
        for _ in 0..2 {
            let mut pass = Bound::default();
            for pid in tree(roots) {
                let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) else {
                    continue;
                };
                for t in tasks.flatten() {
                    let Some(tid) = t
                        .file_name()
                        .to_str()
                        .and_then(|s| s.parse::<libc::pid_t>().ok())
                    else {
                        continue;
                    };
                    // SAFETY: the size passed is the size of `set`.
                    if unsafe {
                        libc::sched_setaffinity(tid, std::mem::size_of::<libc::cpu_set_t>(), &set)
                    } == 0
                    {
                        pass.bound += 1;
                        continue;
                    }
                    let e = io::Error::last_os_error();
                    if e.raw_os_error() == Some(libc::ESRCH) {
                        continue; // exited meanwhile
                    }
                    if roots.first() == Some(&pid) {
                        return Err(format!("cannot bind process {pid}: {e}"));
                    }
                    pass.refused += 1;
                    pass.first_refusal
                        .get_or_insert_with(|| format!("process {pid}: {e}"));
                }
            }
            last = pass;
        }
        Ok(last)
    }
}

#[cfg(windows)]
mod os {
    use super::Bound;
    use std::io;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicLimitInformation, QueryInformationJobObject,
        JOBOBJECT_BASIC_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_AFFINITY,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessAffinityMask, OpenProcess, SetProcessAffinityMask,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION,
    };

    /// Reported when the CPUs this process may run on could not be read.
    pub const UNSUPPORTED: &str = "the supervisor could not read the CPUs it may run on";

    fn bits(mask: usize) -> Vec<usize> {
        (0..usize::BITS as usize)
            .filter(|b| mask & (1usize << b) != 0)
            .collect()
    }

    /// (this process's affinity mask, the system's), both for its processor group.
    fn masks() -> io::Result<(usize, usize)> {
        let (mut process, mut system) = (0usize, 0usize);
        // SAFETY: the pseudo handle needs no closing; both out pointers are valid.
        if unsafe { GetProcessAffinityMask(GetCurrentProcess(), &mut process, &mut system) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok((process, system))
    }

    /// The CPUs of this process's affinity mask (its processor group).
    pub fn own_cpus() -> io::Result<Vec<usize>> {
        masks().map(|(process, _)| bits(process))
    }

    /// Every CPU of this process's processor group the system lets it run on: the system mask, narrowed by the
    /// affinity limit of the job the process belongs to, if any. The mask it inherited does not count.
    pub fn allowed() -> (Vec<usize>, usize) {
        let Ok((_, system)) = masks() else {
            return (Vec::new(), super::parallelism());
        };
        // SAFETY: the struct is plain data, for which all zeros is a valid value.
        let mut job: JOBOBJECT_BASIC_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: a null handle names the job of this process (outside a job the call fails); the buffer is `job`, of
        // the size passed, and no returned length is asked for.
        let in_job = unsafe {
            QueryInformationJobObject(
                std::ptr::null_mut(),
                JobObjectBasicLimitInformation,
                (&mut job as *mut JOBOBJECT_BASIC_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_LIMIT_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        } != 0;
        let mask = if in_job && job.LimitFlags & JOB_OBJECT_LIMIT_AFFINITY != 0 {
            system & job.Affinity
        } else {
            system
        };
        (bits(mask), super::parallelism())
    }

    /// Binds the supervisor (when `roots` holds its pid) and every other root process to `cpus`: their threads at once,
    /// and the processes they start from now on. A process they started earlier keeps its binding. `roots[0]` must
    /// take it.
    pub fn bind(roots: &[u32], cpus: &[usize]) -> Result<Bound, String> {
        let mask = cpus
            .iter()
            .filter(|&&c| c < usize::BITS as usize)
            .fold(0usize, |m, &c| m | (1usize << c));
        if mask == 0 {
            return Err("no CPU to bind to".into());
        }
        let own = std::process::id();
        let mut out = Bound::default();
        for (i, &pid) in roots.iter().enumerate() {
            let result = if pid == own {
                // SAFETY: the pseudo handle needs no closing.
                if unsafe { SetProcessAffinityMask(GetCurrentProcess(), mask) } != 0 {
                    Ok(())
                } else {
                    Err(io::Error::last_os_error())
                }
            } else {
                // SAFETY: a handle OpenProcess returns is closed below; a null one is an error.
                let h = unsafe {
                    OpenProcess(
                        PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION,
                        0,
                        pid,
                    )
                };
                if h.is_null() {
                    Err(io::Error::last_os_error())
                } else {
                    // SAFETY: `h` is a valid process handle with PROCESS_SET_INFORMATION.
                    let ok = unsafe { SetProcessAffinityMask(h, mask) } != 0;
                    let err = io::Error::last_os_error();
                    // SAFETY: `h` was opened above and is closed once.
                    unsafe { CloseHandle(h) };
                    if ok {
                        Ok(())
                    } else {
                        Err(err)
                    }
                }
            };
            match result {
                Ok(()) => out.bound += 1,
                Err(e) if i == 0 => return Err(format!("cannot bind process {pid}: {e}")),
                Err(e) => {
                    out.refused += 1;
                    out.first_refusal
                        .get_or_insert_with(|| format!("process {pid}: {e}"));
                }
            }
        }
        Ok(out)
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
mod os {
    use super::Bound;
    use std::io;

    /// macOS has no interface that binds a process to cores; thread affinity there is only a hint.
    pub const UNSUPPORTED: &str = "this operating system cannot bind processes to CPU cores";

    /// No CPU ids: a limit is then reported as unsupported.
    pub fn own_cpus() -> io::Result<Vec<usize>> {
        Ok(Vec::new())
    }

    /// No CPU ids either; only the count.
    pub fn allowed() -> (Vec<usize>, usize) {
        (Vec::new(), super::parallelism())
    }

    pub fn bind(_roots: &[u32], _cpus: &[usize]) -> Result<Bound, String> {
        Err(UNSUPPORTED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn host(cpus: &[usize], count: usize) -> Host {
        Host {
            cpus: cpus.to_vec(),
            count,
        }
    }

    #[test]
    fn plan_keeps_every_core_for_zero_for_a_limit_at_or_above_the_count_and_on_a_one_core_host() {
        let h = host(&[0, 2, 4, 6], 4);
        assert_eq!(plan(&h, 0), None);
        assert_eq!(plan(&h, 4), None);
        assert_eq!(plan(&h, 12), None, "a configuration from a bigger host");
        assert_eq!(plan(&host(&[3], 1), 1), None);
        assert_eq!(plan(&host(&[3], 1), 7), None);
    }

    #[test]
    fn plan_binds_to_the_first_cpus_of_the_host() {
        let h = host(&[0, 2, 4, 6], 4);
        assert_eq!(plan(&h, 2), Some(vec![0, 2]));
        assert_eq!(plan(&h, 1), Some(vec![0]));
    }

    #[test]
    fn a_cgroup_quota_below_the_affinity_caps_the_count() {
        let h = host(&(0..16).collect::<Vec<_>>(), 2);
        assert_eq!(plan(&h, 2), None);
        assert_eq!(plan(&h, 1), Some(vec![0]));
    }

    #[test]
    fn configured_reads_the_running_value_and_defaults_to_no_limit() {
        assert_eq!(configured(&json!({ "supervisor": { "maxCores": 3 } })), 3);
        assert_eq!(configured(&json!({ "supervisor": {} })), 0);
        assert_eq!(configured(&json!({})), 0);
    }

    #[test]
    fn status_reports_detected_configured_effective_and_state() {
        let mut c = Cores::new(host(&[0, 1, 2, 3], 4), vec![]);
        assert_eq!(
            c.status_json(),
            json!({ "detected": 4, "maxCores": 0, "effective": 4, "state": "unlimited" })
        );
        c.max = 2;
        c.bound = Some(vec![0, 1]);
        c.state = State::Limited;
        assert_eq!(
            c.status_json(),
            json!({ "detected": 4, "maxCores": 2, "effective": 2, "state": "limited" })
        );
        c.bound = None;
        c.state = State::Unsupported("no binding here".into());
        assert_eq!(
            c.status_json(),
            json!({ "detected": 4, "maxCores": 2, "effective": 4, "state": "unsupported", "reason": "no binding here" })
        );
    }

    type Calls = std::cell::RefCell<Vec<Vec<usize>>>;

    /// A binder that records the CPUs it was asked for, and refuses when `fail`.
    fn binder(
        calls: &Calls,
        fail: bool,
    ) -> impl Fn(&[u32], &[usize]) -> Result<Bound, String> + '_ {
        move |_, cpus| {
            calls.borrow_mut().push(cpus.to_vec());
            if fail {
                Err("refused".into())
            } else {
                Ok(Bound::default())
            }
        }
    }

    #[test]
    fn a_limit_binds_and_removing_it_restores_every_cpu() {
        let calls = Calls::default();
        let start = Cores::new(host(&[0, 1, 2, 3], 4), vec![]);
        let (limited, _) = settle(&start, 2, plan(&start.host, 2), &[1], binder(&calls, false));
        assert_eq!(limited.state, State::Limited);
        assert_eq!(limited.bound, Some(vec![0, 1]));
        let (free, _) = settle(
            &limited,
            0,
            plan(&limited.host, 0),
            &[1],
            binder(&calls, false),
        );
        assert_eq!(free.state, State::Unlimited);
        assert_eq!(free.bound, None);
        assert_eq!(*calls.borrow(), vec![vec![0, 1], vec![0, 1, 2, 3]]);
    }

    #[test]
    fn no_limit_on_processes_never_narrowed_binds_nothing() {
        let calls = Calls::default();
        let start = Cores::new(host(&[0, 1, 2, 3], 4), vec![]);
        let (next, _) = settle(&start, 8, plan(&start.host, 8), &[1], binder(&calls, false));
        assert_eq!(
            (next.state.clone(), next.max, next.bound.clone()),
            (State::Unlimited, 8, None)
        );
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn a_refused_binding_fails_and_keeps_the_binding_it_had() {
        let calls = Calls::default();
        let mut limited = Cores::new(host(&[0, 1, 2, 3], 4), vec![]);
        limited.max = 2;
        limited.bound = Some(vec![0, 1]);
        limited.state = State::Limited;
        let (next, _) = settle(
            &limited,
            1,
            plan(&limited.host, 1),
            &[1],
            binder(&calls, true),
        );
        assert_eq!(next.state, State::Failed("refused".into()));
        assert_eq!(next.bound, Some(vec![0, 1]));
        assert_eq!(next.status_json()["effective"], 2);
    }

    #[test]
    fn a_narrowed_start_counts_as_a_binding_and_is_widened_without_a_limit() {
        let calls = Calls::default();
        let start = Cores::new(host(&[0, 1, 2, 3], 4), vec![0]);
        assert_eq!(start.bound, Some(vec![0]), "an inherited narrowing");
        assert_eq!(start.status_json()["effective"], 1);
        let (next, _) = settle(&start, 0, plan(&start.host, 0), &[1], binder(&calls, false));
        assert_eq!(
            (next.state.clone(), next.bound.clone()),
            (State::Unlimited, None)
        );
        assert_eq!(*calls.borrow(), vec![vec![0, 1, 2, 3]]);
        assert_eq!(
            Cores::new(host(&[0, 1], 2), vec![0, 1]).bound,
            None,
            "inherited every CPU"
        );
        assert_eq!(Cores::new(host(&[], 2), vec![]).bound, None, "no CPU ids");
    }

    #[test]
    fn an_adopted_child_takes_the_limit_or_every_cpu() {
        let mut c = Cores::new(host(&[0, 1, 2, 3], 4), vec![]);
        assert_eq!(
            adopted_cpus(&c),
            Some(vec![0, 1, 2, 3]),
            "no limit: widened like the rest"
        );
        c.bound = Some(vec![0]);
        assert_eq!(adopted_cpus(&c), Some(vec![0]));
        assert_eq!(
            adopted_cpus(&Cores::new(host(&[], 4), vec![])),
            None,
            "no CPU ids"
        );
    }

    #[test]
    fn a_host_without_cpu_ids_reports_a_limit_as_unsupported() {
        let calls = Calls::default();
        let start = Cores::new(host(&[], 8), vec![]);
        let (next, _) = settle(&start, 2, plan(&start.host, 2), &[1], binder(&calls, false));
        assert!(matches!(next.state, State::Unsupported(_)), "{next:?}");
        assert_eq!(next.status_json()["effective"], 8);
        assert!(calls.borrow().is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stat_fields_read_ppid_and_group_after_a_command_with_spaces_and_parentheses() {
        let stat = "4242 (node (core) x) S 4000 4100 4100 0 -1 4194560 1 0";
        assert_eq!(os::stat_fields(stat), Some((4000, 4100)));
        assert_eq!(os::stat_fields("garbage"), None);
    }

    #[test]
    fn detect_names_at_least_one_core() {
        let h = Host::detect();
        assert!(h.count >= 1, "{h:?}");
        #[cfg(any(target_os = "linux", windows))]
        assert!(h.cpus.len() >= h.count, "{h:?}");
    }

    /// Linux: detection reads the CPUs the kernel allows, not the affinity the starting thread inherited (a supervisor
    /// started from a process an earlier supervisor had bound). Runs in its own thread, so no other test is narrowed.
    #[cfg(target_os = "linux")]
    #[test]
    fn detect_reads_every_allowed_cpu_from_a_narrowed_thread() {
        let full = os::own_cpus().unwrap();
        if full.len() < 2 {
            eprintln!("skipped: this host offers one CPU");
            return;
        }
        let first = full[0];
        let (host, inherited) = std::thread::spawn(move || {
            // SAFETY: a zeroed cpu_set_t is empty; `first` is below CPU_SETSIZE; the size is that of the set.
            let narrowed = unsafe {
                let mut set: libc::cpu_set_t = std::mem::zeroed();
                libc::CPU_SET(first, &mut set);
                libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &set)
            };
            assert_eq!(narrowed, 0);
            let cores = Cores::detect();
            (cores.host, cores.bound)
        })
        .join()
        .unwrap();
        assert!(full.iter().all(|c| host.cpus.contains(c)), "{host:?}");
        assert_eq!(
            inherited,
            Some(vec![first]),
            "the inherited narrowing is a binding to undo"
        );
    }

    /// The CPUs one thread may run on, from `/proc/<pid>/task/<tid>/status`.
    #[cfg(target_os = "linux")]
    fn allowed(path: &str) -> Vec<usize> {
        let status = std::fs::read_to_string(path).unwrap();
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

    /// Linux: a child's whole tree and a separate root (an adopted core is no descendant) are bound, every thread. The
    /// test process itself is never bound: that would narrow every other test running in it.
    #[cfg(target_os = "linux")]
    #[test]
    fn bind_reaches_every_thread_of_a_tree_and_of_a_separate_root() {
        let host = Host::detect();
        if host.cpus.len() < 2 {
            eprintln!("skipped: this host offers one CPU");
            return;
        }
        let first = host.cpus[0];
        let mut tree = std::process::Command::new("/bin/sh")
            .args(["-c", "/bin/sleep 30 & wait"])
            .spawn()
            .unwrap();
        let mut separate = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let shell = tree.id();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let grandchild = loop {
            let found = std::fs::read_to_string(format!("/proc/{shell}/task/{shell}/children"))
                .ok()
                .and_then(|c| {
                    c.split_whitespace()
                        .next()
                        .and_then(|p| p.parse::<u32>().ok())
                });
            if let Some(pid) = found {
                break pid;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the shell started no sleep"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        let outcome = os::bind(&[shell, separate.id()], &[first]);
        for pid in [shell, grandchild, separate.id()] {
            for task in std::fs::read_dir(format!("/proc/{pid}/task"))
                .unwrap()
                .flatten()
            {
                let path = format!("{}/status", task.path().display());
                assert_eq!(allowed(&path), vec![first], "{path}");
            }
        }
        let _ = tree.kill();
        let _ = separate.kill();
        let _ = tree.wait();
        let _ = separate.wait();
        assert!(outcome.is_ok(), "{outcome:?}");
    }
}
