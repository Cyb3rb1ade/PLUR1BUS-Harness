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
