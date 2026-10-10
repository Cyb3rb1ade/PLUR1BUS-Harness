//! Windows: Windows Hello through `UserConsentVerifier` (fingerprint, face or PIN, whatever the account has set up). Without
//! Hello, the UAC consent prompt: the helper starts itself elevated with `--consent-noop` (`ShellExecuteExW` verb `runas`); the
//! secure-desktop prompt can only be answered by the person at the machine, and the elevated copy does nothing but exit 0.
//! Either way the reason shown to the person is the request's text (Hello) or UAC's own wording (the consent prompt).
use crate::mapping::{hello_available, hello_result, uac_error, uac_prompts_for};
use crate::platform::Platform;
use crate::protocol::{Outcome, Probe};
use std::sync::mpsc;
use std::time::Duration;
use windows::core::{HSTRING, PCWSTR};
use windows::Security::Credentials::UI::{
    UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
};
use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
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

/// `ConsentPromptBehaviorAdmin` / `EnableLUA` from the UAC policy key; `None` when unreadable.
fn uac_policy(name: &str) -> Option<u32> {
    let key = HSTRING::from("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System");
    let value = HSTRING::from(name);
    let mut data = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            &key,
            &value,
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    rc.is_ok().then_some(data)
}

fn already_elevated() -> bool {
    let mut token = windows::Win32::Foundation::HANDLE::default();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.is_err() {
        return true; // cannot tell: treat as elevated, which refuses
    }
    let mut elevation = TOKEN_ELEVATION::default();
    let mut len = 0u32;
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
    }
    .is_ok();
    let _ = unsafe { CloseHandle(token) };
    !ok || elevation.TokenIsElevated != 0
}

/// Whether `runas` would really put a consent prompt in front of the person. If UAC is off, set to "elevate without prompting", or
/// this process is already elevated, an elevated start is silent: that would be a confirmation nobody gave, so it is refused.
fn uac_prompts() -> bool {
    uac_prompts_for(
        uac_policy("EnableLUA"),
        uac_policy("ConsentPromptBehaviorAdmin"),
        already_elevated(),
    )
}

fn confirm_uac(ttl: Duration) -> Outcome {
    if !uac_prompts() {
        return Outcome::Unavailable;
    }
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
        // Hello, or a UAC consent prompt that really prompts; otherwise there is nothing a person could answer.
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
