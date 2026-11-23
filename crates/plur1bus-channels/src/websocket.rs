//! Blocking WebSocket handshake and framing over a host-authorized stream.
use crate::stream::DeadlineStream;
pub use crate::stream::TimedStream;
use std::fmt;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;
use tungstenite::handshake::HandshakeError;
use tungstenite::http::{HeaderName, HeaderValue};
use tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tungstenite::{Message, WebSocket};
use url::{Host, Url};

const MAX_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_MESSAGE: usize = 32 * 1024 * 1024;

pub trait SocketPorts {
    fn cancelled(&self) -> bool {
        false
    }

    fn pin(&self, endpoint: &Url, deadline: Instant) -> Option<SocketAddr>;

    /// Connect only to the pin. Complete and verify TLS for the original hostname before
    /// returning a stream for a WSS endpoint. All underlying operations share the deadline.
    fn dial(
        &self,
        endpoint: &Url,
        pin: SocketAddr,
        deadline: Instant,
    ) -> io::Result<Box<dyn TimedStream>>;
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub message_bytes: usize,
    pub frame_bytes: usize,
    pub handshake: Duration,
    pub read: Duration,
    pub write: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            message_bytes: 4 * 1024 * 1024,
            frame_bytes: 4 * 1024 * 1024,
            handshake: Duration::from_secs(20),
            read: Duration::from_secs(30),
            write: Duration::from_secs(30),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Denied,
    Timeout,
    Capacity,
    Protocol,
    Network,
    Closed,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Denied => "websocket destination denied",
            Self::Timeout => "websocket deadline elapsed",
            Self::Capacity => "websocket size limit exceeded",
            Self::Protocol => "websocket protocol error",
            Self::Network => "websocket I/O failed",
            Self::Closed => "websocket closed",
        })
    }
}

impl std::error::Error for Error {}

pub enum Peer {
    Text(String),
    Binary(Vec<u8>),
    Ping,
    Pong,
    Closed(Option<u16>),
}

/// Credential headers for the two voice providers without Bearer authentication.
#[derive(Clone, Copy)]
pub enum VoiceKey<'a> {
    ElevenLabs(&'a str),
    Gemini(&'a str),
}

pub struct Socket {
    ws: WebSocket<DeadlineStream>,
    limits: Limits,
}

impl Socket {
    /// Hosts register through the shared wire log boundary (R-W-11), which rejects
    /// dependency DEBUG records containing peer close reasons.
    pub fn connect(
        url: &Url,
        headers: &[(&str, &str)],
        ports: &dyn SocketPorts,
        limits: Limits,
        insecure_loopback: bool,
    ) -> Result<Self, Error> {
        Self::connect_with_headers(url, headers, ports, limits, insecure_loopback, None)
    }

    /// Allow one of the voice vendors' API-key headers at the TLS handshake.
    pub fn connect_with_voice_key(
        url: &Url,
        key: VoiceKey<'_>,
        ports: &dyn SocketPorts,
        limits: Limits,
        insecure_loopback: bool,
    ) -> Result<Self, Error> {
        let (name, value) = match key {
            VoiceKey::ElevenLabs(value) => ("xi-api-key", value),
            VoiceKey::Gemini(value) => ("x-goog-api-key", value),
        };
        Self::connect_with_headers(
            url,
            &[(name, value)],
            ports,
            limits,
            insecure_loopback,
            Some(name),
        )
    }

    fn connect_with_headers(
        url: &Url,
        headers: &[(&str, &str)],
        ports: &dyn SocketPorts,
        limits: Limits,
        insecure_loopback: bool,
        voice_header: Option<&str>,
    ) -> Result<Self, Error> {
        let plaintext = url.scheme() == "ws" && insecure_loopback;
        if (url.scheme() != "wss" && !plaintext)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::Denied);
        }
        let host = url.host().ok_or(Error::Denied)?;
        let literal = match host {
            Host::Ipv4(ip) => Some(IpAddr::V4(ip)),
            Host::Ipv6(ip) => Some(IpAddr::V6(ip)),
            Host::Domain(_) => None,
        };
        if limits.message_bytes == 0
            || limits.message_bytes > MAX_MESSAGE
            || limits.frame_bytes == 0
            || limits.frame_bytes > MAX_MESSAGE
            || limits.read.is_zero()
            || limits.write.is_zero()
            || limits.handshake.is_zero()
        {
            return Err(Error::Capacity);
        }
        let deadline = Instant::now() + limits.handshake.min(MAX_TIMEOUT);
        let pin = ports.pin(url, deadline).ok_or(Error::Denied)?;
        if Some(pin.port()) != url.port_or_known_default()
            || literal.is_some_and(|ip| ip != pin.ip())
            || (plaintext && !pin.ip().is_loopback())
        {
            return Err(Error::Denied);
        }
        if Instant::now() >= deadline {
            return Err(Error::Timeout);
        }
        let mut request = url.as_str().into_client_request().map_err(classify)?;
        for (name, value) in headers {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| Error::Protocol)?;
            if !matches!(name.as_str(), "authorization" | "sec-websocket-protocol")
                && Some(name.as_str()) != voice_header
            {
                return Err(Error::Protocol);
            }
            let mut value = HeaderValue::from_str(value).map_err(|_| Error::Protocol)?;
            value.set_sensitive(true);
            request.headers_mut().insert(name, value);
        }
        let io = ports
            .dial(url, pin, deadline)
            .map_err(|error| classify_io(error.kind()))?;
        if io.peer_addr().map_err(|error| classify_io(error.kind()))? != pin {
            return Err(Error::Denied);
        }
        let config = WebSocketConfig::default()
            .read_buffer_size(8 * 1024)
            .write_buffer_size(0)
            .max_write_buffer_size(limits.message_bytes + 1024)
            .max_frame_size(Some(limits.frame_bytes))
            .max_message_size(Some(limits.message_bytes));
        let stream = DeadlineStream { io, deadline };
        let (ws, _) = tungstenite::client::client_with_config(request, stream, Some(config))
            .map_err(|e| match e {
                HandshakeError::Interrupted(_) => Error::Timeout,
                HandshakeError::Failure(error) => classify(error),
            })?;
        Ok(Self { ws, limits })
    }

    pub fn receive(&mut self, budget: Duration) -> Result<Peer, Error> {
        self.receive_until(Instant::now() + budget.min(MAX_TIMEOUT))
    }

    pub fn receive_until(&mut self, deadline: Instant) -> Result<Peer, Error> {
        self.ws.get_mut().deadline =
            deadline.min(Instant::now() + self.limits.read.min(MAX_TIMEOUT));
        let message = self.ws.read().map_err(classify)?;
        match message {
            Message::Text(text) => Ok(Peer::Text(text.to_string())),
            Message::Binary(bytes) => Ok(Peer::Binary(bytes.to_vec())),
            Message::Ping(_) => {
                self.ws.flush().map_err(classify)?;
                Ok(Peer::Ping)
            }
            Message::Pong(_) => Ok(Peer::Pong),
            Message::Close(frame) => {
                match self.ws.flush().map_err(classify) {
                    Ok(()) | Err(Error::Closed) => {}
                    Err(error) => return Err(error),
                }
                Ok(Peer::Closed(frame.map(|frame| frame.code.into())))
            }
            Message::Frame(_) => Err(Error::Protocol),
        }
    }

    pub fn send_text(&mut self, text: &str) -> Result<(), Error> {
        self.send_text_until(text, Instant::now() + self.limits.write.min(MAX_TIMEOUT))
    }

    pub fn send_text_until(&mut self, text: &str, deadline: Instant) -> Result<(), Error> {
        if text.len() > self.limits.message_bytes.min(self.limits.frame_bytes) {
            return Err(Error::Capacity);
        }
        self.ws.get_mut().deadline =
            deadline.min(Instant::now() + self.limits.write.min(MAX_TIMEOUT));
        self.ws.send(Message::Text(text.into())).map_err(classify)
    }

    pub fn send_binary(&mut self, bytes: &[u8]) -> Result<(), Error> {
        if bytes.len() > self.limits.message_bytes.min(self.limits.frame_bytes) {
            return Err(Error::Capacity);
        }
        self.ws.get_mut().deadline = Instant::now() + self.limits.write.min(MAX_TIMEOUT);
        self.ws
            .send(Message::Binary(bytes.to_vec().into()))
            .map_err(classify)
    }

    pub fn close(&mut self, code: u16, reason: &str) -> Result<(), Error> {
        self.close_until(
            code,
            reason,
            Instant::now() + self.limits.write.min(MAX_TIMEOUT),
        )
    }

    pub fn close_until(&mut self, code: u16, reason: &str, deadline: Instant) -> Result<(), Error> {
        if reason.len() > 123 {
            return Err(Error::Capacity);
        }
        self.ws.get_mut().deadline =
            deadline.min(Instant::now() + self.limits.write.min(MAX_TIMEOUT));
        self.ws
            .close(Some(CloseFrame {
                code: code.into(),
                reason: reason.into(),
            }))
            .map_err(classify)
    }
}

fn classify(error: tungstenite::Error) -> Error {
    match error {
        tungstenite::Error::Capacity(_) | tungstenite::Error::WriteBufferFull(_) => Error::Capacity,
        tungstenite::Error::AlreadyClosed | tungstenite::Error::ConnectionClosed => Error::Closed,
        tungstenite::Error::Io(error) => classify_io(error.kind()),
        tungstenite::Error::Tls(_) => Error::Network,
        _ => Error::Protocol,
    }
}

fn classify_io(kind: io::ErrorKind) -> Error {
    match kind {
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => Error::Timeout,
        _ => Error::Network,
    }
}
