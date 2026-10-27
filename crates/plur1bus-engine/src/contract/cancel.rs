//! Cooperative caller cancellation and monotonic deadlines.

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A clonable cancellation flag and optional monotonic deadline.
/// Clones share caller cancellation and retain the same deadline.
#[derive(Clone, Debug)]
pub struct Cancel {
    deadline: Option<Instant>,
    flag: Arc<AtomicBool>,
}

impl Cancel {
    /// Create a token with no deadline and no caller cancellation.
    pub fn never() -> Cancel {
        Self {
            deadline: None,
            flag: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Create a token that expires at the given monotonic instant.
    pub fn with_deadline(at: Instant) -> Cancel {
        Self {
            deadline: Some(at),
            flag: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Cancel this token and every clone made from it.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
    }

    /// Report caller cancellation or an elapsed deadline.
    pub fn is_cancelled(&self) -> bool {
        self.check().is_err()
    }

    /// Return the remaining deadline budget, saturating at zero after expiry.
    /// Tokens created by never return None, including after caller cancellation.
    pub fn remaining(&self) -> Option<Duration> {
        self.deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
    }

    /// Check cancellation at a stage boundary; explicit caller cancellation takes precedence.
    pub fn check(&self) -> Result<(), Cancelled> {
        if self.flag.load(Ordering::Acquire) {
            return Err(Cancelled {
                reason: CancelReason::Caller,
            });
        }
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(Cancelled {
                reason: CancelReason::Deadline,
            });
        }
        Ok(())
    }
}

/// The source that ended an operation's cancellation budget.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CancelReason {
    /// The caller explicitly cancelled the operation.
    Caller,
    /// The monotonic deadline elapsed.
    Deadline,
}

/// A typed cancellation result without caller-provided text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Cancelled {
    /// Why the operation was cancelled.
    pub reason: CancelReason,
}

impl fmt::Display for Cancelled {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.reason {
            CancelReason::Caller => "caller",
            CancelReason::Deadline => "deadline",
        })
    }
}

impl std::error::Error for Cancelled {}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn a_deadline_in_the_past_is_cancelled_at_once() {
        let cancel = Cancel::with_deadline(Instant::now() - Duration::from_millis(1));
        assert!(cancel.is_cancelled());
        assert_eq!(
            cancel.check(),
            Err(Cancelled {
                reason: CancelReason::Deadline
            })
        );
        assert_eq!(cancel.remaining(), Some(Duration::ZERO));
    }

    #[test]
    fn cancel_flips_is_cancelled_and_check_returns_caller() {
        let cancel = Cancel::never();
        assert!(!cancel.is_cancelled());
        assert_eq!(cancel.check(), Ok(()));
        assert_eq!(cancel.remaining(), None);
        let shared = cancel.clone();
        cancel.cancel();
        assert!(shared.is_cancelled());
        assert_eq!(
            shared.check(),
            Err(Cancelled {
                reason: CancelReason::Caller
            })
        );
    }

    #[test]
    fn remaining_counts_down_and_never_goes_negative() {
        let cancel = Cancel::with_deadline(Instant::now() + Duration::from_millis(20));
        let initial = cancel.remaining().unwrap();
        assert!(initial <= Duration::from_millis(20));
        std::thread::sleep(Duration::from_millis(25));
        assert!(cancel.remaining().unwrap() <= initial);
        assert_eq!(cancel.remaining(), Some(Duration::ZERO));
        assert_eq!(
            cancel.check(),
            Err(Cancelled {
                reason: CancelReason::Deadline
            })
        );
    }
}
