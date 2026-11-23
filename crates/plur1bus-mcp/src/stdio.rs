//! Bounded JSON-RPC framing over host-owned child pipes.
use std::{
    fmt,
    future::Future,
    marker::PhantomData,
    sync::{Arc, OnceLock},
    time::Duration,
};

use rmcp::{
    service::{RxJsonRpcMessage, ServiceRole, TxJsonRpcMessage},
    transport::Transport,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::Mutex,
    time::{timeout_at, Instant},
};

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Closed,
    FrameLimit,
    InvalidFrame,
    Incomplete,
    Timeout,
    Read,
    Write,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Closed => "MCP stdio is closed",
            Self::FrameLimit => "MCP stdio frame exceeds byte limit",
            Self::InvalidFrame => "MCP stdio frame is malformed",
            Self::Incomplete => "MCP stdio closed during a frame",
            Self::Timeout => "MCP stdio frame deadline reached",
            Self::Read => "MCP stdio read failed",
            Self::Write => "MCP stdio write failed",
        })
    }
}

impl std::error::Error for Error {}

type Fault = Arc<OnceLock<Error>>;

pub struct Framed<Role, R, W> {
    read: BufReader<R>,
    write: Arc<Mutex<Option<W>>>,
    read_deadline: Option<Instant>,
    pending: Vec<u8>,
    limit: usize,
    timeout: Duration,
    failure: Fault,
    include_progress: bool,
    legacy_envelope: bool,
    _role: PhantomData<fn() -> Role>,
}

impl<Role, R, W> Framed<Role, R, W>
where
    Role: ServiceRole,
    R: AsyncRead + Send + Unpin,
    W: AsyncWrite + Send + Unpin + 'static,
{
    pub fn new(read: R, write: W, limit: usize, timeout: Duration) -> Result<Self, Error> {
        if limit == 0 {
            return Err(Error::FrameLimit);
        }
        if timeout.is_zero() || Instant::now().checked_add(timeout).is_none() {
            return Err(Error::Timeout);
        }
        Ok(Self {
            read: BufReader::new(read),
            write: Arc::new(Mutex::new(Some(write))),
            read_deadline: None,
            pending: Vec::new(),
            limit: limit.min(MAX_FRAME_BYTES),
            timeout,
            failure: Fault::default(),
            include_progress: true,
            legacy_envelope: false,
            _role: PhantomData,
        })
    }

    /// Emit the legacy TypeScript SDK's request envelope order on stdio.
    pub fn with_legacy_envelope(mut self) -> Self {
        self.legacy_envelope = true;
        self
    }

    pub(crate) fn passive(mut self) -> Self {
        self.include_progress = false;
        self
    }

    pub fn failure(&self) -> Option<Error> {
        self.failure.get().copied()
    }

    async fn frame(&mut self) -> Result<Option<RxJsonRpcMessage<Role>>, Error> {
        loop {
            let data = match self.read_deadline {
                Some(deadline) => timeout_at(deadline, self.read.fill_buf())
                    .await
                    .map_err(|_| Error::Timeout)?,
                None => self.read.fill_buf().await,
            }
            .map_err(|_| Error::Read)?;
            if data.is_empty() {
                return if self.pending.is_empty() {
                    Ok(None)
                } else {
                    Err(Error::Incomplete)
                };
            }
            let newline = data.iter().position(|byte| *byte == b'\n');
            let take = newline.unwrap_or(data.len());
            if take > self.limit - self.pending.len() {
                return Err(Error::FrameLimit);
            }
            self.pending.extend_from_slice(&data[..take]);
            let ended = newline.is_some();
            self.read.consume(take + usize::from(ended));
            if ended {
                let message =
                    serde_json::from_slice(&self.pending).map_err(|_| Error::InvalidFrame)?;
                self.pending.clear();
                self.read_deadline = None;
                return Ok(Some(message));
            }
            if self.read_deadline.is_none() {
                self.read_deadline = Instant::now().checked_add(self.timeout);
            }
        }
    }
}

impl<Role, R, W> Transport<Role> for Framed<Role, R, W>
where
    Role: ServiceRole,
    R: AsyncRead + Send + Unpin,
    W: AsyncWrite + Send + Unpin + 'static,
{
    type Error = Error;

    fn send(
        &mut self,
        message: TxJsonRpcMessage<Role>,
    ) -> impl Future<Output = Result<(), Error>> + Send + 'static {
        let write = Arc::clone(&self.write);
        let failure = Arc::clone(&self.failure);
        let limit = self.limit;
        let include_progress = self.include_progress;
        let legacy_envelope = self.legacy_envelope;
        let deadline = Instant::now().checked_add(self.timeout);
        async move {
            let deadline = deadline.ok_or(Error::Timeout)?;
            let mut bytes =
                crate::http::encode::message(&message, include_progress, legacy_envelope)
                    .map_err(|_| Error::InvalidFrame)?;
            if bytes.len() > limit {
                return Err(Error::FrameLimit);
            }
            bytes.push(b'\n');
            let result = timeout_at(deadline, async {
                let mut slot = write.lock().await;
                if failure.get().is_some() {
                    return Err(Error::Closed);
                }
                // A dropped send after taking the writer closes it. A partial
                // frame must never be followed by a new frame on the same pipe.
                let mut sink = slot.take().ok_or(Error::Closed)?;
                sink.write_all(&bytes).await.map_err(|_| Error::Write)?;
                *slot = Some(sink);
                Ok(())
            })
            .await
            .unwrap_or(Err(Error::Timeout));
            if let Err(error) = result {
                let _ = failure.set(error);
            }
            result
        }
    }

    async fn receive(&mut self) -> Option<RxJsonRpcMessage<Role>> {
        if self.failure.get().is_some() {
            return None;
        }
        match self.frame().await {
            Ok(Some(message)) => Some(message),
            Ok(None) => None,
            Err(error) => {
                let _ = self.failure.set(error);
                None
            }
        }
    }

    async fn close(&mut self) -> Result<(), Error> {
        let deadline = Instant::now()
            .checked_add(self.timeout)
            .ok_or(Error::Timeout)?;
        timeout_at(deadline, async {
            let mut slot = self.write.lock().await;
            if let Some(mut write) = slot.take() {
                write.shutdown().await.map_err(|_| Error::Write)?;
            }
            Ok(())
        })
        .await
        .unwrap_or(Err(Error::Timeout))
    }
}
