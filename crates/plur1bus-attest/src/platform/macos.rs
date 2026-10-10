//! macOS: LocalAuthentication. `LAContext.evaluatePolicy(.deviceOwnerAuthentication)` shows the system's own dialog: Touch ID
//! where the Mac has it enrolled, the account password otherwise (and as the fallback after failed fingerprints). A fresh
//! context is made for every request, so nothing is ever reused from an earlier confirmation. The reason string is the
//! request's text.
use crate::mapping::la_error;
use crate::platform::Platform;
use crate::protocol::{Outcome, Probe};
use block2::RcBlock;
use objc2::runtime::Bool;
use objc2_foundation::{NSError, NSString};
use objc2_local_authentication::{LAContext, LAPolicy};
use std::ptr::NonNull;
use std::sync::mpsc;
use std::time::Duration;

pub struct MacOs;

fn method_of(ctx: &LAContext) -> &'static str {
    // A Mac whose fingerprint reader is enrolled can evaluate the biometric-only policy (Macs have Touch ID, no Face ID); the
    // dialog of `deviceOwnerAuthentication` then asks for the finger first. Otherwise it asks for the account password.
    if unsafe { ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics) }
        .is_ok()
    {
        "touch-id"
    } else {
        "macos-password"
    }
}

impl Platform for MacOs {
    fn probe(&self) -> Probe {
        let ctx = unsafe { LAContext::new() };
        match unsafe { ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication) } {
            Ok(()) => Probe::Available {
                method: method_of(&ctx).into(),
            },
            Err(_) => Probe::Unavailable {
                reason: "unavailable".into(),
            },
        }
    }

    fn confirm(&self, text: &str, ttl: Duration) -> Outcome {
        let ctx = unsafe { LAContext::new() };
        if unsafe { ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication) }.is_err() {
            return Outcome::Unavailable;
        }
        let method = method_of(&ctx);
        let (tx, rx) = mpsc::channel::<Result<(), isize>>();
        let reply = RcBlock::new(move |ok: Bool, err: *mut NSError| {
            let r = if ok.as_bool() {
                Ok(())
            } else {
                Err(NonNull::new(err)
                    .map(|e| unsafe { e.as_ref() }.code())
                    .unwrap_or(-1))
            };
            let _ = tx.send(r);
        });
        let reason = NSString::from_str(text);
        unsafe {
            ctx.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthentication,
                &reason,
                &reply,
            )
        };
        match rx.recv_timeout(ttl) {
            Ok(Ok(())) => Outcome::Confirmed {
                method: method.into(),
            },
            Ok(Err(code)) => la_error(code),
            Err(_) => {
                unsafe { ctx.invalidate() };
                Outcome::TimedOut
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Constructing the context and asking whether a policy could be evaluated shows no dialog; whatever the machine answers, the probe never panics.
    #[test]
    fn probe_shows_no_dialog_and_answers() {
        let _ = MacOs.probe();
    }
}
