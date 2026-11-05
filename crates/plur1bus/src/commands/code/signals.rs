//! Signal callbacks only publish intent. Terminal ownership remains with the frontend's restoration guard.
use super::CodeError;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub(super) struct Signals {
    pub interrupt: Arc<AtomicBool>,
    pub terminate: Arc<AtomicBool>,
    #[cfg(unix)]
    ids: Vec<signal_hook::SigId>,
}
impl Signals {
    pub fn install() -> Result<Self, CodeError> {
        let interrupt = Arc::new(AtomicBool::new(false));
        let terminate = Arc::new(AtomicBool::new(false));
        #[cfg(unix)]
        {
            use signal_hook::{
                consts::{SIGHUP, SIGINT, SIGTERM},
                flag::register,
            };
            let mut guard = Self {
                interrupt,
                terminate,
                ids: vec![],
            };
            guard.ids.push(register(SIGINT, guard.interrupt.clone())?);
            guard.ids.push(register(SIGTERM, guard.terminate.clone())?);
            guard.ids.push(register(SIGHUP, guard.terminate.clone())?);
            Ok(guard)
        }
        #[cfg(windows)]
        {
            windows::install()?;
            Ok(Self {
                interrupt,
                terminate,
            })
        }
    }
    pub fn take_interrupt(&self) -> bool {
        let local = self.interrupt.swap(false, Ordering::AcqRel);
        #[cfg(windows)]
        {
            local || windows::INTERRUPT.swap(false, Ordering::AcqRel)
        }
        #[cfg(not(windows))]
        {
            local
        }
    }
    pub fn terminated(&self) -> bool {
        let local = self.terminate.load(Ordering::Acquire);
        #[cfg(windows)]
        {
            local || windows::TERMINATE.load(Ordering::Acquire)
        }
        #[cfg(not(windows))]
        {
            local
        }
    }
}
impl Drop for Signals {
    fn drop(&mut self) {
        #[cfg(unix)]
        for id in self.ids.drain(..) {
            signal_hook::low_level::unregister(id);
        }
        #[cfg(windows)]
        windows::uninstall();
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::sync::atomic::{AtomicIsize, AtomicU32};
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleCtrlHandler, SetConsoleMode, CTRL_BREAK_EVENT,
        CTRL_CLOSE_EVENT, CTRL_C_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT, STD_INPUT_HANDLE,
        STD_OUTPUT_HANDLE,
    };
    pub static INTERRUPT: AtomicBool = AtomicBool::new(false);
    pub static TERMINATE: AtomicBool = AtomicBool::new(false);
    static INPUT: AtomicIsize = AtomicIsize::new(0);
    static OUTPUT: AtomicIsize = AtomicIsize::new(0);
    static INPUT_MODE: AtomicU32 = AtomicU32::new(0);
    static OUTPUT_MODE: AtomicU32 = AtomicU32::new(0);
    // SAFETY: the OS supplies the scalar event code. No Rust references, allocation or locks enter this callback.
    unsafe extern "system" fn handler(event: u32) -> i32 {
        match event {
            CTRL_C_EVENT | CTRL_BREAK_EVENT => {
                INTERRUPT.store(true, Ordering::Release);
                1
            }
            CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT | CTRL_SHUTDOWN_EVENT => {
                TERMINATE.store(true, Ordering::Release);
                // Windows may terminate immediately after this callback. Restore the original console modes now too.
                for (handle, mode) in [(&INPUT, &INPUT_MODE), (&OUTPUT, &OUTPUT_MODE)] {
                    let handle = handle.load(Ordering::Acquire);
                    if handle != 0 {
                        // SAFETY: only process-lifetime standard console handles verified by GetConsoleMode are published.
                        unsafe {
                            SetConsoleMode(handle as _, mode.load(Ordering::Acquire));
                        }
                    }
                }
                1
            }
            _ => 0,
        }
    }
    pub fn install() -> Result<(), CodeError> {
        INTERRUPT.store(false, Ordering::Release);
        TERMINATE.store(false, Ordering::Release);
        for (id, handle, mode) in [
            (STD_INPUT_HANDLE, &INPUT, &INPUT_MODE),
            (STD_OUTPUT_HANDLE, &OUTPUT, &OUTPUT_MODE),
        ] {
            let mut original = 0;
            // SAFETY: GetStdHandle returns a process-owned handle; original is a valid writable u32.
            unsafe {
                let current = GetStdHandle(id);
                if GetConsoleMode(current, &mut original) != 0 {
                    mode.store(original, Ordering::Release);
                    handle.store(current as isize, Ordering::Release);
                } else {
                    handle.store(0, Ordering::Release);
                }
            }
        }
        // SAFETY: handler has the required system ABI and remains loaded for the lifetime of this registration.
        if unsafe { SetConsoleCtrlHandler(Some(handler), 1) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    pub fn uninstall() {
        // SAFETY: unregister the same static callback; the process owns no borrowed callback data.
        unsafe {
            SetConsoleCtrlHandler(Some(handler), 0);
        }
    }
}
