#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
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
