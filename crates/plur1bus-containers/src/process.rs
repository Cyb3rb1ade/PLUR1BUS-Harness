use crate::Result;
use std::{
    io::{Read, Write},
    process::{Child, ChildStdout, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
const MAX_OUTPUT: u64 = 8 * 1024 * 1024;
pub(crate) fn run(mut cmd: Command, input: Option<Vec<u8>>, timeout: Duration) -> Result<Vec<u8>> {
    let mut child = cmd
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn: {e}"))?;
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let reader = |r: Box<dyn Read + Send>| {
        thread::spawn(move || {
            let mut b = Vec::new();
            r.take(MAX_OUTPUT + 1).read_to_end(&mut b).map(|_| b)
        })
    };
    let stdout = reader(Box::new(out));
    let stderr = reader(Box::new(err));
    let writer = input.map(|bytes| {
        let mut stdin = child.stdin.take().unwrap();
        thread::spawn(move || stdin.write_all(&bytes))
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(s) => break s,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("runtime command deadline exceeded".into());
            }
            None => thread::sleep(Duration::from_millis(20)),
        }
    };
    if let Some(w) = writer {
        w.join()
            .map_err(|_| "stdin writer failed")?
            .map_err(|e| e.to_string())?;
    }
    let output = stdout
        .join()
        .map_err(|_| "stdout reader failed")?
        .map_err(|e| e.to_string())?;
    let errors = stderr
        .join()
        .map_err(|_| "stderr reader failed")?
        .map_err(|e| e.to_string())?;
    if output.len() as u64 > MAX_OUTPUT || errors.len() as u64 > MAX_OUTPUT {
        return Err("runtime output exceeded 8 MiB; use logs stream".into());
    }
    if !status.success() {
        return Err(format!(
            "runtime command {status}: {}",
            String::from_utf8_lossy(&errors)
        ));
    }
    Ok(output)
}
pub struct LogStream {
    child: Child,
    stdout: ChildStdout,
    multiplex: bool,
    remaining: usize,
}
impl LogStream {
    fn eof(&mut self) -> std::io::Result<usize> {
        let status = self.child.wait()?;
        if status.success() {
            Ok(0)
        } else {
            Err(std::io::Error::other(format!(
                "runtime log transport failed: {status}"
            )))
        }
    }
    pub(crate) fn docker(cmd: Command) -> Result<Self> {
        let mut stream = Self::spawn(cmd)?;
        stream.multiplex = true;
        Ok(stream)
    }
    pub(crate) fn spawn(mut cmd: Command) -> Result<Self> {
        let mut child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().unwrap();
        Ok(Self {
            child,
            stdout,
            multiplex: false,
            remaining: 0,
        })
    }
}
impl Read for LogStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if !self.multiplex {
            let read = self.stdout.read(buf)?;
            return if read == 0 { self.eof() } else { Ok(read) };
        }
        while self.remaining == 0 {
            let mut header = [0; 8];
            if self.stdout.read(&mut header[..1])? == 0 {
                return self.eof();
            }
            self.stdout.read_exact(&mut header[1..])?;
            if ![1, 2].contains(&header[0]) || header[1..4] != [0, 0, 0] {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "invalid Docker log frame",
                ));
            }
            self.remaining = u32::from_be_bytes(header[4..8].try_into().unwrap()) as usize;
        }
        let length = buf.len().min(self.remaining);
        let read = self.stdout.read(&mut buf[..length])?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "truncated Docker log frame",
            ));
        }
        self.remaining -= read;
        Ok(read)
    }
}
impl Drop for LogStream {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn a_failed_log_transport_is_not_successful_empty_output() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "exit 7"]);
        let mut stream = LogStream::spawn(cmd).unwrap();
        assert!(stream
            .read_to_end(&mut vec![])
            .unwrap_err()
            .to_string()
            .contains("transport failed"));
    }
}
