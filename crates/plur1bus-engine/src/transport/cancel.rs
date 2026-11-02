//! Cancellation of ureq's active TCP socket, including the rustls handshake.
use super::{guarded::remaining_cancelled, TransportError};
use crate::contract::Cancel;
use socket2::{Domain, Protocol, Socket, Type};
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, LazyBuffers, NextTimeout, Transport,
};

const POLL: Duration = Duration::from_millis(10);

pub(super) struct IoControl {
    cancel: Cancel,
    deadline: Instant,
    socket: Mutex<Option<Socket>>,
}
impl IoControl {
    fn budget(&self) -> Result<Duration, TransportError> {
        remaining_cancelled(self.deadline, &self.cancel)
    }
    fn check_io(&self) -> Result<Duration, ureq::Error> {
        self.budget().map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "request ended").into()
        })
    }
    fn shutdown(&self) {
        if let Some(socket) = self
            .socket
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
}

/// The watchdog owns only a socket handle and cancellation state; Drop joins it.
pub(super) struct IoWatchdog {
    pub control: Arc<IoControl>,
    stop: mpsc::Sender<()>,
    thread: Option<JoinHandle<()>>,
}
impl IoWatchdog {
    pub fn new(cancel: &Cancel, deadline: Instant) -> Result<Self, TransportError> {
        remaining_cancelled(deadline, cancel)?;
        let control = Arc::new(IoControl {
            cancel: cancel.clone(),
            deadline,
            socket: Mutex::new(None),
        });
        Self::start(control)
    }

    fn start(control: Arc<IoControl>) -> Result<Self, TransportError> {
        let watched = control.clone();
        let (stop, receive) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("engine-http-cancel".into())
            .spawn(move || loop {
                let Ok(remaining) = watched.budget() else {
                    watched.shutdown();
                    break;
                };
                match receive.recv_timeout(remaining.min(POLL)) {
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            })
            .map_err(|_| TransportError::Network)?;
        Ok(Self {
            control,
            stop,
            thread: Some(thread),
        })
    }
}
impl Drop for IoWatchdog {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Opens only the address already checked by the gate and all-record DNS validation.
pub(super) struct CancelConnector {
    pub address: SocketAddr,
    pub control: Arc<IoControl>,
}
impl std::fmt::Debug for CancelConnector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CancelConnector")
    }
}
impl Connector<()> for CancelConnector {
    type Out = CancelTransport;
    fn connect(
        &self,
        details: &ConnectionDetails<'_>,
        _: Option<()>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        let socket = Socket::new(
            Domain::for_address(self.address),
            Type::STREAM,
            Some(Protocol::TCP),
        )?;
        socket.set_nonblocking(true)?;
        {
            let mut watched = self
                .control
                .socket
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            self.control.check_io()?;
            *watched = Some(socket.try_clone()?);
            // Register and initiate while holding the same lock used by the watchdog.
            // Cancellation cannot shut down a not-yet-started socket and then miss connect.
            if let Err(error) = socket.connect(&self.address.into()) {
                if !connect_pending(&error) {
                    return Err(error.into());
                }
            }
        }
        loop {
            let budget = self.control.check_io()?;
            if let Some(error) = socket.take_error()? {
                return Err(error.into());
            }
            if socket.peer_addr().is_ok() {
                break;
            }
            // Keep one pending TCP handshake alive, including on high-latency networks.
            // Socket handles are dropped on cancellation; no detached connect worker remains.
            std::thread::sleep(budget.min(POLL));
        }
        self.control.check_io()?;
        socket.set_nonblocking(false)?;
        socket.set_tcp_nodelay(details.config.no_delay())?;
        let stream: TcpStream = socket.into();
        Ok(Some(CancelTransport {
            stream,
            buffers: LazyBuffers::new(
                details.config.input_buffer_size(),
                details.config.output_buffer_size(),
            ),
            control: self.control.clone(),
        }))
    }
}

// ureq keeps TcpTransport private. This adapter supplies its public Transport I/O
// contract; all HTTP framing, response limits and TLS remain in ureq/rustls.
pub(super) struct CancelTransport {
    stream: TcpStream,
    buffers: LazyBuffers,
    control: Arc<IoControl>,
}
impl std::fmt::Debug for CancelTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Buffers can contain credentials; never delegate Debug to them.
        f.write_str("CancelTransport")
    }
}
impl CancelTransport {
    fn timeout(&self, timeout: NextTimeout) -> Result<Duration, ureq::Error> {
        let budget = self.control.check_io()?;
        Ok(timeout
            .not_zero()
            .map_or(budget, |value| budget.min(*value)))
    }
}
impl Transport for CancelTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }
    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        self.stream
            .set_write_timeout(Some(self.timeout(timeout)?))?;
        self.stream.write_all(&self.buffers.output()[..amount])?;
        self.control.check_io()?;
        Ok(())
    }
    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        self.stream.set_read_timeout(Some(self.timeout(timeout)?))?;
        let amount = self.stream.read(self.buffers.input_append_buf())?;
        self.control.check_io()?;
        self.buffers.input_appended(amount);
        Ok(amount > 0)
    }
    fn is_open(&mut self) -> bool {
        // Every guarded hop owns one connection; make reuse impossible.
        let _ = self.stream.shutdown(Shutdown::Both);
        false
    }
}

fn connect_pending(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::WouldBlock {
        return true;
    }
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::EINPROGRESS) {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use std::io::ErrorKind;
    use std::net::TcpListener;

    fn assert_deadline_closes_pending_socket(send_headers: bool) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut peer, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();

        // TCP, the complete POST and (for the body case) response headers are
        // established before arming the short deadline. Scheduler/DNS/connect
        // delays cannot consume the pending-I/O window under test.
        let request =
            b"POST /deadline HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\nbody";
        stream.write_all(request).unwrap();
        let mut received = vec![0; request.len()];
        peer.read_exact(&mut received).unwrap();
        assert_eq!(received, request);
        if send_headers {
            let response =
                b"HTTP/1.1 200 stub\r\nContent-Length: 1024\r\nConnection: close\r\n\r\nx";
            peer.write_all(response).unwrap();
            let mut received = vec![0; response.len()];
            stream.read_exact(&mut received).unwrap();
            assert_eq!(received, response);
        }

        // Only the watchdog may close this pending peer. Failure cleanup below
        // also shuts the registered socket down, so the observer cannot leak.
        peer.set_read_timeout(None).unwrap();
        let (ready, observe_ready) = mpsc::channel();
        let (closed, observe_closed) = mpsc::channel();
        let observer = std::thread::spawn(move || {
            ready.send(()).unwrap();
            let mut byte = [0];
            let result = match peer.read(&mut byte) {
                Ok(0) => Ok(()),
                Ok(_) => Err(ErrorKind::InvalidData),
                Err(error)
                    if matches!(
                        error.kind(),
                        ErrorKind::ConnectionReset
                            | ErrorKind::ConnectionAborted
                            | ErrorKind::BrokenPipe
                    ) =>
                {
                    Ok(())
                }
                Err(error) => Err(error.kind()),
            };
            closed.send((Instant::now(), result)).unwrap();
        });
        observe_ready.recv_timeout(Duration::from_secs(1)).unwrap();
        let registered = Socket::from(stream.try_clone().unwrap());

        let expires = Instant::now() + Duration::from_millis(150);
        let response_by = expires + Duration::from_millis(250);
        let control = Arc::new(IoControl {
            cancel: Cancel::never(),
            deadline: expires,
            socket: Mutex::new(Some(registered)),
        });
        let mut transport = CancelTransport {
            stream,
            buffers: LazyBuffers::new(4096, 4096),
            control: control.clone(),
        };
        let watchdog = IoWatchdog::start(control.clone()).unwrap();
        let result = transport.await_input(NextTimeout {
            after: ureq::unversioned::transport::time::Duration::NotHappening,
            reason: if send_headers {
                ureq::Timeout::RecvBody
            } else {
                ureq::Timeout::RecvResponse
            },
        });
        let returned_at = Instant::now();
        let expired = control.budget();
        let disconnected =
            observe_closed.recv_timeout(response_by.saturating_duration_since(Instant::now()));

        // Failure cleanup must not create the evidence asserted below: capture
        // the EOF result first, then close and join even if the watchdog failed.
        control.shutdown();
        drop(transport);
        drop(watchdog);
        observer.join().unwrap();
        assert!(result.is_err(), "pending I/O must end through the deadline");
        assert!(
            returned_at >= expires,
            "pending I/O ended before its deadline"
        );
        assert_eq!(expired, Err(TransportError::Timeout));
        assert!(
            returned_at <= response_by,
            "pending read exceeded deadline plus 250 ms"
        );
        let (closed_at, closed) = disconnected.unwrap();
        assert_eq!(closed, Ok(()), "the real peer must observe EOF/reset");
        assert!(
            closed_at <= response_by,
            "socket closure exceeded the same response bound"
        );
    }

    #[test]
    fn an_absolute_deadline_closes_a_socket_waiting_for_response_headers() {
        assert_deadline_closes_pending_socket(false);
    }

    #[test]
    fn an_absolute_deadline_closes_a_socket_waiting_for_the_response_body() {
        assert_deadline_closes_pending_socket(true);
    }
}
