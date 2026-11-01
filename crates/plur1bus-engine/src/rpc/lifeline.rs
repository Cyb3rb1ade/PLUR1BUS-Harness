//! One replaceable lifeline and the ADR-012 orphan/adoption grace period.

use std::time::{Duration, Instant};

/// Initial parent lifeline. A hand-started server has no implicit stdin owner.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Lifeline {
    /// Run until an authenticated shutdown or platform termination signal.
    None,
    /// The spawning supervisor owns the stdin pipe.
    Stdin,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Source {
    None,
    Stdin,
    Connection(u64),
}

/// The current source alone can orphan the child; adoption cancels an earlier loss.
pub(crate) struct Watch {
    source: Source,
    deadline: Option<Instant>,
    grace: Duration,
}

impl Watch {
    pub(crate) fn new(source: Lifeline, grace: Duration) -> Self {
        Self {
            source: match source {
                Lifeline::None => Source::None,
                Lifeline::Stdin => Source::Stdin,
            },
            deadline: None,
            grace,
        }
    }
    fn lost(&mut self, source: Source) -> bool {
        if self.source == source {
            self.source = Source::None;
            self.deadline = Some(Instant::now() + self.grace);
            return true;
        }
        false
    }
    pub(crate) fn stdin_closed(&mut self) -> bool {
        self.lost(Source::Stdin)
    }
    pub(crate) fn connection_closed(&mut self, id: u64) -> bool {
        self.lost(Source::Connection(id))
    }
    pub(crate) fn adopt(&mut self, id: u64) {
        self.source = Source::Connection(id);
        self.deadline = None;
    }
    pub(crate) fn expired(&self) -> bool {
        self.deadline.is_some_and(|d| Instant::now() >= d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn adoption_replaces_stdin_and_previous_connection() {
        let mut w = Watch::new(Lifeline::Stdin, Duration::ZERO);
        w.stdin_closed();
        assert!(w.expired());
        w.adopt(1);
        w.stdin_closed();
        assert!(!w.expired());
        w.adopt(2);
        w.connection_closed(1);
        assert!(!w.expired());
        w.connection_closed(2);
        assert!(w.expired());
    }
}
