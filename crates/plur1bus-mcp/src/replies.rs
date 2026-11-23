//! Reserve room before handing a request to the SDK, which spawns its handler.
use std::{collections::HashMap, fmt, future::Future, io, time::Duration};

use rmcp::{
    model::{JsonRpcMessage, RequestId},
    service::{RxJsonRpcMessage, ServiceRole, TxJsonRpcMessage},
    transport::Transport,
};
use serde::Serialize;
use tokio::{
    sync::watch,
    time::{timeout_at, Instant},
};

use crate::{
    connection_fault::{Cause, Fault},
    stdio::MAX_FRAME_BYTES,
};

const MAX_REPLIES: usize = 64;
const PING_ENVELOPE_BYTES: usize = 256;

#[derive(Debug)]
pub(crate) enum Error<E> {
    Transport(E),
    Backpressure,
}

impl<E: fmt::Display> fmt::Display for Error<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(error) => error.fmt(f),
            Self::Backpressure => f.write_str("MCP reply budget exhausted"),
        }
    }
}

impl<E: std::error::Error + 'static> std::error::Error for Error<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Transport(error) => Some(error),
            Self::Backpressure => None,
        }
    }
}

#[derive(Default)]
struct Outstanding {
    replies: HashMap<RequestId, usize>,
    bytes: usize,
}

impl Outstanding {
    fn has_room(&self, bytes: usize) -> bool {
        self.replies.len() < MAX_REPLIES && bytes <= MAX_FRAME_BYTES - self.bytes
    }
}

pub(crate) struct Bounded<Role: ServiceRole, T> {
    inner: T,
    outstanding: watch::Sender<Outstanding>,
    pending: Option<RxJsonRpcMessage<Role>>,
    closing_budget: Duration,
    blocked_until: Option<Instant>,
    fault: Fault,
    max_frame: usize,
    is_ping: fn(&Role::PeerReq) -> bool,
}

impl<Role: ServiceRole, T> Bounded<Role, T> {
    pub(crate) fn new(
        inner: T,
        max_frame: usize,
        closing_budget: Duration,
        fault: Fault,
        is_ping: fn(&Role::PeerReq) -> bool,
    ) -> Self {
        Self {
            inner,
            outstanding: watch::channel(Outstanding::default()).0,
            pending: None,
            closing_budget,
            blocked_until: None,
            fault,
            max_frame: max_frame.min(MAX_FRAME_BYTES),
            is_ping,
        }
    }

    async fn wait_for_room(&mut self, bytes: usize) -> Option<()> {
        if self.fault.current().is_some() {
            return None;
        }
        let mut state = self.outstanding.subscribe();
        if state.borrow().has_room(bytes) {
            self.blocked_until = None;
            return Some(());
        }
        let deadline = *self
            .blocked_until
            .get_or_insert_with(|| Instant::now() + self.closing_budget);
        if timeout_at(deadline, state.wait_for(|state| state.has_room(bytes)))
            .await
            .is_err()
        {
            self.fault.trip(Cause::Backpressure);
            return None;
        }
        self.blocked_until = None;
        Some(())
    }
}

impl<Role: ServiceRole, T: Transport<Role>> Transport<Role> for Bounded<Role, T> {
    type Error = Error<T::Error>;

    fn send(
        &mut self,
        message: TxJsonRpcMessage<Role>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let id = match &message {
            JsonRpcMessage::Response(reply) => Some(&reply.id),
            JsonRpcMessage::Error(reply) => reply.id.as_ref(),
            _ => None,
        }
        .cloned();
        let maximum = id
            .as_ref()
            .and_then(|id| self.outstanding.borrow().replies.get(id).copied());
        let within_budget = maximum.is_none_or(|bytes| encoded_size(&message, bytes).is_some());
        let operation =
            (within_budget && self.fault.current().is_none()).then(|| self.inner.send(message));
        let outstanding = self.outstanding.clone();
        let fault = self.fault.clone();

        async move {
            let Some(operation) = operation else {
                fault.trip(Cause::Backpressure);
                return Err(Error::Backpressure);
            };
            let result = tokio::select! {
                biased;
                _ = fault.wait() => Err(Error::Backpressure),
                result = operation => result.map_err(Error::Transport),
            };
            if let Some(id) = id {
                outstanding.send_if_modified(|state| {
                    let Some(bytes) = state.replies.remove(&id) else {
                        return false;
                    };
                    state.bytes -= bytes;
                    true
                });
            }
            result
        }
    }

    async fn receive(&mut self) -> Option<RxJsonRpcMessage<Role>> {
        if self.pending.is_none() {
            self.wait_for_room(1).await?;
            self.pending = self.inner.receive().await;
        }
        let Some(JsonRpcMessage::Request(request)) = self.pending.as_ref() else {
            return self.pending.take();
        };
        // The ordinary handler can return any valid frame. A ping returns a
        // fixed envelope plus the echoed ID, so it needs a much smaller slot.
        let bytes = if (self.is_ping)(&request.request) {
            encoded_size(&request.id, self.max_frame)
                .unwrap_or(self.max_frame)
                .saturating_add(PING_ENVELOPE_BYTES)
                .min(self.max_frame)
        } else {
            self.max_frame
        };
        self.wait_for_room(bytes).await?;
        let Some(JsonRpcMessage::Request(request)) = self.pending.take() else {
            return None;
        };
        let mut admitted = false;
        self.outstanding.send_if_modified(|state| {
            if state.replies.contains_key(&request.id) {
                return false;
            }
            state.replies.insert(request.id.clone(), bytes);
            state.bytes += bytes;
            admitted = true;
            true
        });
        if !admitted {
            self.fault.trip(Cause::Backpressure);
            return None;
        }
        Some(JsonRpcMessage::Request(request))
    }

    async fn close(&mut self) -> Result<(), Self::Error> {
        self.inner.close().await.map_err(Error::Transport)
    }
}

struct Counter {
    count: usize,
    limit: usize,
}

impl io::Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit - self.count {
            return Err(io::Error::other("MCP reply exceeds reservation"));
        }
        self.count += bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn encoded_size(value: &impl Serialize, limit: usize) -> Option<usize> {
    let mut counter = Counter { count: 0, limit };
    serde_json::to_writer(&mut counter, value).ok()?;
    Some(counter.count)
}

#[cfg(test)]
mod tests {
    use super::{Outstanding, RequestId, MAX_FRAME_BYTES, MAX_REPLIES};

    #[test]
    fn reservations_are_bounded_independently_by_count_and_bytes() {
        let full = Outstanding {
            bytes: MAX_FRAME_BYTES,
            ..Outstanding::default()
        };
        assert!(!full.has_room(1));
        let full = Outstanding {
            replies: (0..MAX_REPLIES)
                .filter_map(|id| i64::try_from(id).ok())
                .map(|id| (RequestId::Number(id), 1))
                .collect(),
            bytes: MAX_REPLIES,
        };
        assert!(!full.has_room(1));
        assert!(Outstanding::default().has_room(MAX_FRAME_BYTES));
        assert!(!Outstanding::default().has_room(MAX_FRAME_BYTES + 1));
    }
}
