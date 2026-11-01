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
