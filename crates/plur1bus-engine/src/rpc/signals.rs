//! Process-owned shutdown signals. Handlers only set an atomic flag.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

static REQUESTED: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
pub(crate) fn request() {
    REQUESTED.store(true, Ordering::Relaxed);
}

pub(crate) fn requested() -> bool {
    REQUESTED.load(Ordering::Relaxed)
}

#[cfg(unix)]
extern "C" fn handler(_: libc::c_int) {
    REQUESTED.store(true, Ordering::Relaxed);
}

/// Restores the original signal handlers after the serving scope.
pub(crate) struct Guard {
    #[cfg(unix)]
    previous: Vec<(libc::c_int, libc::sighandler_t)>,
}

impl Guard {
    pub(crate) fn install() -> io::Result<Self> {
        REQUESTED.store(false, Ordering::Relaxed);
        #[cfg(unix)]
        {
            let mut guard = Self {
                previous: Vec::new(),
            };
            for signal in [libc::SIGINT, libc::SIGTERM] {
                // SAFETY: the handler has C ABI, stays loaded, and only performs a lock-free atomic store.
                let previous =
                    unsafe { libc::signal(signal, handler as *const () as libc::sighandler_t) };
                if previous == libc::SIG_ERR {
                    return Err(io::Error::last_os_error());
                }
                guard.previous.push((signal, previous));
            }
            Ok(guard)
        }
        #[cfg(windows)]
        {
            // SAFETY: the process owns registration; the callback remains valid until removal in Drop.
            if unsafe {
                windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(console_handler), 1)
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Self {})
        }
    }
}

#[cfg(windows)]
unsafe extern "system" fn console_handler(event: u32) -> i32 {
    if matches!(event, 0 | 1 | 2 | 5 | 6) {
        REQUESTED.store(true, Ordering::Relaxed);
        1
    } else {
        0
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        #[cfg(unix)]
        for (signal, previous) in self.previous.drain(..).rev() {
            // SAFETY: restore exactly the dispositions returned by signal() in this serving scope.
            unsafe {
                libc::signal(signal, previous);
            }
        }
        #[cfg(windows)]
        // SAFETY: remove only the callback registered by this scope.
        unsafe {
            windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(console_handler), 0);
        }
    }
}
