//! Windows: Windows Hello through `UserConsentVerifier` (fingerprint, face or PIN, whatever the account has set up). Without
//! Hello, the UAC consent prompt: the helper starts itself elevated with `--consent-noop` (`ShellExecuteExW` verb `runas`); the
//! secure-desktop prompt can only be answered by the person at the machine, and the elevated copy does nothing but exit 0.
//! Either way the reason shown to the person is the request's text (Hello) or UAC's own wording (the consent prompt).
use crate::mapping::{hello_available, hello_result, uac_error};
use crate::platform::Platform;
use crate::protocol::{Outcome, Probe};
use std::sync::mpsc;
use std::time::Duration;
use windows::core::{HSTRING, PCWSTR};
use windows::Security::Credentials::UI::{
    UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
};
use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

pub struct Windows;

const HELLO: &str = "windows-hello";
const UAC: &str = "uac";

fn hello_availability() -> Option<UserConsentVerifierAvailability> {
    UserConsentVerifier::CheckAvailabilityAsync()
        .ok()?
        .join()
        .ok()
}

/// `HRESULT_FROM_WIN32(n)` → `n`; anything else keeps its low word.
fn win32_of(hr: windows::core::HRESULT) -> u32 {
    (hr.0 as u32) & 0xFFFF
}

fn confirm_hello(text: &str, ttl: Duration) -> Outcome {
    let message = HSTRING::from(text);
    let (tx, rx) = mpsc::channel::<Result<UserConsentVerificationResult, ()>>();
    std::thread::spawn(move || {
        let r = UserConsentVerifier::RequestVerificationAsync(&message)
            .and_then(|op| op.join())
            .map_err(|_| ());
        let _ = tx.send(r);
    });
    match rx.recv_timeout(ttl) {
        Ok(Ok(result)) => hello_result(result.0, HELLO),
        Ok(Err(())) => Outcome::Failed,
        Err(_) => Outcome::TimedOut,
    }
}

fn confirm_uac(ttl: Duration) -> Outcome {
    let Ok(exe) = std::env::current_exe() else {
        return Outcome::Failed;
    };
    let file = HSTRING::from(exe.as_os_str());
    let params = HSTRING::from("--consent-noop");
    let verb = HSTRING::from("runas");
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    if let Err(e) = unsafe { ShellExecuteExW(&mut info) } {
        return uac_error(win32_of(e.code()));
    }
    let process = info.hProcess;
    let wait_ms = ttl.as_millis().min(u128::from(u32::MAX - 1)) as u32;
    let outcome = if unsafe { WaitForSingleObject(process, wait_ms) } == WAIT_OBJECT_0 {
        let mut code = 1u32;
        if unsafe { GetExitCodeProcess(process, &mut code) }.is_ok() && code == 0 {
            Outcome::Confirmed { method: UAC.into() }
        } else {
            Outcome::Failed
        }
    } else {
        Outcome::TimedOut
    };
    let _ = unsafe { CloseHandle(process) };
    outcome
}

impl Platform for Windows {
    fn probe(&self) -> Probe {
        // The UAC consent prompt is always there for an interactive session, so Windows is available either way; the method says which.
        match hello_availability() {
            Some(a) if hello_available(a.0) => Probe::Available {
                method: HELLO.into(),
            },
            _ => Probe::Available { method: UAC.into() },
        }
    }

    fn confirm(&self, text: &str, ttl: Duration) -> Outcome {
        match hello_availability() {
            Some(a) if hello_available(a.0) => confirm_hello(text, ttl),
            _ => confirm_uac(ttl),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win32_code_is_the_low_word_of_the_hresult() {
        assert_eq!(win32_of(windows::core::HRESULT(0x800704C7u32 as i32)), 1223);
    }
}
