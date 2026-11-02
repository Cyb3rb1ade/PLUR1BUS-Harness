//! Process-owned shutdown signals. Handlers only set an atomic flag.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

static REQUESTED: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static CONSOLE_CLOSE: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static COMPLETE: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
pub(crate) fn request() {
    REQUESTED.store(true, Ordering::Release);
}

pub(crate) fn requested() -> bool {
    REQUESTED.load(Ordering::Acquire)
}

/// Console termination has a short OS-owned grace, unlike asynchronous Ctrl-C.
pub(crate) fn close_budget() -> Option<std::time::Duration> {
    #[cfg(windows)]
    if CONSOLE_CLOSE.load(Ordering::Acquire) {
        return Some(std::time::Duration::from_secs(2));
    }
    None
}

#[cfg(unix)]
extern "C" fn handler(_: libc::c_int) {
    REQUESTED.store(true, Ordering::Release);
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
            CONSOLE_CLOSE.store(false, Ordering::Release);
            COMPLETE.store(false, Ordering::Release);
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
        let closing = matches!(event, 2 | 5 | 6);
        if closing {
            CONSOLE_CLOSE.store(true, Ordering::Release);
        }
        REQUESTED.store(true, Ordering::Release);
        if closing {
            // Windows runs console callbacks on an ordinary thread, so waiting
            // here is permitted. Return before its forced-termination ceiling.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            while !COMPLETE.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
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
        {
            // Publish completion before unregistering: a pending console-close
            // callback can now return after run files and the listener are gone.
            COMPLETE.store(true, Ordering::Release);
            // SAFETY: remove only the callback registered by this scope.
            unsafe {
                windows_sys::Win32::System::Console::SetConsoleCtrlHandler(
                    Some(console_handler),
                    0,
                );
            }
        }
    }
}
