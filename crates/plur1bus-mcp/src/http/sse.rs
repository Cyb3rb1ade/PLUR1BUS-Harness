use std::{io::Read, time::Instant};

use futures::stream;
use sse_stream::{Error as SseError, Sse};
use tokio::{sync::mpsc, task::spawn_blocking};

use super::{io_error, remaining, Error, SseStream};

pub(super) fn stream(mut body: ureq::Body, deadline: Instant, limit: usize) -> SseStream {
    let (send, recv) = mpsc::channel(2);
    spawn_blocking(move || {
        let mut input = body.as_reader();
        let mut buffer = [0; 8192];
        let mut parser = Parser::new(limit);
        let deliver = |event| send.blocking_send(Ok(event)).is_ok();
        let outcome: Result<(), Error> = (|| {
            while !send.is_closed() {
                remaining(deadline)?;
                let result = input.read(&mut buffer);
                remaining(deadline)?;
                let bytes = result.map_err(|error| io_error(&error))?;
                if bytes == 0 {
                    if parser.cr {
                        parser.end_line(&deliver)?;
                    }
                    return Ok(());
                }
                if !parser.push(&buffer[..bytes], &deliver)? {
                    return Ok(());
                }
            }
            Ok(())
        })();
        if let Err(error) = outcome {
            let _ = send.blocking_send(Err(SseError::Body(Box::new(error))));
        }
    });
    Box::pin(stream::unfold(recv, |mut recv| async move {
        recv.recv().await.map(|event| (event, recv))
    }))
}

struct Parser {
    limit: usize,
    used: usize,
    line: Vec<u8>,
    event: Sse,
    first: bool,
    cr: bool,
}

impl Parser {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            used: 0,
            line: Vec::new(),
            event: Sse::default(),
            first: true,
            cr: false,
        }
    }

    fn count(&mut self) -> Result<(), Error> {
        if self.used == self.limit {
            return Err(Error::FrameLimit);
        }
        self.used += 1;
        Ok(())
    }

    fn push(&mut self, bytes: &[u8], deliver: &impl Fn(Sse) -> bool) -> Result<bool, Error> {
        for &byte in bytes {
            if self.cr {
                self.cr = false;
                if byte == b'\n' {
                    self.count()?;
                    if !self.end_line(deliver)? {
                        return Ok(false);
                    }
                    continue;
                }
                if !self.end_line(deliver)? {
                    return Ok(false);
                }
            }
            self.count()?;
            match byte {
                b'\r' => self.cr = true,
                b'\n' => {
                    if !self.end_line(deliver)? {
                        return Ok(false);
                    }
                }
                other => self.line.push(other),
            }
        }
        Ok(true)
    }

    fn end_line(&mut self, deliver: &impl Fn(Sse) -> bool) -> Result<bool, Error> {
        let raw = std::str::from_utf8(&self.line).map_err(|_| Error::InvalidBody)?;
        let line = if self.first {
            self.first = false;
            raw.strip_prefix('\u{feff}').unwrap_or(raw)
        } else {
            raw
        };
        if line.is_empty() {
            let event = std::mem::take(&mut self.event);
            self.used = 0;
            self.line.clear();
            return Ok(event == Sse::default() || deliver(event));
        }
        let (key, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match key {
            "event" => self.event.event = Some(value.to_owned()),
            "data" => {
                if let Some(data) = self.event.data.as_mut() {
                    data.push('\n');
                    data.push_str(value);
                } else {
                    self.event.data = Some(value.to_owned());
                }
            }
            "id" if !value.contains('\0') => self.event.id = Some(value.to_owned()),
            "retry" if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) => {
                self.event.retry = value.parse().ok();
            }
            _ => {}
        }
        self.line.clear();
        Ok(true)
    }
}
