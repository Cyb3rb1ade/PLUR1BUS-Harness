use crate::ProviderError;

#[derive(Debug, Eq, PartialEq)]
pub struct SseEvent {
    pub data: String,
    pub event: Option<String>,
    pub id: Option<String>,
}

pub struct SseParser {
    limit: usize,
    pending: Vec<u8>,
    start: bool,
    validated: usize,
    scan: usize,
    line_units: usize,
    data: Vec<String>,
    units: usize,
    event: Option<String>,
    id: Option<String>,
}

impl SseParser {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            pending: Vec::new(),
            start: true,
            validated: 0,
            scan: 0,
            line_units: 0,
            data: Vec::new(),
            units: 0,
            event: None,
            id: None,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseEvent>, ProviderError> {
        self.pending.extend_from_slice(bytes);
        self.drain(false)
    }

    pub fn finish(&mut self) -> Result<Vec<SseEvent>, ProviderError> {
        let events = self.drain(true)?;
        self.data.clear();
        self.units = 0;
        self.event = None;
        self.id = None;
        Ok(events)
    }

    fn drain(&mut self, final_read: bool) -> Result<Vec<SseEvent>, ProviderError> {
        if self.start {
            const BOM: &[u8] = b"\xef\xbb\xbf";
            if !final_read && self.pending.len() < BOM.len() && BOM.starts_with(&self.pending) {
                return Ok(Vec::new());
            }
            if self.pending.starts_with(BOM) {
                self.pending.drain(..BOM.len());
            }
            self.start = false;
        }
        // Keep any incomplete scalar in the unvalidated suffix for the next read.
        // The preceding bytes are already known valid, even on an open line.
        let suffix = &self.pending[self.validated..];
        let valid = self.validated
            + match std::str::from_utf8(suffix) {
                Ok(_) => suffix.len(),
                Err(error) if !final_read && error.error_len().is_none() => error.valid_up_to(),
                Err(_) => return Err(ProviderError::protocol("stream is not valid UTF-8")),
            };
        let mut events = Vec::new();
        let mut line_start = 0;
        let mut offset = self.scan;
        let mut line_units = self.line_units;
        while offset < valid {
            let byte = self.pending[offset];
            if byte != b'\n' && byte != b'\r' {
                // Count only the leading byte of each validated scalar.
                // A four-byte UTF-8 scalar occupies two UTF-16 units.
                line_units += match byte {
                    0x80..=0xbf => 0,
                    0xf0..=0xff => 2,
                    _ => 1,
                };
                offset += 1;
                continue;
            }
            if !final_read && byte == b'\r' && offset + 1 == valid {
                break;
            }
            let line = std::str::from_utf8(&self.pending[line_start..offset])
                .map_err(|_| ProviderError::protocol("stream is not valid UTF-8"))?
                .to_owned();
            offset += if byte == b'\r' && self.pending.get(offset + 1) == Some(&b'\n') {
                2
            } else {
                1
            };
            line_start = offset;
            line_units = 0;
            if let Some(event) = self.line(&line)? {
                events.push(event);
            }
        }
        if final_read && line_start < valid {
            let line = String::from_utf8_lossy(&self.pending[line_start..valid]).into_owned();
            if let Some(event) = self.line(&line)? {
                events.push(event);
            }
            line_start = valid;
            offset = valid;
            line_units = 0;
        }
        // A CR held at the end of the chunk still belongs to the pending line.
        if line_units + usize::from(offset < valid) > self.limit {
            return Err(ProviderError::protocol(format!(
                "SSE line exceeds {} bytes",
                self.limit
            )));
        }
        if line_start != 0 {
            self.pending.drain(..line_start);
        }
        self.validated = valid - line_start;
        self.scan = offset - line_start;
        self.line_units = line_units;
        Ok(events)
    }

    fn line(&mut self, line: &str) -> Result<Option<SseEvent>, ProviderError> {
        if line.is_empty() {
            let event = self.event.take();
            self.units = 0;
            if self.data.is_empty() {
                return Ok(None);
            }
            let data = std::mem::take(&mut self.data).join("\n");
            return Ok(Some(SseEvent {
                data,
                event,
                id: self.id.clone(),
            }));
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "data" => {
                self.units += value.encode_utf16().count() + 1;
                if self.units > self.limit {
                    return Err(ProviderError::protocol(format!(
                        "SSE event exceeds {} bytes",
                        self.limit
                    )));
                }
                self.data.push(value.to_owned());
            }
            "event" => self.event = Some(value.to_owned()),
            "id" if !value.contains('\0') => self.id = Some(value.to_owned()),
            _ => {}
        }
        Ok(None)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_large_open_line_is_scanned_incrementally() {
        use std::time::{Duration, Instant};

        let chunk = [b'x'; 512];
        const READS: usize = 2048;
        let mut parser = SseParser::new(chunk.len() * READS + 1);
        parser.push(b":").unwrap();
        let start = Instant::now();
        for _ in 0..READS {
            assert!(parser.push(&chunk).unwrap().is_empty());
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "an open SSE line was rescanned"
            );
        }
        assert!(parser.push(b"\r\n").unwrap().is_empty());
    }

    #[test]
    fn a_split_four_byte_scalar_counts_as_two_units_once() {
        let mut parser = SseParser::new(4);
        assert!(parser.push(b":x\xf0").unwrap().is_empty());
        assert!(parser.push(b"\x9f\x98").unwrap().is_empty());
        assert!(parser.push(b"\x80").unwrap().is_empty());
        assert_eq!(
            parser.push(b"y").unwrap_err().message.as_ref(),
            "SSE line exceeds 4 bytes"
        );
    }

    #[test]
    fn the_unterminated_line_has_its_own_utf16_limit() {
        let mut parser = SseParser::new(4);
        assert!(parser.push(":x😀".as_bytes()).unwrap().is_empty());
        assert_eq!(
            parser.push(b"y").unwrap_err().message.as_ref(),
            "SSE line exceeds 4 bytes"
        );
    }

    #[test]
    fn an_event_cannot_accumulate_short_data_lines_past_the_limit() {
        let mut parser = SseParser::new(5);
        assert!(parser.push(b"data: ab\n").unwrap().is_empty());
        assert_eq!(
            parser.push(b"data: cd\n").unwrap_err().message.as_ref(),
            "SSE event exceeds 5 bytes"
        );
    }

    #[test]
    fn a_carriage_return_waits_for_a_possible_split_crlf() {
        let mut parser = SseParser::new(64);
        assert!(parser.push(b"data: x\r\n\r").unwrap().is_empty());
        assert_eq!(
            parser.push(b"\n").unwrap(),
            [SseEvent {
                data: "x".into(),
                event: None,
                id: None,
            }]
        );
    }
}
