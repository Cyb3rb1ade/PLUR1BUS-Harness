//! Shared process liveness and persistable incarnation for supervisors and engine locks.
//!
//! A supervisor treats `OtherUser` as existing; a private-home lock can treat it as a foreign
//! holder. Incarnations use the process's start on Node's monotonic-millisecond clock, with
//! Linux's boot id separating equal clock values across reboots.

use std::{io, sync::OnceLock};

use serde::{Deserialize, Serialize};

/// What the operating system says about a process without signalling it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Liveness {
    /// The process exists and has not exited.
    Alive,
    /// The process has exited, is a zombie, or the pid is invalid.
    Gone,
    /// Access is denied because the pid is not available to this user.
    OtherUser,
}

/// The Node `procStart` shape written into cross-process lock files.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Incarnation {
    /// Process start on the monotonic clock, rounded to milliseconds.
    pub mono: i64,
    /// Linux boot id; null on other platforms or when unavailable.
    pub boot: Option<String>,
}

/// Inspect a pid without sending a signal; zombies count as gone.
pub fn alive(pid: u32) -> Liveness {
    platform_alive(pid)
}

#[cfg(unix)]
fn platform_alive(pid: u32) -> Liveness {
    let Ok(native_pid) = libc::pid_t::try_from(pid) else {
        return Liveness::Gone;
    };
    if native_pid <= 0 {
        return Liveness::Gone;
    }
    // SAFETY: signal zero only checks this positive pid and never sends a signal.
    let result = unsafe { libc::kill(native_pid, 0) };
    let state = if result == 0 {
        Liveness::Alive
    } else if io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) {
        Liveness::OtherUser
    } else {
        Liveness::Gone
    };
    if state != Liveness::Gone && is_zombie(pid) {
        Liveness::Gone
    } else {
        state
    }
}

#[cfg(windows)]
fn platform_alive(pid: u32) -> Liveness {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, WAIT_OBJECT_0},
        System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        },
    };
    if pid == 0 {
        return Liveness::Gone;
    }
    // SAFETY: OpenProcess returns an owned handle or null; no process is modified.
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        // SAFETY: reads the thread-local error immediately after the failed API call.
        return if unsafe { GetLastError() } == ERROR_ACCESS_DENIED {
            Liveness::OtherUser
        } else {
            Liveness::Gone
        };
    }
    // SAFETY: a live handle opened with SYNCHRONIZE; zero timeout never blocks.
    let exited = unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0;
    // SAFETY: this function owns the handle and closes it once.
    unsafe { CloseHandle(handle) };
    if exited {
        Liveness::Gone
    } else {
        Liveness::Alive
    }
}

/// Whether the process has exited but still has an unreaped zombie record.
#[cfg(target_os = "linux")]
pub fn is_zombie(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|text| {
            text.get(text.rfind(')')? + 1..)?
                .trim_start()
                .chars()
                .next()
        })
        == Some('Z')
}

/// Whether macOS reports a zombie through `proc_pidinfo`, including unreaped children.
#[cfg(target_os = "macos")]
pub fn is_zombie(pid: u32) -> bool {
    let Ok(pid) = libc::c_int::try_from(pid) else {
        return false;
    };
    // SAFETY: zeroed POD filled by proc_pidinfo up to the supplied buffer size.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: the writable local buffer is exactly `size` bytes long.
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            1,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    read == size && info.pbi_status == libc::SZOMB
}

/// Other systems expose exited state directly or have no zombie inspection API here.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn is_zombie(_pid: u32) -> bool {
    false
}

/// This process's stable monotonic start and optional boot id, in Node's `procStart` shape.
pub fn incarnation() -> io::Result<Incarnation> {
    static OWN: OnceLock<Incarnation> = OnceLock::new();
    if let Some(own) = OWN.get() {
        return Ok(own.clone());
    }
    let own = incarnation_of(std::process::id())?;
    Ok(OWN.get_or_init(|| own).clone())
}

/// Inspect the same start identity for another pid, for provenance checks and parity tests.
pub fn incarnation_of(pid: u32) -> io::Result<Incarnation> {
    let mono = start_milliseconds(pid)?;
    #[cfg(target_os = "linux")]
    let boot = {
        static BOOT: OnceLock<Option<String>> = OnceLock::new();
        BOOT.get_or_init(|| {
            std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
        .clone()
    };
    #[cfg(not(target_os = "linux"))]
    let boot = None;
    Ok(Incarnation { mono, boot })
}

#[cfg(target_os = "linux")]
fn start_milliseconds(pid: u32) -> io::Result<i64> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let fields = text
        .get(text.rfind(')').ok_or_else(invalid_process_data)? + 1..)
        .ok_or_else(invalid_process_data)?;
    let ticks: i64 = fields
        .split_whitespace()
        .nth(19)
        .ok_or_else(invalid_process_data)?
        .parse()
        .map_err(|_| invalid_process_data())?;
    // SAFETY: sysconf only queries the clock's ticks per second and takes a named constant.
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if hz <= 0 {
        return Err(io::Error::last_os_error());
    }
    // /proc exposes start_boottime, which includes suspend time. Node's uv_hrtime
    // uses CLOCK_MONOTONIC, so remove the current BOOTTIME/MONOTONIC offset.
    let mut boot: libc::timespec = unsafe { std::mem::zeroed() };
    let mut monotonic: libc::timespec = unsafe { std::mem::zeroed() };
    // SAFETY: both calls initialize live timespec output values for valid Linux clocks.
    if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut boot) } != 0
        || unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut monotonic) } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let milliseconds =
        |time: libc::timespec| time.tv_sec as f64 * 1000.0 + time.tv_nsec as f64 / 1_000_000.0;
    let suspend_ms = milliseconds(boot) - milliseconds(monotonic);
    Ok((ticks as f64 * 1000.0 / hz as f64 - suspend_ms).round() as i64)
}

#[cfg(target_os = "macos")]
// libc 0.2.189 binds mach_absolute_time but not mach_continuous_time.
unsafe extern "C" {
    fn mach_continuous_time() -> u64;
}

#[cfg(target_os = "macos")]
// libc deprecates its mach_timebase_info binding in favour of the mach2 crate; the Darwin API itself is current,
// and a new dependency for this one conversion is not worth it.
#[allow(deprecated)]
fn start_milliseconds(pid: u32) -> io::Result<i64> {
    let native_pid = libc::c_int::try_from(pid).map_err(|_| invalid_process_data())?;
    // SAFETY: zeroed POD buffers passed to the APIs with their matching types/flavor.
    let mut usage: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
    let mut timebase: libc::mach_timebase_info = unsafe { std::mem::zeroed() };
    // SAFETY: proc_pid_rusage writes the V2-sized live buffer; mach_timebase_info fills one POD.
    let status = unsafe {
        libc::proc_pid_rusage(
            native_pid,
            libc::RUSAGE_INFO_V2,
            (&mut usage as *mut libc::rusage_info_v2).cast(),
        )
    };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: points to one live timebase-info value.
    if unsafe { libc::mach_timebase_info(&mut timebase) } != 0 || timebase.denom == 0 {
        return Err(invalid_process_data());
    }
    // SAFETY: both calls only read the process-wide Mach clocks.
    let absolute_now = unsafe { libc::mach_absolute_time() };
    let continuous_now = unsafe { mach_continuous_time() };
    let to_ms = |ticks: u64| {
        ticks as f64 * f64::from(timebase.numer) / f64::from(timebase.denom) / 1_000_000.0
    };
    // ri_proc_start_abstime is mach_absolute_time and stops while the machine sleeps.
    // Node's process.hrtime follows mach_continuous_time. Adding the current gap matches
    // Node when the target has not slept since it started, the same approximation the
    // Linux path makes between CLOCK_BOOTTIME and CLOCK_MONOTONIC.
    let start_ms = to_ms(usage.ri_proc_start_abstime) + to_ms(continuous_now) - to_ms(absolute_now);
    Ok(start_ms.round() as i64)
}

#[cfg(windows)]
fn start_milliseconds(pid: u32) -> io::Result<i64> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME},
        System::{
            Performance::{QueryPerformanceCounter, QueryPerformanceFrequency},
            SystemInformation::GetSystemTimePreciseAsFileTime,
            Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        },
    };
    // SAFETY: OpenProcess returns an owned handle or null and does not modify the process.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: FILETIME is POD; the APIs initialize every field of the outputs.
    let mut times: [FILETIME; 5] = unsafe { std::mem::zeroed() };
    let mut counter = 0i64;
    let mut frequency = 0i64;
    // SAFETY: outputs name separate elements of a fixed, writable FILETIME array.
    let status = unsafe {
        GetProcessTimes(
            handle,
            &mut times[0],
            &mut times[1],
            &mut times[2],
            &mut times[3],
        )
    };
    let error = io::Error::last_os_error();
    // SAFETY: this function owns the handle and closes it exactly once.
    unsafe { CloseHandle(handle) };
    if status == 0 {
        return Err(error);
    }
    // SAFETY: all three calls only initialize writable local output buffers.
    unsafe { GetSystemTimePreciseAsFileTime(&mut times[4]) };
    if unsafe { QueryPerformanceCounter(&mut counter) } == 0
        || unsafe { QueryPerformanceFrequency(&mut frequency) } == 0
        || frequency <= 0
    {
        return Err(io::Error::last_os_error());
    }
    let ticks =
        |time: &FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    let elapsed_ms = ticks(&times[4]).saturating_sub(ticks(&times[0])) as f64 / 10_000.0;
    Ok((counter as f64 * 1000.0 / frequency as f64 - elapsed_ms).round() as i64)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn start_milliseconds(_pid: u32) -> io::Result<i64> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process start clock is unavailable",
    ))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn invalid_process_data() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "process start metadata is invalid",
    )
}

/// Where a process comes from as Windows records it ([`origin`]): the pid of the process that created it and when it was
/// created (100 ns intervals since 1601).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Origin {
    /// The creator's pid. Windows keeps the number after the creator is gone, also once that pid is reused.
    pub parent: u32,
    /// The creation time.
    pub created: u64,
}

/// Whether a process of `origin` is the child of the process `parent`, created at `parent_created` (re-review M-b): it
/// names `parent` as its creator and was created no earlier than `parent`. A recorded creator whose pid was reused since
/// is a younger process than its "child", so the number alone never binds them.
pub fn is_child_of(origin: Origin, parent: u32, parent_created: u64) -> bool {
    parent != 0 && origin.parent == parent && origin.created >= parent_created
}

/// The [`Origin`] of `pid` on Windows: `th32ParentProcessID` from a Toolhelp32 process snapshot and the creation time
/// from `GetProcessTimes`. `None` when `pid` is not in the snapshot or cannot be opened. Hold a handle to `pid` while
/// calling it (a pinned peer): otherwise the pid could be reused between the two reads.
#[cfg(windows)]
pub fn origin(pid: u32) -> Option<Origin> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        },
    };
    // SAFETY: a new snapshot handle (closed below) or INVALID_HANDLE_VALUE.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    // SAFETY: PROCESSENTRY32W is POD; dwSize is set as the API requires.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = u32::try_from(std::mem::size_of::<PROCESSENTRY32W>()).unwrap_or(u32::MAX);
    let mut parent = None;
    // SAFETY: the open snapshot and one writable entry with its size set.
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while more {
        if entry.th32ProcessID == pid {
            parent = Some(entry.th32ParentProcessID);
            break;
        }
        // SAFETY: as above.
        more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    // SAFETY: this function owns the snapshot handle and closes it once.
    unsafe { CloseHandle(snapshot) };
    let parent = parent?;
    // SAFETY: OpenProcess returns an owned handle or null and does not modify the process.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    // SAFETY: FILETIME is POD; GetProcessTimes initializes the four outputs.
    let mut times: [FILETIME; 4] = unsafe { std::mem::zeroed() };
    // SAFETY: the open handle and four separate writable outputs.
    let read = unsafe {
        GetProcessTimes(
            handle,
            &mut times[0],
            &mut times[1],
            &mut times[2],
            &mut times[3],
        )
    } != 0;
    // SAFETY: this function owns the handle and closes it once.
    unsafe { CloseHandle(handle) };
    read.then(|| Origin {
        parent,
        created: (u64::from(times[0].dwHighDateTime) << 32) | u64::from(times[0].dwLowDateTime),
    })
}

/// The parent of `pid` as the OS reports it now: Linux `/proc/<pid>/stat`, macOS `proc_pidinfo(PROC_PIDTBSDINFO)`.
/// `None` when it cannot be read (no such process) and on Windows, which keeps no live parent link (callers fall back to
/// another check there).
pub fn parent_pid(pid: u32) -> Option<u32> {
    platform_parent(pid)
}

#[cfg(target_os = "linux")]
fn platform_parent(pid: u32) -> Option<u32> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // `<pid> (<comm>) <state> <ppid> ...`; the command name may itself hold spaces and parentheses.
    text.get(text.rfind(')')? + 1..)?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

#[cfg(target_os = "macos")]
fn platform_parent(pid: u32) -> Option<u32> {
    let pid = libc::c_int::try_from(pid).ok().filter(|p| *p > 0)?;
    // SAFETY: zeroed POD filled by proc_pidinfo up to the supplied buffer size.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: the writable local buffer is exactly `size` bytes long.
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    (read == size).then_some(info.pbi_ppid)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn platform_parent(_pid: u32) -> Option<u32> {
    None
}

/// Ties the life of the process `cmd` starts to this process (P4-10 security review M4: the legacy core behind the Rust
/// front door must not outlive it, also when the front door is killed). Linux: `PR_SET_PDEATHSIG(SIGKILL)` in the child
/// before `exec`, so the kernel kills it when the thread that spawned it ends; spawn from the main thread, which ends
/// only with the process. A child whose parent is already gone by then does not start. Other Unix systems have no such
/// signal: nothing is changed (macOS relies on the kill paths of the supervisor and 1staid). Windows: see
/// [`crate::win::KillOnClose`], which needs the spawned process.
#[cfg(unix)]
pub fn die_with_parent(cmd: &mut std::process::Command) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: getpid(2) only reads an attribute of this process.
        let parent = unsafe { libc::getpid() };
        // SAFETY: the hook runs in the child between fork and exec. It calls only async-signal-safe functions (prctl,
        // getppid) and allocates nothing (both error values are plain OS codes).
        unsafe {
            cmd.pre_exec(move || {
                if libc::prctl(
                    libc::PR_SET_PDEATHSIG,
                    libc::SIGKILL as libc::c_ulong,
                    0 as libc::c_ulong,
                    0 as libc::c_ulong,
                    0 as libc::c_ulong,
                ) != 0
                {
                    return Err(io::Error::last_os_error());
                }
                // The parent died before the signal was armed: the child would be an orphan from the start.
                if libc::getppid() != parent {
                    return Err(io::Error::from_raw_os_error(libc::ESRCH));
                }
                Ok(())
            });
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = cmd;
}

/// The OS hostname used by Node's registry-lock host comparison.
pub fn hostname() -> io::Result<String> {
    #[cfg(unix)]
    {
        let mut bytes = [0u8; 256];
        // SAFETY: the byte buffer is writable and its full size is passed to gethostname.
        if unsafe { libc::gethostname(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let length = bytes
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(bytes.len());
        Ok(String::from_utf8_lossy(&bytes[..length]).into_owned())
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Networking::WinSock::{
            GetHostNameW, WSACleanup, WSAGetLastError, WSAStartup, WSADATA,
        };
        // SAFETY: WSADATA is POD, and WSAStartup fills its complete output buffer.
        let mut data: WSADATA = unsafe { std::mem::zeroed() };
        // SAFETY: request Winsock 2.2 with a live writable WSADATA value.
        let startup = unsafe { WSAStartup(0x0202, &mut data) };
        if startup != 0 {
            return Err(io::Error::from_raw_os_error(startup));
        }
        let mut name = [0u16; 256];
        // SAFETY: the writable wide-character buffer has the supplied capacity.
        let status = unsafe { GetHostNameW(name.as_mut_ptr(), name.len() as i32) };
        // SAFETY: read the Winsock error before any cleanup can change it.
        let error = if status != 0 {
            Some(unsafe { WSAGetLastError() })
        } else {
            None
        };
        // SAFETY: balance this call's successful WSAStartup reference, including on failure.
        unsafe { WSACleanup() };
        if let Some(error) = error {
            return Err(io::Error::from_raw_os_error(error));
        }
        let length = name
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(name.len());
        Ok(String::from_utf16_lossy(&name[..length]))
    }
}

#[cfg(test)]
mod tests {
    /// Re-review M-b: the decision behind the Windows legacy lookup. A process is the child of `parent` only when it names
    /// `parent` as its creator and was created no earlier than `parent` was; a creator whose pid was reused since (the
    /// recorded number now belongs to a younger process) does not count, nor does any other creator.
    #[test]
    fn a_child_names_its_parent_and_was_created_after_it() {
        #[cfg(windows)]
        {
            // The real reads: a child of this process names it and is younger.
            let mut child = std::process::Command::new("cmd")
                .args(["/C", "ping -n 3 127.0.0.1 > NUL"])
                .spawn()
                .unwrap();
            let own = super::origin(std::process::id()).expect("this process's origin");
            let of_child = super::origin(child.id());
            let _ = child.kill();
            let _ = child.wait();
            let of_child = of_child.expect("the child's origin");
            assert_eq!(of_child.parent, std::process::id());
            assert!(super::is_child_of(
                of_child,
                std::process::id(),
                own.created
            ));
        }
        use super::{is_child_of, Origin};
        let door = (4242, 1_000);
        let child = |parent, created| Origin { parent, created };
        assert!(
            is_child_of(child(4242, 1_000), door.0, door.1),
            "created in the same tick"
        );
        assert!(is_child_of(child(4242, 1_500), door.0, door.1));
        assert!(
            !is_child_of(child(4242, 999), door.0, door.1),
            "created before the front door: its creator was an earlier process with that pid"
        );
        assert!(
            !is_child_of(child(4243, 1_500), door.0, door.1),
            "another creator"
        );
        assert!(
            !is_child_of(child(0, 1_500), 0, 0),
            "pid 0 is nobody's parent"
        );
    }

    use super::*;

    #[test]
    fn own_process_is_alive_and_has_a_stable_incarnation() {
        assert_eq!(alive(std::process::id()), Liveness::Alive);
        assert_eq!(alive(0), Liveness::Gone);
        assert_eq!(alive(u32::MAX), Liveness::Gone);
        let first = incarnation().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        assert_eq!(incarnation().unwrap(), first);
        assert!(first.mono > 0);
        assert!(!hostname().unwrap().is_empty());
    }

    #[test]
    fn the_parent_of_a_child_is_this_process_where_the_os_says() {
        #[cfg(unix)]
        {
            let mut child = std::process::Command::new("sleep")
                .arg("5")
                .spawn()
                .unwrap();
            let parent = parent_pid(child.id());
            let _ = child.kill();
            let _ = child.wait();
            assert_eq!(parent, Some(std::process::id()));
            assert_eq!(
                parent_pid(std::process::id()),
                Some(std::os::unix::process::parent_id())
            );
            assert_eq!(parent_pid(u32::MAX), None);
        }
        #[cfg(windows)]
        assert_eq!(parent_pid(std::process::id()), None, "no live parent link");
    }

    /// Linux: a child started with [`die_with_parent`] gets SIGKILL when the thread that spawned it ends.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_bound_child_dies_with_the_thread_that_spawned_it() {
        let pid = std::thread::spawn(|| {
            let mut cmd = std::process::Command::new("sleep");
            cmd.arg("30");
            die_with_parent(&mut cmd);
            let child = cmd.spawn().unwrap();
            let pid = child.id();
            std::mem::forget(child); // reaped below; the spawning thread ends here
            pid
        })
        .join()
        .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while alive(pid) != Liveness::Gone {
            assert!(
                std::time::Instant::now() < deadline,
                "the bound child outlived its spawner"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        // SAFETY: reaps this test's own child.
        unsafe { libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), 0) };
    }

    #[cfg(unix)]
    #[test]
    fn a_zombie_is_gone_before_its_parent_reaps_it() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while alive(child.id()) != Liveness::Gone {
            assert!(
                std::time::Instant::now() < deadline,
                "exited child remained alive"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        child.wait().unwrap();
    }
}
