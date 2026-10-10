//! What each operating system's answer means for the protocol. Pure functions over the raw codes, compiled and tested on
//! every platform (CI has no Touch ID, no Hello and no polkit agent), so the mapping cannot drift unseen.
use crate::protocol::Outcome;

/// `LAError` codes of `LAContext.evaluatePolicy` (`NSError.code`, domain `com.apple.LocalAuthentication`).
pub fn la_error(code: isize) -> Outcome {
    match code {
        -2 | -4 | -9 => Outcome::Cancelled, // UserCancel, SystemCancel, AppCancel
        -3 => Outcome::Cancelled, // UserFallback: only offered when the app sets a fallback button
        -5 | -6 | -7 | -1004 => Outcome::Unavailable, // PasscodeNotSet, BiometryNotAvailable, BiometryNotEnrolled, NotInteractive
        _ => Outcome::Failed, // AuthenticationFailed (-1), BiometryLockout (-8), anything unknown
    }
}

/// `Windows.Security.Credentials.UI.UserConsentVerifierAvailability`: 0 Available, 1 DeviceNotPresent, 2 NotConfiguredForUser, 3 DisabledByPolicy, 4 DeviceBusy.
pub fn hello_available(code: i32) -> bool {
    code == 0
}

/// `UserConsentVerificationResult`: 0 Verified, 1 DeviceNotPresent, 2 NotConfiguredForUser, 3 DisabledByPolicy, 4 DeviceBusy, 5 RetriesExhausted, 6 Canceled.
pub fn hello_result(code: i32, method: &str) -> Outcome {
    match code {
        0 => Outcome::Confirmed {
            method: method.to_string(),
        },
        6 => Outcome::Cancelled,
        1..=3 => Outcome::Unavailable,
        _ => Outcome::Failed, // DeviceBusy, RetriesExhausted, unknown
    }
}

/// `ShellExecuteExW("runas")` failed with this Win32 error: the UAC consent prompt was declined (`ERROR_CANCELLED`, 1223) or could not be shown.
pub fn uac_error(win32: u32) -> Outcome {
    match win32 {
        1223 => Outcome::Cancelled,
        5 | 1260 => Outcome::Unavailable, // access denied / blocked by policy: no consent possible
        _ => Outcome::Failed,
    }
}

/// `pkcheck --allow-user-interaction` exit status: 0 authorized, 1 not authorized or error, 2 the dialog was dismissed, 3 a challenge
/// that no agent could answer (no polkit authentication agent in this session). A signal or an unknown status is a failure.
pub fn pkcheck_exit(code: Option<i32>, method: &str) -> Outcome {
    match code {
        Some(0) => Outcome::Confirmed {
            method: method.to_string(),
        },
        Some(2) => Outcome::Cancelled,
        Some(3) => Outcome::Unavailable,
        _ => Outcome::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_codes() {
        for c in [-2, -4, -9, -3] {
            assert_eq!(la_error(c), Outcome::Cancelled, "{c}");
        }
        for c in [-5, -6, -7, -1004] {
            assert_eq!(la_error(c), Outcome::Unavailable, "{c}");
        }
        for c in [-1, -8, 0, 12345] {
            assert_eq!(la_error(c), Outcome::Failed, "{c}");
        }
    }

    #[test]
    fn windows_hello_codes() {
        assert!(hello_available(0));
        for c in 1..=4 {
            assert!(!hello_available(c));
        }
        assert_eq!(
            hello_result(0, "windows-hello"),
            Outcome::Confirmed {
                method: "windows-hello".into()
            }
        );
        assert_eq!(hello_result(6, "windows-hello"), Outcome::Cancelled);
        for c in [1, 2, 3] {
            assert_eq!(hello_result(c, "windows-hello"), Outcome::Unavailable);
        }
        for c in [4, 5, 99, -1] {
            assert_eq!(hello_result(c, "windows-hello"), Outcome::Failed);
        }
    }

    #[test]
    fn windows_uac_errors() {
        assert_eq!(uac_error(1223), Outcome::Cancelled);
        assert_eq!(uac_error(5), Outcome::Unavailable);
        assert_eq!(uac_error(2), Outcome::Failed);
    }

    #[test]
    fn pkcheck_statuses() {
        assert_eq!(
            pkcheck_exit(Some(0), "polkit"),
            Outcome::Confirmed {
                method: "polkit".into()
            }
        );
        assert_eq!(pkcheck_exit(Some(2), "polkit"), Outcome::Cancelled);
        assert_eq!(pkcheck_exit(Some(3), "polkit"), Outcome::Unavailable);
        assert_eq!(pkcheck_exit(Some(1), "polkit"), Outcome::Failed);
        assert_eq!(pkcheck_exit(None, "polkit"), Outcome::Failed);
        assert_eq!(pkcheck_exit(Some(127), "polkit"), Outcome::Failed);
    }
}
