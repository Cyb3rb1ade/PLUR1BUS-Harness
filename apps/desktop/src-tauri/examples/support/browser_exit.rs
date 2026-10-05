//! Hold handles to this fixture's actual browsers before teardown, avoiding PID reuse.
use std::sync::{Arc, Mutex};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0},
    System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
};

#[derive(Default)]
pub struct BrowserExits {
    handles: Mutex<Vec<usize>>,
    failed: Mutex<bool>,
}
impl BrowserExits {
    pub fn capture(
        self: &Arc<Self>,
        window: &tauri::WebviewWindow,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let owner = self.clone();
        window.with_webview(move |webview| {
            let handle = (|| {
                let core = unsafe { webview.controller().CoreWebView2() }.ok()?;
                let mut pid = 0;
                unsafe { core.BrowserProcessId(&mut pid) }.ok()?;
                if pid == 0 {
                    return None;
                }
                let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
                (!handle.is_null()).then_some(handle as usize)
            })();
            match handle {
                Some(handle) => owner.handles.lock().unwrap().push(handle),
                None => *owner.failed.lock().unwrap() = true,
            }
        })?;
        Ok(())
    }
    pub fn wait(&self, expected: usize) -> Result<(), &'static str> {
        let handles = self.handles.lock().unwrap();
        if *self.failed.lock().unwrap() || handles.len() != expected {
            return Err("FIXTURE_BROWSER_CAPTURE_FAILED");
        }
        // One total exit budget, matching the production browser-exit gate.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        for &handle in handles.iter() {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let wait = unsafe {
                WaitForSingleObject(
                    handle as HANDLE,
                    remaining.as_millis().min(u32::MAX as u128) as u32,
                )
            };
            if wait != WAIT_OBJECT_0 {
                return Err("FIXTURE_BROWSER_EXIT_TIMEOUT");
            }
        }
        Ok(())
    }
}
impl Drop for BrowserExits {
    fn drop(&mut self) {
        for handle in self.handles.get_mut().unwrap().drain(..) {
            unsafe {
                CloseHandle(handle as HANDLE);
            }
        }
    }
}
