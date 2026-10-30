#![allow(dead_code)]

use std::io::{ErrorKind, Read, Write};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub struct Stub {
    pub port: u16,
    pub requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
#[derive(Clone, Copy)]
enum Delay {
    Response,
    Body,
}

impl Stub {
    pub fn new(status: u16, headers: &str, body: &str, delay: Duration) -> Self {
        let headers = headers.to_owned();
        let body = body.to_owned();
        Self::dynamic(move |_| (status, headers.clone(), body.clone(), delay))
    }

    pub fn dynamic(
        handler: impl Fn(&str) -> (u16, String, String, Duration) + Send + 'static,
    ) -> Self {
        Self::start(handler, Delay::Response)
    }

    pub fn dynamic_body(
        handler: impl Fn(&str) -> (u16, String, String, Duration) + Send + 'static,
    ) -> Self {
        Self::start(handler, Delay::Body)
    }

    fn start(
        handler: impl Fn(&str) -> (u16, String, String, Duration) + Send + 'static,
        delay_at: Delay,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let thread = thread::spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                };
                // Windows and macOS hand the listener's nonblocking mode to an accepted socket; the reads below block.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 4096];
                loop {
                    let count = match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    request.extend_from_slice(&buffer[..count]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&request[..end]);
                        let content_length = head
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().ok())
                                    .flatten()
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + content_length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8_lossy(&request).into_owned();
                let (status, headers, body, delay) = handler(&request);
                let length = if headers.lines().any(|line| {
                    line.split_once(':')
                        .is_some_and(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                }) {
                    String::new()
                } else {
                    format!("Content-Length: {}\r\n", body.len())
                };
                let response = format!(
                    "HTTP/1.1 {status} stub\r\n{length}Connection: close\r\n{headers}\r\n{body}"
                );
                observed.lock().unwrap().push(request);
                match delay_at {
                    Delay::Response => {
                        thread::sleep(delay);
                        let _ = stream.write_all(response.as_bytes());
                    }
                    Delay::Body => {
                        let end = response.find("\r\n\r\n").unwrap() + 4;
                        let _ = stream.write_all(&response.as_bytes()[..end]);
                        thread::sleep(delay);
                        let _ = stream.write_all(&response.as_bytes()[end..]);
                    }
                }
            }
        });
        Self {
            port,
            requests,
            stop,
            thread: Some(thread),
        }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://provider.test:{}{path}", self.port)
    }
}

impl Drop for Stub {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}

/// A peer which leaves either the response headers or body pending and observes
/// the client closing the actual TCP connection.
pub struct StalledPeer {
    pub stub: Stub,
    pub ready: mpsc::Receiver<()>,
    pub closed: mpsc::Receiver<Result<(), ErrorKind>>,
}

impl StalledPeer {
    pub fn new(send_headers: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let (ready, receive_ready) = mpsc::channel();
        let (closed, receive_closed) = mpsc::channel();
        let thread = thread::spawn(move || {
            let mut stream = loop {
                if stopped.load(Ordering::Acquire) {
                    return;
                }
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(_) => return,
                }
            };
            // Windows and macOS hand the listener's nonblocking mode to an accepted socket; reads wait up to 10 ms.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_millis(10)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                if stopped.load(Ordering::Acquire) {
                    return;
                }
                match stream.read(&mut buffer) {
                    Ok(0) => return,
                    Ok(count) => request.extend_from_slice(&buffer[..count]),
                    Err(error)
                        if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                    {
                        continue;
                    }
                    Err(_) => return,
                }
                if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&request[..end]);
                    let content_length = head
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + content_length {
                        break;
                    }
                }
            }
            observed
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(&request).into_owned());
            if send_headers {
                stream
                    .write_all(
                        b"HTTP/1.1 200 stub\r\nContent-Length: 1024\r\nConnection: close\r\n\r\nx",
                    )
                    .unwrap();
            }
            let _ = ready.send(());
            loop {
                if stopped.load(Ordering::Acquire) {
                    return;
                }
                match stream.read(&mut buffer) {
                    Ok(0) => {
                        let _ = closed.send(Ok(()));
                        return;
                    }
                    Ok(_) => {}
                    Err(error)
                        if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                    Err(error) => {
                        let kind = error.kind();
                        let result = if matches!(
                            kind,
                            ErrorKind::ConnectionReset
                                | ErrorKind::ConnectionAborted
                                | ErrorKind::BrokenPipe
                        ) {
                            Ok(())
                        } else {
                            Err(kind)
                        };
                        let _ = closed.send(result);
                        return;
                    }
                }
            }
        });
        Self {
            stub: Stub {
                port,
                requests,
                stop,
                thread: Some(thread),
            },
            ready: receive_ready,
            closed: receive_closed,
        }
    }
}
