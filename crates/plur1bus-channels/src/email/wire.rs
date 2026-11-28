use super::{Error, Kind, Options, Ports, Security};
use crate::stream::DeadlineStream;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::time::{Duration, Instant};

pub(super) struct Wire {
    reader: Option<BufReader<DeadlineStream>>,
    pending_line: Vec<u8>,
    timeout: Duration,
}

impl Wire {
    pub(super) fn open(
        ports: &dyn Ports,
        options: &Options<'_>,
        failed: &'static str,
    ) -> Result<Self, Error> {
        if options.timeout.is_zero() {
            return Err(Error::new(Kind::Timeout, "mail deadline elapsed"));
        }
        let timeout = options.timeout.min(Duration::from_secs(600));
        let deadline = Instant::now() + timeout.min(Duration::from_secs(30));
        let io = ports
            .connect(options.host, options.port, deadline)
            .map_err(|_| Error::new(Kind::Network, failed))?;
        let io = match options.security {
            Security::Tls => ports
                .upgrade(options.host, io, Instant::now() + timeout)
                .map_err(|_| Error::new(Kind::Tls, "TLS handshake failed"))?,
            Security::StartTls => io,
        };
        let reader = BufReader::new(DeadlineStream {
            io,
            deadline: Instant::now() + timeout,
        });
        Ok(Self {
            reader: Some(reader),
            pending_line: Vec::new(),
            timeout,
        })
    }

    pub(super) fn reset_deadline(&mut self) {
        self.deadline_at(Instant::now() + self.timeout);
    }

    pub(super) fn deadline_at(&mut self, deadline: Instant) {
        if let Some(reader) = &mut self.reader {
            reader.get_mut().deadline = deadline;
        }
    }

    pub(super) fn upgrade(mut self, ports: &dyn Ports, host: &str) -> Result<Self, Error> {
        let reader = self.reader.take().ok_or_else(closed)?;
        if !reader.buffer().is_empty() || !self.pending_line.is_empty() {
            return Err(Error::new(Kind::Protocol, "unexpected data before TLS"));
        }
        let deadline = Instant::now() + self.timeout;
        let io = ports
            .upgrade(host, reader.into_inner().io, deadline)
            .map_err(|_| Error::new(Kind::Tls, "TLS handshake failed"))?;
        self.reader = Some(BufReader::new(DeadlineStream { io, deadline }));
        Ok(self)
    }

    pub(super) fn write_line(&mut self, line: &str) -> Result<(), Error> {
        if line.bytes().any(|b| matches!(b, b'\r' | b'\n' | 0)) {
            return Err(Error::new(Kind::Protocol, "invalid mail command"));
        }
        let mut data = Vec::with_capacity(line.len() + 2);
        data.extend_from_slice(line.as_bytes());
        data.extend_from_slice(b"\r\n");
        self.write(&data)
    }

    pub(super) fn write(&mut self, bytes: &[u8]) -> Result<(), Error> {
        let stream = self.reader.as_mut().ok_or_else(closed)?.get_mut();
        stream
            .write_all(bytes)
            .and_then(|()| stream.flush())
            .map_err(|error| io_error(error.kind()))
    }

    pub(super) fn line(&mut self, max: usize) -> Result<String, Error> {
        let reader = self.reader.as_mut().ok_or_else(closed)?;
        loop {
            let input = reader.fill_buf().map_err(|error| io_error(error.kind()))?;
            if input.is_empty() {
                return Err(Error::new(Kind::Network, "connection closed"));
            }
            let len = input
                .iter()
                .position(|b| *b == b'\n')
                .map_or(input.len(), |i| i + 1);
            if self.pending_line.len().saturating_add(len) > max.saturating_add(2) {
                return Err(Error::new(Kind::Protocol, "line too long"));
            }
            self.pending_line.extend_from_slice(&input[..len]);
            reader.consume(len);
            if self.pending_line.ends_with(b"\r\n") {
                self.pending_line.truncate(self.pending_line.len() - 2);
                let value = String::from_utf8_lossy(&self.pending_line).into_owned();
                self.pending_line.clear();
                return Ok(value);
            }
            if self.pending_line.len() > max + usize::from(self.pending_line.ends_with(b"\r")) {
                return Err(Error::new(Kind::Protocol, "line too long"));
            }
        }
    }

    pub(super) fn bytes(&mut self, count: usize) -> Result<Vec<u8>, Error> {
        let mut bytes = vec![0; count];
        let reader = self.reader.as_mut().ok_or_else(closed)?;
        if let Err(error) = reader.read_exact(&mut bytes) {
            self.close();
            return Err(io_error(error.kind()));
        }
        Ok(bytes)
    }

    pub(super) fn is_open(&self) -> bool {
        self.reader.is_some()
    }

    pub(super) fn close(&mut self) {
        self.reader = None;
        self.pending_line.clear();
    }
}

fn closed() -> Error {
    Error::new(Kind::Network, "connection closed")
}

fn io_error(kind: io::ErrorKind) -> Error {
    if matches!(kind, io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock) {
        Error::new(Kind::Timeout, "mail deadline elapsed")
    } else {
        Error::new(Kind::Network, "connection closed")
    }
}

#[cfg(test)]
pub(super) mod test_stream {
    use super::*;
    use std::io::Cursor;
    use std::net::SocketAddr;

    struct Memory {
        input: Cursor<Vec<u8>>,
        eof: io::ErrorKind,
    }

    impl Read for Memory {
        fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
            match self.input.read(output)? {
                0 => Err(self.eof.into()),
                n => Ok(n),
            }
        }
    }

    impl Write for Memory {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl crate::email::TimedStream for Memory {
        fn peer_addr(&self) -> io::Result<SocketAddr> {
            Err(io::ErrorKind::Unsupported.into())
        }

        fn set_deadline(&mut self, _: Instant) -> io::Result<()> {
            Ok(())
        }
    }

    pub(in crate::email) fn wire(input: impl Into<Vec<u8>>, eof: io::ErrorKind) -> Wire {
        let timeout = Duration::from_secs(1);
        Wire {
            reader: Some(BufReader::new(DeadlineStream {
                io: Box::new(Memory {
                    input: Cursor::new(input.into()),
                    eof,
                }),
                deadline: Instant::now() + timeout,
            })),
            pending_line: Vec::new(),
            timeout,
        }
    }

    struct MemoryUpgrade;

    impl Ports for MemoryUpgrade {
        fn connect(
            &self,
            _: &str,
            _: u16,
            _: Instant,
        ) -> io::Result<Box<dyn crate::email::TimedStream>> {
            Err(io::ErrorKind::Unsupported.into())
        }

        fn upgrade(
            &self,
            _: &str,
            stream: Box<dyn crate::email::TimedStream>,
            _: Instant,
        ) -> io::Result<Box<dyn crate::email::TimedStream>> {
            Ok(stream)
        }
    }

    #[test]
    fn stream_upgrade_requires_empty_buffers() -> Result<(), Error> {
        let open = |input: &'static [u8]| wire(input, io::ErrorKind::UnexpectedEof);
        let mut clean = open(b"ready\r\n");
        assert_eq!(clean.line(16)?, "ready");
        assert!(clean
            .upgrade(&MemoryUpgrade, "mail.example.invalid")
            .is_ok());

        let mut buffered = open(b"ready\r\nnext\r\n");
        assert_eq!(buffered.line(16)?, "ready");
        assert_eq!(
            buffered
                .upgrade(&MemoryUpgrade, "mail.example.invalid")
                .err()
                .map(|e| e.kind),
            Some(Kind::Protocol)
        );
        Ok(())
    }

    #[test]
    fn mail_lines_include_the_boundary_and_reject_the_next_byte() -> Result<(), Error> {
        let mut wire = wire(b"abcd\r\nabcde\r\n", io::ErrorKind::UnexpectedEof);
        assert_eq!(wire.line(4)?, "abcd");
        assert_eq!(wire.line(4).err().map(|e| e.kind), Some(Kind::Protocol));
        Ok(())
    }
}
