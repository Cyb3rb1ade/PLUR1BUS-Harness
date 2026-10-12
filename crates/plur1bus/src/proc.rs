//! Process helpers shared by `1staid`, `config`, the module commands and the ext layer.

/// Whether `pid` names a live process (`kill(pid, 0)` / `OpenProcess` + a zero-timeout wait). Also used by `config`
/// routing (B6).
///
/// Windows: a process object outlives its process for as long as anyone holds a handle to it (the parent that has
/// not closed its `Child` yet, a supervisor's pin, an antivirus scanner that looked at the exit), so `OpenProcess`
/// alone succeeds on a pid that exited moments ago. Only an unsignalled handle means the process still runs, the way
/// `supervisor::adopt::Peer::alive` checks it.
pub(crate) fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // 0 and anything that does not fit a `pid_t` (read back as a negative number) are no process: `kill(0, 0)` and
        // `kill(-1, 0)` would signal the caller's process group and every process it may signal, and succeed.
        if pid == 0 || pid > i32::MAX as u32 {
            return false;
        }
        // SAFETY: signal 0 only checks that the pid exists; no signal is actually delivered.
        let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
        r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        };
        // SAFETY: a standard open/wait/close on a handle owned here; a null handle means the process could not be
        // opened.
        unsafe {
            let h = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            );
            if h.is_null() {
                return false;
            }
            let running = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
            CloseHandle(h);
            running
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::pid_alive;

    #[test]
    fn this_process_is_alive_and_a_process_that_has_exited_is_not() {
        assert!(pid_alive(std::process::id()));
        #[cfg(unix)]
        {
            let mut child = std::process::Command::new("sh")
                .args(["-c", "exit 0"])
                .spawn()
                .unwrap();
            let pid = child.id();
            child.wait().unwrap();
            assert!(!pid_alive(pid), "a reaped child must not read as alive");
        }
    }

    /// `kill(0, 0)` signals the caller's whole process group and `kill(-1, 0)` every process the caller may signal: both succeed.
    /// A pid file that holds 0, or a number that does not fit a `pid_t` (read as -1 or another negative value), names no
    /// process and must not read as a living one: a recorded owner like that has to count as stale, not as alive forever.
    #[cfg(unix)]
    #[test]
    fn a_number_that_is_no_process_id_is_never_alive() {
        for pid in [
            0u32,
            i32::MAX as u32 + 1,
            u32::MAX,
            u32::MAX - 1,
            0x8000_0001,
            3_000_000_000,
        ] {
            assert!(
                !pid_alive(pid),
                "{pid} is not a process id and was read as a live process"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_largest_valid_pid_that_nobody_uses_is_not_alive() {
        // i32::MAX is a valid pid_t that no system hands out in practice.
        assert!(!pid_alive(i32::MAX as u32));
    }
}
