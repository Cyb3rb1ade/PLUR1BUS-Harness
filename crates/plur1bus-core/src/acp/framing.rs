//! ACP stdio framing: one JSON-RPC message per line (UTF-8, `\n`; a preceding `\r` is dropped). The reader bounds a line by
//! bytes before it is ever decoded, so a hostile peer cannot make the adapter buffer without limit (port of
//! `packages/core/src/acp/framing.ts`).
use super::json::V;

/// RULING (TypeScript): 1 MiB per line. `session.submit` takes at most 200 000 characters of text (at most 800 KB as UTF-8), so
/// a maximal prompt still fits with its JSON envelope; anything larger is refused rather than buffered.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

/// What the reader hands out for one line.
#[derive(Debug, PartialEq, Eq)]
pub enum LineItem {
    /// A line, decoded as UTF-8 (an invalid sequence reads as U+FFFD, as `Buffer.toString("utf8")` reads it).
    Line(String),
    /// A line longer than the limit; its bytes were never kept.
    Overflow,
}

/// Cuts a byte stream into lines with a byte bound.
#[derive(Debug)]
pub struct LineReader {
    max: usize,
    buf: Vec<u8>,
    discarding: bool,
}

impl LineReader {
    /// A reader with the given bound per line.
    pub fn new(max_line_bytes: usize) -> LineReader {
        LineReader {
            max: max_line_bytes,
            buf: Vec::new(),
            discarding: false,
        }
    }

    /// Feeds one chunk and returns the lines it completed, in order.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<LineItem> {
        let mut out = Vec::new();
        let mut start = 0;
        loop {
            let nl = chunk[start..]
                .iter()
                .position(|b| *b == 0x0a)
                .map(|p| p + start);
            let end = nl.unwrap_or(chunk.len());
            let piece = &chunk[start..end];
            if !self.discarding {
                // One byte of slack for a `\r` that may still be followed by its `\n` in the next chunk; `take` makes the
                // exact call.
                if self.buf.len() + piece.len() > self.max.saturating_add(1) {
                    out.push(LineItem::Overflow);
                    self.buf = Vec::new();
                    self.discarding = nl.is_none();
                } else {
                    self.buf.extend_from_slice(piece);
                }
            }
            let Some(nl) = nl else { break };
            if self.discarding {
                self.discarding = false;
            } else if let Some(item) = self.take() {
                out.push(item);
            }
            start = nl + 1;
        }
        out
    }

    /// The unterminated rest at the end of input.
    pub fn end(&mut self) -> Vec<LineItem> {
        if self.discarding {
            self.discarding = false;
            self.buf = Vec::new();
            return Vec::new();
        }
        self.take().into_iter().collect()
    }

    fn take(&mut self) -> Option<LineItem> {
        let mut buf = std::mem::take(&mut self.buf);
        if buf.last() == Some(&0x0d) {
            buf.pop();
        }
        if buf.len() > self.max {
            return Some(LineItem::Overflow);
        }
        if buf.is_empty() {
            return None;
        }
        Some(LineItem::Line(String::from_utf8_lossy(&buf).into_owned()))
    }
}

/// One message as one line. `JSON.stringify` escapes `\n`; U+2028 and U+2029 stay literal but are no line break for this
/// framing. `None` where the value cannot be serialised.
pub fn encode_line(message: &V) -> Option<String> {
    let mut s = message.stringify()?;
    s.push('\n');
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(r: &mut LineReader, chunks: &[&[u8]]) -> Vec<LineItem> {
        chunks.iter().flat_map(|c| r.push(c)).collect()
    }

    #[test]
    fn splits_on_newline_across_chunks_and_drops_one_carriage_return() {
        let mut r = LineReader::new(64);
        let got = lines(&mut r, &[b"ab", b"c\r\nde", b"f\n\n\r\nlast"]);
        assert_eq!(
            got,
            vec![LineItem::Line("abc".into()), LineItem::Line("def".into())]
        );
        assert_eq!(r.end(), vec![LineItem::Line("last".into())]);
    }

    #[test]
    fn an_overlong_line_is_refused_once_and_skipped_to_its_newline() {
        let mut r = LineReader::new(4);
        assert_eq!(
            lines(&mut r, &[b"12345", b"6789", b"\nok\n"]),
            vec![LineItem::Overflow, LineItem::Line("ok".into())]
        );
        // exactly the limit passes, the limit plus a carriage return passes, the limit plus one byte does not
        assert_eq!(
            lines(&mut r, &[b"1234\n", b"1234\r\n", b"12345\n"]),
            vec![
                LineItem::Line("1234".into()),
                LineItem::Line("1234".into()),
                LineItem::Overflow
            ]
        );
        assert_eq!(lines(&mut r, &[b"123456"]), vec![LineItem::Overflow]);
        assert!(
            r.end().is_empty(),
            "an unterminated overlong rest was already reported"
        );
    }

    #[test]
    fn invalid_utf8_reads_as_replacement_characters() {
        let mut r = LineReader::new(64);
        assert_eq!(
            r.push(b"a\xffb\xc3\n"),
            vec![LineItem::Line("a\u{fffd}b\u{fffd}".into())]
        );
    }
}
