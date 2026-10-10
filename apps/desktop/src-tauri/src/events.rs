//! Native authenticated status subscription. Foreign event bodies never reach logs or IPC.
use crate::{
    client::{ClientError, HarnessClient},
    secrets::SecretString,
    tray::{map_status, HarnessState},
};
use std::{future::Future, time::Duration};
use tokio::sync::watch;

type ApprovalSink = std::sync::Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

const MAX_FRAME: usize = 64 * 1024;
/// A terminal result of native authenticated HTTP, never inferred from foreign SSE data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionFailure {
    Revoked,
    Unauthorized,
    InstallationMismatch,
}
impl SessionFailure {
    pub fn client_error(self) -> ClientError {
        match self {
            Self::Revoked => ClientError::Revoked,
            Self::Unauthorized => ClientError::Unauthorized,
            Self::InstallationMismatch => ClientError::InstallationMismatch,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EventUpdate {
    pub state: HarnessState,
    pub secrets_locked: bool,
    pub connected: bool,
    pub failure: Option<SessionFailure>,
}
#[derive(Default)]
pub struct EventStream {
    approval_sink: Option<ApprovalSink>,
    last_id: Option<String>,
    failures: u32,
    last_state: Option<EventUpdate>,
}
impl EventStream {
    pub fn approval_sink(&mut self, sink: ApprovalSink) {
        self.approval_sink = Some(sink);
    }
    pub fn last_event_id(&self) -> Option<&str> {
        self.last_id.as_deref()
    }
    pub fn reset_backoff(&mut self) {
        self.failures = 0;
    }
    pub fn next_delay(&mut self, sample: f64) -> Duration {
        let seconds = (1u32 << self.failures.min(5)).min(30);
        self.failures = self.failures.saturating_add(1);
        let sample = if sample.is_finite() {
            sample.clamp(0.0, 1.0)
        } else {
            0.5
        };
        Duration::from_secs_f64(seconds as f64 * (0.8 + 0.4 * sample))
    }
    pub fn frame(&mut self, bytes: &[u8]) -> Result<Option<EventUpdate>, ClientError> {
        if bytes.len() > MAX_FRAME {
            return Err(ClientError::Protocol);
        }
        let text = std::str::from_utf8(bytes).map_err(|_| ClientError::Protocol)?;
        let mut event = "";
        let mut id = None;
        let mut data = Vec::new();
        for line in text.lines() {
            if let Some(value) = line.strip_prefix("event:") {
                event = value.trim_start();
            }
            if let Some(value) = line.strip_prefix("id:") {
                let value = value.strip_prefix(' ').unwrap_or(value);
                if value.len() > 256 || !value.bytes().all(|b| (32..127).contains(&b)) {
                    return Err(ClientError::Protocol);
                }
                id = Some(value);
            }
            if let Some(value) = line.strip_prefix("data:") {
                data.push(value.strip_prefix(' ').unwrap_or(value));
            }
        }
        if matches!(event, "approval.requested" | "approval.resolved") && !data.is_empty() {
            let value =
                serde_json::from_str(&data.join("\n")).map_err(|_| ClientError::Protocol)?;
            if let Some(sink) = &self.approval_sink {
                sink(event, value);
            }
            if let Some(id) = id {
                self.last_id = (!id.is_empty()).then(|| id.into());
            }
            return Ok(None);
        }
        if event != "harness.status" || data.is_empty() {
            return Ok(None);
        }
        let value = serde_json::from_str(&data.join("\n")).map_err(|_| ClientError::Protocol)?;
        let update = EventUpdate {
            state: map_status(&value),
            secrets_locked: value.get("secrets").and_then(serde_json::Value::as_str)
                == Some("locked"),
            connected: true,
            failure: None,
        };
        // Invalid data cannot advance the replay cursor.
        if let Some(id) = id {
            self.last_id = (!id.is_empty()).then(|| id.into());
        }
        self.last_state = Some(update);
        self.reset_backoff();
        Ok(Some(update))
    }
    pub async fn run(
        &mut self,
        client: &HarnessClient,
        installation: &str,
        token: &SecretString,
        stop: watch::Receiver<bool>,
        emit: impl FnMut(EventUpdate),
    ) {
        self.run_with_timing(
            client,
            installation,
            token,
            stop,
            emit,
            rand::random::<f64>,
            |delay| async move {
                tokio::time::sleep(delay).await;
            },
        )
        .await;
    }
    pub async fn run_async<E: Future<Output = ()>>(
        &mut self,
        client: &HarnessClient,
        installation: &str,
        token: &SecretString,
        stop: watch::Receiver<bool>,
        emit: impl FnMut(EventUpdate) -> E,
    ) {
        self.run_with_timing_async(
            client,
            installation,
            token,
            stop,
            emit,
            rand::random::<f64>,
            |delay| async move {
                tokio::time::sleep(delay).await;
            },
        )
        .await;
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn run_with_timing<F, Fut>(
        &mut self,
        client: &HarnessClient,
        installation: &str,
        token: &SecretString,
        stop: watch::Receiver<bool>,
        mut emit: impl FnMut(EventUpdate),
        jitter: impl FnMut() -> f64,
        wait: F,
    ) where
        F: FnMut(Duration) -> Fut,
        Fut: Future<Output = ()>,
    {
        self.run_with_timing_async(
            client,
            installation,
            token,
            stop,
            |value| {
                emit(value);
                std::future::ready(())
            },
            jitter,
            wait,
        )
        .await;
    }
    #[allow(clippy::too_many_arguments)]
    /// Deterministic timing seam; the client, HTTP stream, frame parser and cancellation are production code.
    pub async fn run_with_timing_async<F, Fut, E>(
        &mut self,
        client: &HarnessClient,
        installation: &str,
        token: &SecretString,
        mut stop: watch::Receiver<bool>,
        mut emit: impl FnMut(EventUpdate) -> E,
        mut jitter: impl FnMut() -> f64,
        mut wait: F,
    ) where
        F: FnMut(Duration) -> Fut,
        Fut: Future<Output = ()>,
        E: Future<Output = ()>,
    {
        while !*stop.borrow() {
            let result = self
                .consume(client, installation, token, &mut stop, &mut emit)
                .await;
            if *stop.borrow() || stop.has_changed().is_err() {
                return;
            }
            let failure = match result {
                Err(ClientError::Revoked) => Some(SessionFailure::Revoked),
                Err(ClientError::Unauthorized) => Some(SessionFailure::Unauthorized),
                Err(ClientError::InstallationMismatch) => {
                    Some(SessionFailure::InstallationMismatch)
                }
                _ => None,
            };
            if let Some(failure) = failure {
                if !publish(
                    &mut stop,
                    emit(EventUpdate {
                        state: HarnessState::Unpaired,
                        secrets_locked: false,
                        connected: false,
                        failure: Some(failure),
                    }),
                )
                .await
                {
                    return;
                }
                return;
            }
            if !publish(
                &mut stop,
                emit(EventUpdate {
                    state: HarnessState::Down,
                    secrets_locked: false,
                    connected: false,
                    failure: None,
                }),
            )
            .await
            {
                return;
            }
            let delay = self.next_delay(jitter());
            tokio::select! { _ = wait(delay) => {}, _ = stop.changed() => {} }
        }
    }
    async fn consume<E: Future<Output = ()>>(
        &mut self,
        client: &HarnessClient,
        installation: &str,
        token: &SecretString,
        stop: &mut watch::Receiver<bool>,
        emit: &mut impl FnMut(EventUpdate) -> E,
    ) -> Result<(), ClientError> {
        let mut response = tokio::select! {
            response = client.status_events(installation, token, self.last_id.as_deref()) => response?,
            _ = stop.changed() => return Ok(()),
        };
        if !publish(
            stop,
            emit(self.last_state.unwrap_or(EventUpdate {
                state: HarnessState::Starting,
                secrets_locked: false,
                connected: true,
                failure: None,
            })),
        )
        .await
        {
            return Ok(());
        }
        let mut buffer = Vec::new();
        loop {
            let chunk = tokio::select! {
                chunk = response.chunk() => chunk.map_err(|_| ClientError::Network)?,
                _ = stop.changed() => return Ok(()),
            };
            let Some(chunk) = chunk else {
                return Err(ClientError::Network);
            };
            if buffer.len() + chunk.len() > MAX_FRAME {
                return Err(ClientError::Protocol);
            }
            buffer.extend_from_slice(&chunk);
            loop {
                let lf = buffer.windows(2).position(|p| p == b"\n\n").map(|n| (n, 2));
                let crlf = buffer
                    .windows(4)
                    .position(|p| p == b"\r\n\r\n")
                    .map(|n| (n, 4));
                let Some((end, separator)) = lf.into_iter().chain(crlf).min_by_key(|(n, _)| *n)
                else {
                    break;
                };
                if let Some(update) = self.frame(&buffer[..end])? {
                    if !publish(stop, emit(update)).await {
                        return Ok(());
                    }
                }
                buffer.drain(..end + separator);
            }
        }
    }
}

/// Stop remains responsive even while an observer waits for bounded queue capacity.
async fn publish(stop: &mut watch::Receiver<bool>, emit: impl Future<Output = ()>) -> bool {
    tokio::select! { _ = stop.changed() => false, _ = emit => true }
}
#[cfg(test)]
mod observer_tests {
    use super::*;
    #[tokio::test]
    async fn stop_interrupts_a_backpressured_observer() {
        let (stop, mut receiver) = watch::channel(false);
        let task =
            tokio::spawn(async move { publish(&mut receiver, std::future::pending()).await });
        stop.send(true).unwrap();
        assert!(!tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap());
    }
}
