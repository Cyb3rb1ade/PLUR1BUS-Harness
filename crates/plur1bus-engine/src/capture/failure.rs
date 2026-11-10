//! Capture failure classes for retained work (RE-D155, RE-D156).
//!
//! Only an explicit list of failures is transient (I/O, cancellation, shutdown, an
//! unreachable host or provider, a busy lease, maintenance); retained work then stays
//! pending and recovery repeats it, at most [`MAX_RECOVERY_ATTEMPTS`] times. Every other
//! failure is terminal for the affected step: it is closed with a fixed, content-free
//! reason. The matches are exhaustive without wildcard arms, so a new error variant must
//! be classified deliberately.

use crate::contract::{EmbedError, EngineError, HostError, MemoryOpErrorCode, StoreError};

/// Recovery attempts per retained entry, counted durably across restarts.
pub const MAX_RECOVERY_ATTEMPTS: u32 = 5;

/// How retained capture work proceeds after a failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureClass {
    /// Keep the work pending; recovery repeats it.
    Transient,
    /// Close the affected step with this fixed reason.
    Terminal(&'static str),
}

/// `NotAvailable` reasons that describe a temporary state rather than a refusal.
const TRANSIENT_REASONS: [&str; 6] = [
    "closed",
    "engine-closed",
    "workspace-maintenance",
    "startup-recovery-incomplete",
    "startup-recovery-deadline",
    "capture-drain-incomplete",
];

/// Named terminal `NotAvailable` reasons recorded as themselves.
const NAMED_TERMINAL: [&str; 3] = [
    // F11: diarization media IDs without proven host provenance.
    "speaker-media-authority-unavailable",
    // The native Neo journal has no partition for this owner.
    "neo-owner-not-applicable",
    // The workspace owner switched capture off.
    "workspace-policy-disabled",
];

/// Every fixed reason a closed post-store step may record (no content).
pub const STEP_REASONS: [&str; 12] = [
    "speaker-media-authority-unavailable",
    "neo-owner-not-applicable",
    "workspace-policy-disabled",
    "capability-unavailable",
    "invalid-input",
    "store-refused",
    "tombstone-blocked",
    "embedding-refused",
    "host-refused",
    "operation-refused",
    "identity-mismatch",
    "untrusted-path",
];

/// Whether a recorded skip reason is one of the fixed step reasons.
#[must_use]
pub fn is_step_reason(reason: &str) -> bool {
    STEP_REASONS.contains(&reason)
}

/// Classify a failure of retained capture work.
#[must_use]
pub fn classify(error: &EngineError) -> FailureClass {
    use FailureClass::{Terminal, Transient};
    match error {
        EngineError::Cancelled(_) => Transient,
        EngineError::Store(error) => match error {
            StoreError::Io { .. } | StoreError::Unavailable | StoreError::Busy => Transient,
            StoreError::IdentityMismatch => Terminal("identity-mismatch"),
            StoreError::Corrupt | StoreError::ReadOnly => Terminal("store-refused"),
            StoreError::InvalidInput => Terminal("invalid-input"),
            StoreError::UntrustedPath => Terminal("untrusted-path"),
            StoreError::TombstoneBlocked => Terminal("tombstone-blocked"),
        },
        EngineError::Embedding(error) => match error {
            EmbedError::Cancelled(_)
            | EmbedError::Unavailable
            | EmbedError::ProviderFailed { .. } => Transient,
            EmbedError::InvalidVector | EmbedError::DimensionMismatch { .. } => {
                Terminal("embedding-refused")
            }
        },
        EngineError::Host(error) => match error {
            HostError::Cancelled(_) | HostError::Unavailable | HostError::Failed => Transient,
            HostError::Denied | HostError::InvalidResponse => Terminal("host-refused"),
        },
        EngineError::MemoryOp(error) => match error.code {
            MemoryOpErrorCode::Storage
            | MemoryOpErrorCode::LockLost
            | MemoryOpErrorCode::LockBusy
            | MemoryOpErrorCode::EmbedderUnavailable => Transient,
            MemoryOpErrorCode::NotFound
            | MemoryOpErrorCode::Denied
            | MemoryOpErrorCode::InvalidInput
            | MemoryOpErrorCode::ApprovalRequired
            | MemoryOpErrorCode::Conflict
            | MemoryOpErrorCode::Unsupported
            | MemoryOpErrorCode::IdentityAlreadyBound
            | MemoryOpErrorCode::LedgerCorrupt
            | MemoryOpErrorCode::EmbeddingIdentityMismatch => Terminal("operation-refused"),
        },
        EngineError::NotAvailable { reason } => {
            if TRANSIENT_REASONS.contains(&reason.as_str()) {
                Transient
            } else {
                Terminal(
                    NAMED_TERMINAL
                        .iter()
                        .copied()
                        .find(|named| named == reason)
                        .unwrap_or("capability-unavailable"),
                )
            }
        }
        EngineError::Invalid { .. } => Terminal("invalid-input"),
    }
}

#[cfg(test)]
mod tests {
    use super::{classify, is_step_reason, FailureClass, STEP_REASONS};
    use crate::contract::{
        CancelReason, Cancelled, EmbedError, EngineError, HostError, MemoryOpError,
        MemoryOpErrorCode, StoreError,
    };
    use FailureClass::{Terminal, Transient};

    fn cancelled() -> Cancelled {
        Cancelled {
            reason: CancelReason::Caller,
        }
    }

    #[test]
    fn every_error_variant_has_a_deliberate_class() {
        let not_available = |reason: &str| EngineError::NotAvailable {
            reason: reason.into(),
        };
        let cases: Vec<(EngineError, FailureClass)> = vec![
            (EngineError::Cancelled(cancelled()), Transient),
            (
                EngineError::Store(StoreError::Io {
                    kind: std::io::ErrorKind::Other,
                }),
                Transient,
            ),
            (StoreError::Unavailable.into(), Transient),
            (StoreError::Busy.into(), Transient),
            (
                StoreError::IdentityMismatch.into(),
                Terminal("identity-mismatch"),
            ),
            (StoreError::Corrupt.into(), Terminal("store-refused")),
            (StoreError::ReadOnly.into(), Terminal("store-refused")),
            (StoreError::InvalidInput.into(), Terminal("invalid-input")),
            (StoreError::UntrustedPath.into(), Terminal("untrusted-path")),
            (
                StoreError::TombstoneBlocked.into(),
                Terminal("tombstone-blocked"),
            ),
            (
                EngineError::Embedding(EmbedError::Cancelled(cancelled())),
                Transient,
            ),
            (EngineError::Embedding(EmbedError::Unavailable), Transient),
            (
                EngineError::Embedding(EmbedError::ProviderFailed { status: Some(503) }),
                Transient,
            ),
            (
                EngineError::Embedding(EmbedError::InvalidVector),
                Terminal("embedding-refused"),
            ),
            (
                EngineError::Embedding(EmbedError::DimensionMismatch {
                    expected: 2,
                    actual: 3,
                }),
                Terminal("embedding-refused"),
            ),
            (
                EngineError::Host(HostError::Cancelled(cancelled())),
                Transient,
            ),
            (EngineError::Host(HostError::Unavailable), Transient),
            (EngineError::Host(HostError::Failed), Transient),
            (
                EngineError::Host(HostError::Denied),
                Terminal("host-refused"),
            ),
            (
                EngineError::Host(HostError::InvalidResponse),
                Terminal("host-refused"),
            ),
            (not_available("closed"), Transient),
            (not_available("engine-closed"), Transient),
            (not_available("workspace-maintenance"), Transient),
            (not_available("startup-recovery-incomplete"), Transient),
            (not_available("startup-recovery-deadline"), Transient),
            (not_available("capture-drain-incomplete"), Transient),
            (
                not_available("speaker-media-authority-unavailable"),
                Terminal("speaker-media-authority-unavailable"),
            ),
            (
                not_available("neo-owner-not-applicable"),
                Terminal("neo-owner-not-applicable"),
            ),
            (
                not_available("workspace-policy-disabled"),
                Terminal("workspace-policy-disabled"),
            ),
            (
                not_available("anything-else"),
                Terminal("capability-unavailable"),
            ),
            (
                EngineError::Invalid {
                    field: "f".into(),
                    message: "m".into(),
                },
                Terminal("invalid-input"),
            ),
        ];
        for (error, expected) in cases {
            let class = classify(&error);
            assert_eq!(class, expected, "{error}");
            if let Terminal(reason) = class {
                assert!(is_step_reason(reason), "{reason}");
            }
        }
        for (code, expected) in [
            (MemoryOpErrorCode::Storage, Transient),
            (MemoryOpErrorCode::LockLost, Transient),
            (MemoryOpErrorCode::LockBusy, Transient),
            (MemoryOpErrorCode::EmbedderUnavailable, Transient),
            (MemoryOpErrorCode::NotFound, Terminal("operation-refused")),
            (MemoryOpErrorCode::Denied, Terminal("operation-refused")),
            (
                MemoryOpErrorCode::InvalidInput,
                Terminal("operation-refused"),
            ),
            (
                MemoryOpErrorCode::ApprovalRequired,
                Terminal("operation-refused"),
            ),
            (MemoryOpErrorCode::Conflict, Terminal("operation-refused")),
            (
                MemoryOpErrorCode::Unsupported,
                Terminal("operation-refused"),
            ),
            (
                MemoryOpErrorCode::IdentityAlreadyBound,
                Terminal("operation-refused"),
            ),
            (
                MemoryOpErrorCode::LedgerCorrupt,
                Terminal("operation-refused"),
            ),
            (
                MemoryOpErrorCode::EmbeddingIdentityMismatch,
                Terminal("operation-refused"),
            ),
        ] {
            assert_eq!(
                classify(&EngineError::MemoryOp(MemoryOpError::new(code))),
                expected
            );
        }
        assert_eq!(STEP_REASONS.len(), 12);
    }
}
