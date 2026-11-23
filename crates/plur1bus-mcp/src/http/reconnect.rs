use std::{sync::Mutex, time::Duration};

use rmcp::{model::ServerJsonRpcMessage, transport::common::client_side_sse::SseRetryPolicy};
use sse_stream::Sse;

use crate::connection_fault::{Cause, Fault};

const MAX_RECONNECTS: u32 = 10;
const MAX_DELAY_SECS: u64 = 60;

/// Retry delay and counting live in the backend because the SDK resets its
/// counter every time the HTTP server opens a fresh event stream.
#[derive(Debug)]
pub(crate) struct BackendRetry;

impl SseRetryPolicy for BackendRetry {
    fn retry(&self, _: usize) -> Option<Duration> {
        Some(Duration::ZERO)
    }
}

#[derive(Default)]
struct Schedule {
    opened: bool,
    attempts: u32,
    hint: Duration,
}

impl Schedule {
    fn delay(&mut self, resumed: bool) -> Option<Duration> {
        if !self.opened && !resumed {
            self.opened = true;
            return Some(Duration::ZERO);
        }
        self.opened = true;
        if self.attempts >= MAX_RECONNECTS {
            return None;
        }
        let delay = Duration::from_secs((1_u64 << self.attempts).min(MAX_DELAY_SECS));
        Some(delay.max(self.hint))
    }

    fn observe(&mut self, event: &mut Sse) {
        if let Some(retry) = event.retry.take() {
            self.hint = Duration::from_millis(retry)
                .clamp(Duration::from_secs(1), Duration::from_secs(MAX_DELAY_SECS));
        }
        if matches!(event.event.as_deref(), Some("message" | "") | None)
            && event.data.as_ref().is_some_and(|message| {
                serde_json::from_str::<ServerJsonRpcMessage>(message).is_ok()
            })
        {
            self.attempts = 0;
        }
    }
}

pub(super) struct Reconnect {
    schedule: Mutex<Schedule>,
    opening: tokio::sync::Mutex<()>,
    fault: Fault,
}

impl Reconnect {
    pub(super) fn new(fault: Fault) -> Self {
        Self {
            schedule: Mutex::new(Schedule::default()),
            opening: tokio::sync::Mutex::new(()),
            fault,
        }
    }

    pub(super) async fn before_get(&self, resumed: bool) -> Result<(), super::Error> {
        let _opening = self.opening.lock().await;
        let delay = self
            .schedule
            .lock()
            .map_err(|_| super::Error::Network)?
            .delay(resumed);
        let Some(delay) = delay else {
            self.fault.trip(Cause::ReconnectLimit);
            return Err(super::Error::ReconnectLimit);
        };
        if !delay.is_zero() {
            tokio::select! {
                _ = self.fault.wait() => return Err(super::Error::Network),
                () = tokio::time::sleep(delay) => {}
            }
            self.schedule
                .lock()
                .map_err(|_| super::Error::Network)?
                .attempts += 1;
        }
        Ok(())
    }

    pub(super) fn observe(&self, event: &mut Sse) {
        if let Ok(mut schedule) = self.schedule.lock() {
            schedule.observe(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Duration, Schedule, Sse};

    #[test]
    fn ten_consecutive_reopens_use_a_bounded_exponential_delay() {
        let mut schedule = Schedule::default();
        assert_eq!(schedule.delay(false), Some(Duration::ZERO));
        for (attempts, seconds) in [1, 2, 4, 8, 16, 32, 60, 60, 60, 60].into_iter().enumerate() {
            schedule.attempts = u32::try_from(attempts).unwrap_or(u32::MAX);
            assert_eq!(schedule.delay(false), Some(Duration::from_secs(seconds)));
        }
        schedule.attempts = 10;
        assert_eq!(schedule.delay(false), None);
    }

    #[test]
    fn only_a_received_message_resets_the_reconnect_count() {
        let mut schedule = Schedule {
            opened: true,
            attempts: 10,
            ..Schedule::default()
        };
        schedule.observe(&mut Sse {
            retry: Some(0),
            ..Sse::default()
        });
        assert_eq!(schedule.delay(true), None);
        schedule.observe(&mut Sse {
            event: Some("message".into()),
            data: Some(r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#.into()),
            ..Sse::default()
        });
        assert_eq!(schedule.delay(true), Some(Duration::from_secs(1)));
        schedule.observe(&mut Sse {
            retry: Some(u64::MAX),
            ..Sse::default()
        });
        assert_eq!(schedule.delay(true), Some(Duration::from_secs(60)));
    }
}
