//! Bound incoming requests separately from completed replies waiting for the peer.
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
    id_bytes: usize,
    writing: HashMap<RequestId, usize>,
}

impl Outstanding {
    fn has_room(&self, bytes: usize) -> bool {
        self.replies.len() < MAX_REPLIES
            && self.bytes < MAX_FRAME_BYTES
            && bytes <= MAX_FRAME_BYTES - self.id_bytes
    }
}

fn id_bytes(id: &RequestId) -> usize {
    match id {
        RequestId::Number(_) => size_of::<i64>(),
        RequestId::String(s) => s.len(),
    }
}

struct WriteReservation {
    state: watch::Sender<Outstanding>,
    id: RequestId,
}

impl Drop for WriteReservation {
    fn drop(&mut self) {
        let id = &self.id;
        self.state.send_if_modified(|state| {
            let Some(bytes) = state.writing.remove(id) else {
                return false;
            };
            state.replies.remove(id);
            state.id_bytes -= id_bytes(id);
            state.bytes -= bytes;
            true
        });
    }
}

pub(crate) struct Bounded<Role: ServiceRole, T> {
    inner: T,
    outstanding: watch::Sender<Outstanding>,
    pending: Option<RxJsonRpcMessage<Role>>,
    honor_cancellation: bool,
    legacy_initialize: fn(&TxJsonRpcMessage<Role>) -> bool,
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
            honor_cancellation: false,
            legacy_initialize: |_| false,
            closing_budget,
            blocked_until: None,
            fault,
            max_frame: max_frame.min(MAX_FRAME_BYTES),
            is_ping,
        }
    }

    pub(crate) fn with_request_cancellation(mut self, enabled: bool) -> Self {
        self.honor_cancellation = enabled;
        self
    }

    async fn wait_for_room(&mut self, bytes: usize) -> Option<()> {
        let mut state = self.outstanding.subscribe();
        loop {
            if self.fault.current().is_some() {
                return None;
            }
            let waiting_only_for_writes = {
                let value = state.borrow_and_update();
                if value.has_room(bytes) {
                    self.blocked_until = None;
                    return Some(());
                }
                value.bytes >= MAX_FRAME_BYTES || value.writing.len() == value.replies.len()
            };
            if waiting_only_for_writes {
                let deadline = *self
                    .blocked_until
                    .get_or_insert_with(|| Instant::now() + self.closing_budget);
                if timeout_at(deadline, state.changed()).await.is_err() {
                    self.fault.trip(Cause::Backpressure);
                    return None;
                }
            } else {
                // User-facing callbacks may legitimately take longer than the writer deadline.
                self.blocked_until = None;
                state.changed().await.ok()?;
            }
        }
    }
}

impl<T> Bounded<rmcp::RoleClient, T> {
    /// Auto negotiation can fall back to legacy initialize on this same HTTP connection.
    pub(crate) fn detect_legacy_initialize(mut self) -> Self {
        self.legacy_initialize = |message| {
            matches!(message, JsonRpcMessage::Request(req)
            if matches!(req.request, rmcp::model::ClientRequest::InitializeRequest(_)))
        };
        self
    }
}

impl<Role: ServiceRole, T: Transport<Role>> Transport<Role> for Bounded<Role, T> {
    type Error = Error<T::Error>;

    fn send(
        &mut self,
        message: TxJsonRpcMessage<Role>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        self.honor_cancellation |= (self.legacy_initialize)(&message);
        let id = match &message {
            JsonRpcMessage::Response(reply) => Some(&reply.id),
            JsonRpcMessage::Error(reply) => reply.id.as_ref(),
            _ => None,
        }
        .cloned();
        let maximum = id
            .as_ref()
            .and_then(|id| self.outstanding.borrow().replies.get(id).copied());
        let encoded = maximum.map(|bytes| encoded_size(&message, bytes));
        let within_budget = !matches!(encoded, Some(None));
        let reservation = id.zip(encoded.flatten()).map(|(id, bytes)| {
            self.outstanding.send_modify(|state| {
                state.bytes += bytes;
                state.writing.insert(id.clone(), bytes);
            });
            WriteReservation {
                state: self.outstanding.clone(),
                id,
            }
        });
        let operation =
            (within_budget && self.fault.current().is_none()).then(|| self.inner.send(message));
        let fault = self.fault.clone();

        async move {
            let _reservation = reservation;
            let Some(operation) = operation else {
                fault.trip(Cause::Backpressure);
                return Err(Error::Backpressure);
            };
            tokio::select! {
                biased;
                _ = fault.wait() => Err(Error::Backpressure),
                result = operation => result.map_err(Error::Transport),
            }
        }
    }

    async fn receive(&mut self) -> Option<RxJsonRpcMessage<Role>> {
        if self.pending.is_none() {
            let writes_only = {
                let state = self.outstanding.borrow();
                state.replies.len() == state.writing.len()
            };
            if writes_only {
                self.wait_for_room(1).await?;
            }
            self.pending = self.inner.receive().await;
        }
        if self.honor_cancellation {
            if let Some(JsonRpcMessage::Notification(notification)) = &self.pending {
                if let Some(id) = Role::peer_cancelled_params(&notification.notification)
                    .and_then(|params| params.request_id.as_ref())
                {
                    self.outstanding.send_if_modified(|state| {
                        if state.writing.contains_key(id) {
                            return false;
                        }
                        if state.replies.remove(id).is_some() {
                            state.id_bytes -= id_bytes(id);
                            return true;
                        }
                        false
                    });
                }
            }
        }
        let Some(JsonRpcMessage::Request(request)) = self.pending.as_ref() else {
            return self.pending.take();
        };
        // Record a per-reply limit. The serialized response is charged at send time.
        let bytes = if (self.is_ping)(&request.request) {
            encoded_size(&request.id, self.max_frame)
                .unwrap_or(self.max_frame)
                .saturating_add(PING_ENVELOPE_BYTES)
                .min(self.max_frame)
        } else {
            self.max_frame
        };
        self.wait_for_room(id_bytes(&request.id)).await?;
        let Some(JsonRpcMessage::Request(request)) = self.pending.take() else {
            return None;
        };
        let mut admitted = false;
        self.outstanding.send_if_modified(|state| {
            if state.replies.contains_key(&request.id) {
                return false;
            }
            state.replies.insert(request.id.clone(), bytes);
            state.id_bytes += id_bytes(&request.id);
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

pub(crate) fn encoded_size(value: &impl Serialize, limit: usize) -> Option<usize> {
    let mut counter = Counter { count: 0, limit };
    serde_json::to_writer(&mut counter, value).ok()?;
    Some(counter.count)
}

#[cfg(test)]
mod tests {
    use super::{Outstanding, RequestId, MAX_FRAME_BYTES, MAX_REPLIES};

    use super::{Bounded, Fault, Future};
    use rmcp::{
        model::{ClientJsonRpcMessage, ServerJsonRpcMessage},
        transport::Transport,
        RoleServer,
    };
    use std::{collections::VecDeque, io, sync::Arc, task::Poll, time::Duration};
    use tokio::sync::Semaphore;

    struct MemoryTransport {
        incoming: VecDeque<ClientJsonRpcMessage>,
        write_slots: Arc<Semaphore>,
    }
    impl Transport<RoleServer> for MemoryTransport {
        type Error = io::Error;

        fn send(
            &mut self,
            _: ServerJsonRpcMessage,
        ) -> impl Future<Output = Result<(), io::Error>> + Send + 'static {
            let slots = self.write_slots.clone();
            async move {
                let _permit = slots.acquire_owned().await.map_err(io::Error::other)?;
                Ok(())
            }
        }
        async fn receive(&mut self) -> Option<ClientJsonRpcMessage> {
            self.incoming.pop_front()
        }
        async fn close(&mut self) -> Result<(), io::Error> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_reply_holds_its_reservation_until_the_write_completes(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let write_slots = Arc::new(Semaphore::new(0));
        let message = |id| {
            serde_json::from_value(serde_json::json!({
                "jsonrpc":"2.0","id":id,"method":"tools/list"
            }))
        };
        let memory = MemoryTransport {
            incoming: [message(1)?, message(2)?].into(),
            write_slots: write_slots.clone(),
        };
        let fault = Fault::new();
        let mut transport = Bounded::new(
            memory,
            MAX_FRAME_BYTES,
            Duration::from_secs(1),
            fault.clone(),
            |_| false,
        );
        assert!(transport.receive().await.is_some());
        let mut write = std::pin::pin!(transport.send(serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#,
        )?));
        assert!(matches!(futures::poll!(write.as_mut()), Poll::Pending));
        assert!(transport.receive().await.is_some());
        let bytes = transport.outstanding.borrow().bytes;
        assert!((1..128).contains(&bytes));
        assert_eq!(transport.outstanding.borrow().writing.len(), 1);
        write_slots.add_permits(1);
        write.await?;
        assert_eq!(transport.outstanding.borrow().bytes, 0);
        assert_eq!(transport.outstanding.borrow().replies.len(), 1);
        assert!(fault.current().is_none());
        Ok(())
    }

    fn memory_transport(
        ids: &[i64],
        frame_limit: usize,
    ) -> Result<Bounded<RoleServer, MemoryTransport>, serde_json::Error> {
        let incoming = ids
            .iter()
            .map(|id| {
                serde_json::from_value(serde_json::json!({
                    "jsonrpc":"2.0","id":id,"method":"ping"
                }))
            })
            .collect::<Result<VecDeque<_>, _>>()?;
        Ok(Bounded::new(
            MemoryTransport {
                incoming,
                write_slots: Arc::new(Semaphore::new(1)),
            },
            frame_limit,
            Duration::from_secs(1),
            Fault::new(),
            |_| true,
        ))
    }

    #[tokio::test]
    async fn duplicate_pending_ids_are_refused_but_a_completed_id_can_be_reused(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let response = || serde_json::from_str(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#);
        let mut transport = memory_transport(&[1, 1, 1], 1024)?;
        assert!(transport.receive().await.is_some());
        transport.send(response()?).await?;
        assert!(transport.receive().await.is_some());
        assert!(transport.receive().await.is_none());
        assert_eq!(transport.fault.current(), Some(super::Cause::Backpressure));
        Ok(())
    }

    #[tokio::test]
    async fn oversize_reply_is_refused_before_it_reaches_the_writer(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut transport = memory_transport(&[1], 24)?;
        assert!(transport.receive().await.is_some());
        let response = serde_json::from_str(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#)?;
        assert!(matches!(
            transport.send(response).await,
            Err(super::Error::Backpressure)
        ));
        Ok(())
    }

    #[tokio::test]
    async fn abandoned_sends_and_peer_cancel_release_only_the_owned_slot(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut transport = memory_transport(&[1, 1], 1024)?.with_request_cancellation(true);
        assert!(transport.receive().await.is_some());
        drop(transport.send(serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":1,"result":{}}"#,
        )?));
        assert!(transport.receive().await.is_some());
        transport.inner.incoming.push_back(serde_json::from_str(
            r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}"#,
        )?);
        assert!(transport.receive().await.is_some());
        assert!(transport.outstanding.borrow().replies.is_empty());
        assert_eq!(transport.outstanding.borrow().bytes, 0);
        Ok(())
    }

    #[tokio::test]
    async fn pending_host_work_does_not_start_the_write_deadline(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let ids: Vec<_> = (1..=65).collect();
        let mut transport = memory_transport(&ids, MAX_FRAME_BYTES)?;
        transport.is_ping = |_| false;
        transport.closing_budget = Duration::from_millis(20);
        for _ in 0..64 {
            assert!(
                tokio::time::timeout(Duration::from_secs(1), transport.receive())
                    .await?
                    .is_some()
            );
        }
        assert_eq!(transport.outstanding.borrow().bytes, 0);
        assert!(
            tokio::time::timeout(Duration::from_millis(80), transport.receive())
                .await
                .is_err()
        );
        assert!(transport.fault.current().is_none());
        transport
            .send(serde_json::from_str(
                r#"{"jsonrpc":"2.0","id":1,"result":{}}"#,
            )?)
            .await?;
        assert!(transport.receive().await.is_some());
        Ok(())
    }

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
            ..Outstanding::default()
        };
        assert!(!full.has_room(1));
        assert!(Outstanding::default().has_room(MAX_FRAME_BYTES));
        assert!(!Outstanding::default().has_room(MAX_FRAME_BYTES + 1));
    }
}
