//! The child owns the other ends of the private NUL-delimited DevTools pipes.
use std::{
    io::{BufRead, BufReader, Read, Write},
    sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
    thread,
    time::{Duration, Instant},
};

use crate::chromium::{Control, Error, Result, Transport, TEXT_LIMIT};

const POLL: Duration = Duration::from_millis(20);

pub(super) struct Pipe<'a> {
    received: Receiver<Result<String>>,
    outgoing: SyncSender<WriteFrame>,
    control: Control<'a>,
}

struct WriteFrame {
    text: String,
    completion: SyncSender<Result<()>>,
}

impl<'a> Pipe<'a> {
    pub(super) fn start(
        stdout: impl Read + Send + 'static,
        mut stdin: impl Write + Send + 'static,
        control: Control<'a>,
    ) -> Result<Self> {
        let (incoming, received) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("document-cdp-read".into())
            .spawn(move || {
                let mut input = BufReader::new(stdout);
                loop {
                    let frame = read_frame(&mut input, TEXT_LIMIT);
                    let failed = frame.is_err();
                    if incoming.send(frame).is_err() || failed {
                        break;
                    }
                }
            })
            .map_err(|_| Error::BrowserUnavailable)?;
        let (outgoing, output) = mpsc::sync_channel::<WriteFrame>(1);
        thread::Builder::new()
            .name("document-cdp-write".into())
            .spawn(move || {
                while let Ok(frame) = output.recv() {
                    let result = stdin
                        .write_all(frame.text.as_bytes())
                        .and_then(|()| stdin.write_all(&[0]))
                        .and_then(|()| stdin.flush())
                        .map_err(|_| Error::BrowserUnavailable);
                    let failed = result.is_err();
                    if frame.completion.send(result).is_err() || failed {
                        return;
                    }
                }
            })
            .map_err(|_| Error::BrowserUnavailable)?;
        Ok(Self {
            received,
            outgoing,
            control,
        })
    }
}

impl Transport for Pipe<'_> {
    fn send(&mut self, text: &str, deadline: Instant) -> Result<()> {
        self.control.check()?;
        if text.len() > TEXT_LIMIT || text.as_bytes().contains(&0) {
            return Err(Error::TooLarge);
        }
        let (completion, written) = mpsc::sync_channel(1);
        self.outgoing
            .try_send(WriteFrame {
                text: text.to_owned(),
                completion,
            })
            .map_err(|_| Error::BrowserUnavailable)?;
        wait_for(&written, self.control, deadline)?
    }

    fn receive(&mut self, deadline: Instant) -> Result<String> {
        wait_for(&self.received, self.control, deadline)?
    }

    fn wait(&mut self, delay: Duration, deadline: Instant) -> Result<()> {
        let end = (Instant::now() + delay).min(deadline);
        loop {
            self.control.check()?;
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(());
            }
            thread::sleep(left.min(POLL));
        }
    }
}

fn wait_for<T>(inbox: &Receiver<T>, control: Control<'_>, deadline: Instant) -> Result<T> {
    loop {
        control.check()?;
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(Error::Timeout);
        }
        match inbox.recv_timeout(left.min(POLL)) {
            Ok(result) => {
                control.check()?;
                return Ok(result);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err(Error::BrowserUnavailable),
        }
    }
}

fn read_frame(input: &mut impl BufRead, limit: usize) -> Result<String> {
    let mut bytes = Vec::new();
    loop {
        let data = input.fill_buf().map_err(|_| Error::BrowserUnavailable)?;
        if data.is_empty() {
            return if bytes.is_empty() {
                Err(Error::BrowserUnavailable)
            } else {
                Err(Error::Protocol)
            };
        }
        let separator = data.iter().position(|byte| *byte == 0);
        let len = separator.unwrap_or(data.len());
        if len > limit - bytes.len() {
            return Err(Error::TooLarge);
        }
        bytes.extend_from_slice(&data[..len]);
        input.consume(len + usize::from(separator.is_some()));
        if separator.is_some() {
            return String::from_utf8(bytes).map_err(|_| Error::Protocol);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{read_frame, wait_for, Control, Duration, Error, Instant};
    use std::{io::Cursor, sync::mpsc};

    #[test]
    fn pipe_framing_checks_each_message_before_copying() {
        let mut frames = Cursor::new(b"one\0four\0longer\0");
        assert_eq!(read_frame(&mut frames, 4).as_deref(), Ok("one"));
        assert_eq!(read_frame(&mut frames, 4).as_deref(), Ok("four"));
        assert_eq!(read_frame(&mut frames, 4), Err(Error::TooLarge));
    }

    #[test]
    fn a_waiting_read_observes_cancellation() {
        let (_sending, received) = mpsc::sync_channel::<String>(1);
        let start = Instant::now();
        let deadline = start + Duration::from_secs(3);
        let control = Control {
            deadline,
            cancelled: &|| start.elapsed() >= Duration::from_millis(35),
        };
        assert_eq!(
            wait_for(&received, control, deadline),
            Err(Error::Cancelled)
        );
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
