//! `output.ts`: line framing for child-process output. Foreign text is never parsed for levels, events or trace metadata;
//! it is split into lines, masked against the writer's exact secret values (also across chunk boundaries), stripped of
//! terminal control sequences and private-key blocks, cut at the line limit, and written as `process.output.line`.
//!
//! Text is kept as UTF-16 code units, as in the TypeScript source, so offsets, padding and the redactor's window API
//! agree. The private-key block markers are matched by hand (the rule in `redaction.json` is a regular expression; the
//! core takes no regex dependency), and a test pins them to that rule.
use super::error::LogError;
use super::levels::{system_clock, Clock};
use super::writer::{OutStream, OutputLineInput, WriteFields, Writer};
use plur1bus_log_schema::redact::utf16::{utf16, utf8_len};
use plur1bus_log_schema::redact::{SecretFormsCache, SecretMatcher};
use plur1bus_log_schema::{limits, Level};
use serde_json::json;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

const FRAME_BYTES: usize = 65536;
const NL: u16 = 10;
const PEM_MASK: &str = "[REDACTED:pattern]";

/// Foreign text is never parsed for levels, events or trace metadata: operating-system commands, CSI sequences and
/// control characters (except tab) are removed.
pub fn sanitise(text: &str) -> String {
    // 1. `\x1b\][\s\S]*?(?:\x07|\x1b\\|$)`
    let chars: Vec<char> = text.chars().collect();
    let mut no_osc = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\u{1b}' && chars.get(i + 1) == Some(&']') {
            let mut j = i + 2;
            loop {
                match chars.get(j) {
                    None => {
                        i = j;
                        break;
                    }
                    Some('\u{7}') => {
                        i = j + 1;
                        break;
                    }
                    Some('\u{1b}') if chars.get(j + 1) == Some(&'\\') => {
                        i = j + 2;
                        break;
                    }
                    Some(_) => j += 1,
                }
            }
            continue;
        }
        no_osc.push(chars[i]);
        i += 1;
    }
    // 2. `\x1b\[[0-?]*[ -/]*[@-~]`
    let chars: Vec<char> = no_osc.chars().collect();
    let mut no_csi = String::with_capacity(no_osc.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\u{1b}' && chars.get(i + 1) == Some(&'[') {
            let mut j = i + 2;
            while chars
                .get(j)
                .is_some_and(|c| ('\u{30}'..='\u{3f}').contains(c))
            {
                j += 1;
            }
            while chars
                .get(j)
                .is_some_and(|c| ('\u{20}'..='\u{2f}').contains(c))
            {
                j += 1;
            }
            if chars
                .get(j)
                .is_some_and(|c| ('\u{40}'..='\u{7e}').contains(c))
            {
                i = j + 1;
                continue;
            }
        }
        no_csi.push(chars[i]);
        i += 1;
    }
    // 3. `[\x00-\x08\x0a-\x1f\x7f-\x9f]`
    no_csi
        .chars()
        .filter(|c| !matches!(*c, '\u{0}'..='\u{8}' | '\u{a}'..='\u{1f}' | '\u{7f}'..='\u{9f}'))
        .collect()
}

/// The first `-----<word> <class>*PRIVATE KEY( BLOCK)?-----` marker in `text` (`word` is `BEGIN` or `END`), as the byte
/// range it covers. `<class>` is `[A-Z0-9 ]`; the match backtracks as the regular expression does.
fn find_pem_marker(text: &str, word: &str) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let prefix = format!("-----{word} ");
    let mut from = 0;
    while let Some(found) = text[from..].find(&prefix) {
        let start = from + found;
        let after = start + prefix.len();
        let mut run = after;
        while bytes
            .get(run)
            .is_some_and(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b' ')
        {
            run += 1;
        }
        // The class consumes [after, p); PRIVATE KEY starts at p <= run, trying the longest class run first.
        let mut p = run;
        loop {
            if text[p..].starts_with("PRIVATE KEY") {
                let tail = p + "PRIVATE KEY".len();
                for block in [" BLOCK", ""] {
                    let end = tail + block.len();
                    if text[tail..].starts_with(block) && text[end..].starts_with("-----") {
                        return Some((start, end + 5));
                    }
                }
            }
            if p == after {
                break;
            }
            p -= 1;
        }
        from = start + 1;
    }
    None
}

/// What a child's exit or an HTTP answer means for the level of its record (`signalLevel`).
#[derive(Clone, Debug, Default)]
pub struct Signal {
    /// The exit code.
    pub exit_code: Option<i64>,
    /// The terminating signal.
    pub signal: Option<String>,
    /// The HTTP status.
    pub http_status: Option<u16>,
    /// A retry follows.
    pub retrying: bool,
    /// A protocol error occurred.
    pub protocol_error: bool,
}

/// `signalLevel(s)`.
pub fn signal_level(s: &Signal) -> Level {
    if s.signal.as_deref().is_some_and(|x| !x.is_empty())
        || s.protocol_error
        || s.exit_code.is_some_and(|c| c != 0)
    {
        return Level::Error;
    }
    if let Some(status) = s.http_status {
        if status >= 400 {
            return if s.retrying && (status == 429 || status == 503) {
                Level::Warn
            } else {
                Level::Error
            };
        }
    }
    Level::Info
}

/// An incremental UTF-8 decoder (`StringDecoder`): an incomplete sequence at the end waits for the next chunk, an invalid
/// one becomes U+FFFD.
#[derive(Default)]
struct Decoder {
    carry: Vec<u8>,
}

impl Decoder {
    fn write(&mut self, chunk: &[u8]) -> String {
        let mut data = std::mem::take(&mut self.carry);
        data.extend_from_slice(chunk);
        let mut out = String::new();
        let mut rest: &[u8] = &data;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let (good, bad) = rest.split_at(e.valid_up_to());
                    out.push_str(std::str::from_utf8(good).unwrap_or_default());
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{fffd}');
                            rest = &bad[n..];
                        }
                        None => {
                            self.carry = bad.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    fn end(&mut self) -> String {
        if self.carry.is_empty() {
            String::new()
        } else {
            self.carry.clear();
            "\u{fffd}".to_string()
        }
    }
}

fn is_high(u: u16) -> bool {
    (0xd800..=0xdbff).contains(&u)
}

fn is_low(u: u16) -> bool {
    (0xdc00..=0xdfff).contains(&u)
}

/// The tail of `units` that is at most `bytes` UTF-8 bytes long, starting at a character boundary.
fn source_suffix(units: &[u16], bytes: usize) -> Vec<u16> {
    if utf8_len(units) <= bytes {
        return units.to_vec();
    }
    let mut size = 0;
    let mut at = units.len();
    while at > 0 {
        let (width, step) = if is_low(units[at - 1]) && at >= 2 && is_high(units[at - 2]) {
            (4, 2)
        } else if units[at - 1] < 0x80 {
            (1, 1)
        } else if units[at - 1] < 0x800 {
            (2, 1)
        } else {
            (3, 1)
        };
        if size + width > bytes {
            break;
        }
        size += width;
        at -= step;
    }
    units[at..].to_vec()
}

/// Line framing keeps at most 64 KiB; oversized lines are replaced wholesale, so discarded secret suffixes cannot
/// expose a prefix.
pub struct OutputLines {
    writer: Arc<Writer>,
    stream: OutStream,
    now: Clock,
    matcher: Arc<SecretMatcher>,
    decoder: Decoder,
    pending: Vec<u16>,
    pending_bytes: usize,
    bytes: usize,
    last: i64,
    history: Vec<u16>,
    advanced: usize,
    last_padding: usize,
    quarantine: usize,
    discarding: bool,
    tokens: f64,
    at: i64,
    start: i64,
    dropped: u64,
    closed: bool,
    in_pem: bool,
}

impl OutputLines {
    /// A framer for one stream of `writer`. `secrets` are values the framer knows in addition to the writer's own.
    pub fn new(
        writer: Arc<Writer>,
        stream: OutStream,
        now: Option<Clock>,
        secrets: &[String],
    ) -> OutputLines {
        let now = now.unwrap_or_else(system_clock);
        let at = now();
        let matcher = SecretFormsCache::default()
            .snapshot(secrets.iter().map(String::as_str))
            .matcher
            .clone();
        OutputLines {
            writer,
            stream,
            matcher,
            decoder: Decoder::default(),
            pending: Vec::new(),
            pending_bytes: 0,
            bytes: 0,
            last: 0,
            history: Vec::new(),
            advanced: 0,
            last_padding: 0,
            quarantine: 0,
            discarding: false,
            tokens: limits().rate_burst as f64,
            at,
            start: at,
            dropped: 0,
            closed: false,
            in_pem: false,
            now,
        }
    }

    /// Masks a private-key block across lines; `in_pem` is the state between lines. An unterminated block stays masked to
    /// the end of the stream.
    fn mask_pem(&mut self, text: &str) -> String {
        let mut state = PemState {
            in_pem: self.in_pem,
        };
        let out = state.mask(text);
        self.in_pem = state.in_pem;
        out
    }

    /// Feeds one chunk.
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), LogError> {
        if self.closed {
            return Err(LogError::OutputClosed);
        }
        let text = self.decoder.write(chunk);
        self.consume(&utf16(&text))
    }

    fn padding(&mut self) -> usize {
        let next = self
            .writer
            .output_matcher(Some(&self.matcher))
            .max_source_bytes()
            .saturating_sub(1);
        let retained = utf8_len(&self.history);
        if next > self.last_padding && self.advanced > retained {
            self.quarantine = self.quarantine.max(next - retained);
        }
        self.last_padding = next;
        next
    }

    fn consume(&mut self, text: &[u16]) -> Result<(), LogError> {
        let mut pieces: Vec<&[u16]> = Vec::new();
        let mut from = 0;
        for (i, u) in text.iter().enumerate() {
            if *u == NL {
                pieces.push(&text[from..=i]);
                from = i + 1;
            }
        }
        if from < text.len() {
            pieces.push(&text[from..]);
        }
        for piece in pieces {
            let newline = piece.last() == Some(&NL);
            let part = if newline {
                &piece[..piece.len() - 1]
            } else {
                piece
            };
            let mut at = 0;
            while at < part.len() {
                let mut end = part.len().min(at + 4096);
                if end < part.len() && is_high(part[end - 1]) {
                    end -= 1;
                }
                let source = &part[at..end];
                at = end;
                let bytes = utf8_len(source);
                self.bytes += bytes;
                if !self.discarding {
                    self.pending.extend_from_slice(source);
                    self.pending_bytes += bytes;
                    self.flush(false, false)?;
                    self.bound()?;
                }
            }
            self.last = (self.now)();
            if newline {
                if self.discarding {
                    let total = self.bytes;
                    self.emit_line(&[], 0, 0, total, true)?;
                    self.discarding = false;
                    let padding = self.padding();
                    self.quarantine = self.quarantine.max(padding);
                    self.history.clear();
                } else {
                    self.pending.push(NL);
                    self.pending_bytes += 1;
                    self.flush(false, false)?;
                    self.bound()?;
                }
                self.bytes = 0;
            }
        }
        Ok(())
    }

    fn advance(&mut self, source: &[u16], padding: usize) {
        let bytes = utf8_len(source);
        self.advanced += bytes;
        self.quarantine = self.quarantine.saturating_sub(bytes);
        let mut all = std::mem::take(&mut self.history);
        all.extend_from_slice(source);
        self.history = source_suffix(&all, FRAME_BYTES.min(padding));
    }

    fn find_nl(&self, from: usize) -> Option<usize> {
        self.pending[from..]
            .iter()
            .position(|u| *u == NL)
            .map(|p| p + from)
    }

    fn flush(&mut self, last: bool, idle: bool) -> Result<(), LogError> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let padding = self.padding();
        let mut context = self.history.clone();
        let offset = context.len();
        context.extend_from_slice(&self.pending);
        // Units are conservative here: valid UTF-8 has at least as many bytes as UTF-16 units, including surrogate pairs.
        let ready = if last {
            self.pending.len()
        } else {
            self.pending.len().saturating_sub(padding)
        };
        let mut consumed = 0;
        let mut next = self.find_nl(0);
        while let Some(end) = next {
            if !(last || end < ready) {
                break;
            }
            let source_bytes = utf8_len(&self.pending[consumed..=end]);
            let framed = self.quarantine > 0;
            self.emit_line(
                &context,
                offset + consumed,
                offset + end,
                source_bytes - 1,
                framed,
            )?;
            self.quarantine = self.quarantine.saturating_sub(source_bytes);
            consumed = end + 1;
            next = self.find_nl(consumed);
        }
        if (last || idle) && consumed < self.pending.len() && self.find_nl(consumed).is_none() {
            let mut end = if last { self.pending.len() } else { ready };
            if end > consumed
                && end < self.pending.len()
                && is_high(self.pending[end - 1])
                && is_low(self.pending[end])
            {
                end -= 1;
            }
            if end > consumed {
                let source_bytes = utf8_len(&self.pending[consumed..end]);
                let framed = self.quarantine > 0;
                self.emit_line(
                    &context,
                    offset + consumed,
                    offset + end,
                    source_bytes,
                    framed,
                )?;
                self.quarantine = self.quarantine.saturating_sub(source_bytes);
                consumed = end;
                self.bytes = utf8_len(&self.pending[consumed..]);
            }
        }
        if consumed > 0 {
            let source: Vec<u16> = self.pending[..consumed].to_vec();
            let quarantine = self.quarantine;
            self.advance(&source, padding);
            self.quarantine = quarantine;
            self.pending.drain(..consumed);
            self.pending_bytes = utf8_len(&self.pending);
        }
        Ok(())
    }

    fn bound(&mut self) -> Result<(), LogError> {
        while self.pending_bytes > FRAME_BYTES {
            match self.find_nl(0) {
                None => {
                    // Discard the entire physical line, including any future suffix. Neighbouring lines also need a
                    // full context gap.
                    let text = String::from_utf16_lossy(&self.pending);
                    let _ = self.mask_pem(&sanitise(&text));
                    self.pending.clear();
                    self.pending_bytes = 0;
                    self.discarding = true;
                }
                Some(end) => {
                    let source: Vec<u16> = self.pending[..end].to_vec();
                    let text = String::from_utf16_lossy(&source);
                    let _ = self.mask_pem(&sanitise(&text));
                    self.emit_line(&[], 0, 0, utf8_len(&source), true)?;
                    self.pending.drain(..=end);
                    self.pending_bytes = utf8_len(&self.pending);
                }
            }
            self.history.clear();
            let padding = self.padding();
            self.quarantine = self.quarantine.max(padding);
        }
        Ok(())
    }

    fn emit_line(
        &mut self,
        context: &[u16],
        begin: usize,
        end: usize,
        bytes: usize,
        framed: bool,
    ) -> Result<(), LogError> {
        let now = (self.now)();
        let l = limits();
        self.tokens = (l.rate_burst as f64).min(
            self.tokens
                + (now - self.at).max(0) as f64 * l.rate_sustained_per_second as f64 / 1000.0,
        );
        self.at = now;
        if self.tokens < 1.0 {
            let dropped = String::from_utf16_lossy(&context[begin..end]);
            let _ = self.mask_pem(&sanitise(&dropped));
            self.dropped += 1;
            return Ok(());
        }
        self.tokens -= 1.0;
        let writer = self.writer.clone();
        let matcher = self.matcher.clone();
        let mut in_pem = self.in_pem;
        let result = {
            let mut transform = |text: &str| -> String {
                let mut scratch = PemState { in_pem };
                let masked = scratch.mask(&sanitise(text));
                in_pem = scratch.in_pem;
                masked
            };
            writer.write_output_line(
                &OutputLineInput {
                    context,
                    source_begin: begin,
                    source_end: end,
                    bytes,
                    stream: self.stream,
                    oversized: framed,
                },
                Some(&matcher),
                &mut transform,
            )
        };
        self.in_pem = in_pem;
        result
    }

    /// Idle timer: a partial line that has waited a second is written; dropped lines are reported.
    pub fn tick(&mut self) -> Result<(), LogError> {
        let now = (self.now)();
        if !self.pending.is_empty() && now - self.last >= 1000 {
            self.flush(false, true)?;
        }
        if self.dropped > 0 && now - self.start >= 1000 {
            self.summary()?;
        }
        Ok(())
    }

    fn summary(&mut self) -> Result<(), LogError> {
        let now = (self.now)();
        if self.dropped > 0 {
            self.writer.write(
                "process.output.suppressed",
                json!({"dropped": self.dropped, "window_ms": now - self.start}),
                WriteFields {
                    stream: Some(self.stream),
                    bypass_rate: true,
                    ..WriteFields::default()
                },
            )?;
        }
        self.dropped = 0;
        self.start = now;
        Ok(())
    }

    /// Writes what is left and reports dropped lines. Idempotent.
    pub fn close(&mut self) -> Result<(), LogError> {
        if self.closed {
            return Ok(());
        }
        let tail = self.decoder.end();
        self.consume(&utf16(&tail))?;
        if self.discarding && self.bytes > 0 {
            let total = self.bytes;
            self.emit_line(&[], 0, 0, total, true)?;
        } else {
            self.flush(true, false)?;
        }
        self.summary()?;
        self.history.clear();
        self.pending.clear();
        self.closed = true;
        Ok(())
    }
}

/// The private-key state machine over `&str`, shared between `mask_pem` and the transform the writer calls.
struct PemState {
    in_pem: bool,
}

impl PemState {
    fn mask(&mut self, text: &str) -> String {
        let mut out = String::new();
        let mut rest = text.to_string();
        let mut masked = false;
        loop {
            if self.in_pem {
                let Some((_, e)) = find_pem_marker(&rest, "END") else {
                    return if masked { out } else { out + PEM_MASK };
                };
                if !masked {
                    out.push_str(PEM_MASK);
                }
                self.in_pem = false;
                masked = false;
                rest = rest[e..].to_string();
            } else {
                let Some((s, e)) = find_pem_marker(&rest, "BEGIN") else {
                    return out + &rest;
                };
                out.push_str(&rest[..s]);
                out.push_str(PEM_MASK);
                masked = true;
                self.in_pem = true;
                rest = rest[e..].to_string();
            }
        }
    }
}

/// `wrapOutput` for one stream: reads `input` to its end, framing every line into `writer`, with a ticker thread for the
/// idle flush. Blocks until the stream ends; a caller runs one per stream on its own thread.
pub fn wrap_output(
    writer: Arc<Writer>,
    stream: OutStream,
    mut input: impl Read,
    now: Option<Clock>,
) -> Result<(), LogError> {
    let lines = Arc::new(Mutex::new(OutputLines::new(writer, stream, now, &[])));
    let stop = Arc::new(AtomicBool::new(false));
    let ticker = {
        let (lines, stop) = (lines.clone(), stop.clone());
        std::thread::spawn(move || {
            let mut waited = 0;
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(50));
                waited += 50;
                if waited >= 1000 {
                    waited = 0;
                    let _ = lines.lock().unwrap_or_else(PoisonError::into_inner).tick();
                }
            }
        })
    };
    let mut buf = vec![0u8; 8192];
    let result = loop {
        match input.read(&mut buf) {
            Ok(0) => break Ok(()),
            Ok(n) => {
                if let Err(e) = lines
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(&buf[..n])
                {
                    break Err(e);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => break Err(LogError::Io(e)),
        }
    };
    stop.store(true, Ordering::SeqCst);
    let _ = ticker.join();
    let closed = lines.lock().unwrap_or_else(PoisonError::into_inner).close();
    result.and(closed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::levels::Source;
    use crate::logs::sink::SinkHooks;
    use crate::logs::writer::WriterOptions;
    use serde_json::Value;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicI64;

    const T0: i64 = 1_791_374_400_000;

    struct Fx {
        _root: tempfile::TempDir,
        dir: PathBuf,
        clock: Arc<AtomicI64>,
        writer: Arc<Writer>,
    }

    fn fx() -> Fx {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("logs");
        let clock = Arc::new(AtomicI64::new(T0));
        let c = clock.clone();
        let mut o = WriterOptions::new(&dir, "core", Source::new("harness", "core", Some("0.1.0")));
        o.now = Some(Arc::new(move || c.load(Ordering::SeqCst)));
        o.timers = false;
        o.hooks = SinkHooks {
            secure_path: Arc::new(|_, _| true),
            ..SinkHooks::default()
        };
        let writer = Arc::new(Writer::new(o).unwrap());
        Fx {
            _root: root,
            dir,
            clock,
            writer,
        }
    }

    impl Fx {
        fn framer(&self, stream: OutStream) -> OutputLines {
            let c = self.clock.clone();
            OutputLines::new(
                self.writer.clone(),
                stream,
                Some(Arc::new(move || c.load(Ordering::SeqCst))),
                &[],
            )
        }

        fn out(&self) -> Vec<Value> {
            self.writer.flush(true).unwrap();
            std::fs::read_to_string(self.dir.join("core.log"))
                .unwrap_or_default()
                .lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect()
        }

        fn texts(&self) -> Vec<String> {
            self.out()
                .iter()
                .filter(|r| r["event"] == "process.output.line")
                .map(|r| r["attrs"]["text"].as_str().unwrap().to_string())
                .collect()
        }
    }

    #[test]
    fn sanitise_rules() {
        assert_eq!(sanitise("a\u{1b}[31mred\u{1b}[0m b"), "ared b");
        assert_eq!(sanitise("x\u{1b}]0;title\u{7}y"), "xy");
        assert_eq!(sanitise("x\u{1b}]0;title\u{1b}\\y"), "xy");
        assert_eq!(sanitise("x\u{1b}]0;never ends"), "x");
        assert_eq!(sanitise("t\tab\u{0}\u{7}\u{7f}\u{85}\r"), "t\tab");
        assert_eq!(sanitise("\u{1b}[?25h\u{1b}[1;2H!"), "!");
        assert_eq!(sanitise("ünïcödé 😀"), "ünïcödé 😀");
    }

    #[test]
    fn pem_markers_match_like_the_rule() {
        let rule: Vec<_> = plur1bus_log_schema::rule_patterns("pattern")
            .into_iter()
            .filter(|p| p.id == "pem-private-key")
            .collect();
        assert_eq!(rule.len(), 1);
        // The rule is BEGIN marker, lazy body, END marker or end of text; the hand-written markers are its two ends.
        assert!(rule[0]
            .pattern
            .starts_with("-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----"));
        assert!(rule[0]
            .pattern
            .contains("-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----"));
        let begin = "-----BEGIN RSA PRIVATE KEY-----";
        assert_eq!(
            find_pem_marker(&format!("pre {begin} post"), "BEGIN"),
            Some((4, 4 + begin.len()))
        );
        for text in [
            "-----BEGIN PRIVATE KEY-----",
            "-----BEGIN ENCRYPTED PRIVATE KEY-----",
            "-----BEGIN PRIVATE KEY BLOCK-----",
            "-----BEGIN X PRIVATE KEY BLOCK-----",
            "-----BEGIN lower PRIVATE KEY-----",
            "-----BEGIN PRIVATE KEY----",
        ] {
            let ours = find_pem_marker(text, "BEGIN").is_some();
            let theirs = rule.iter().any(|p| p.regex().is_match(text));
            assert_eq!(ours, theirs, "{text}");
        }
        assert!(find_pem_marker("-----END OPENSSH PRIVATE KEY-----", "END").is_some());
        assert!(find_pem_marker("-----END OPENSSH PUBLIC KEY-----", "END").is_none());
    }

    #[test]
    fn lines_are_framed_split_across_chunks_and_decoded_across_utf8_boundaries() {
        let f = fx();
        let mut o = f.framer(OutStream::Stdout);
        o.push(b"hel").unwrap();
        o.push(b"lo\nwor").unwrap();
        o.push("ld é".as_bytes().split_at(4).0).unwrap();
        o.push(&"é".as_bytes()[1..]).unwrap();
        o.push(b"\n").unwrap();
        o.push(b"tail").unwrap();
        o.close().unwrap();
        let v = f.out();
        assert!(v.iter().all(|r| r["stream"] == "stdout"));
        assert_eq!(f.texts(), ["hello", "world é", "tail"]);
        assert!(f.out().iter().all(|r| r["attrs"]["untrusted"] == true));
    }

    #[test]
    fn a_secret_split_over_chunks_is_masked() {
        let f = fx();
        let secret = "fixture-split-0123456789-abcdef";
        f.writer.register_secret(secret, false).unwrap();
        let mut o = f.framer(OutStream::Stderr);
        let (a, b) = secret.split_at(12);
        o.push(format!("key={a}").as_bytes()).unwrap();
        o.push(format!("{b} done\n").as_bytes()).unwrap();
        o.close().unwrap();
        let texts = f.texts();
        assert_eq!(texts, ["key=[REDACTED:secret] done"]);
    }

    #[test]
    fn control_sequences_never_reach_the_record() {
        let f = fx();
        let mut o = f.framer(OutStream::Stdout);
        o.push(b"\x1b[31merror: [ERROR] fake\x1b[0m\x1b]0;t\x07\n")
            .unwrap();
        o.close().unwrap();
        assert_eq!(f.texts(), ["error: [ERROR] fake"]);
        assert_eq!(f.out()[0]["level"], "info");
    }

    #[test]
    fn a_private_key_block_is_masked_across_lines_and_an_open_block_stays_masked() {
        let f = fx();
        let mut o = f.framer(OutStream::Stdout);
        o.push(b"before\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\nmore\n-----END PRIVATE KEY-----\nafter\n").unwrap();
        o.close().unwrap();
        // Identical records inside the window are counted, not repeated: the four masked lines are one record and a summary.
        assert_eq!(f.texts(), ["before", "[REDACTED:pattern]", "after"]);
        f.writer.tick(true).unwrap();
        let summary = f.out().into_iter().last().unwrap();
        assert_eq!(summary["attrs"]["text"], "[REDACTED:pattern]");
        assert_eq!(summary["attrs"]["repeat"], 4);
        let g = fx();
        let mut o = g.framer(OutStream::Stdout);
        o.push(b"-----BEGIN PRIVATE KEY-----\nsecretbody\nstill secret\n")
            .unwrap();
        o.close().unwrap();
        assert!(
            g.texts().iter().all(|t| t == "[REDACTED:pattern]"),
            "{:?}",
            g.texts()
        );
    }

    #[test]
    fn an_oversized_line_is_replaced_wholesale_and_neighbours_survive() {
        let f = fx();
        let mut o = f.framer(OutStream::Stdout);
        o.push(b"first\n").unwrap();
        o.push("x".repeat(70_000).as_bytes()).unwrap();
        o.push(b"tail-of-the-long-line\nlast\n").unwrap();
        o.close().unwrap();
        let v = f.out();
        let texts = f.texts();
        assert_eq!(texts[0], "first");
        assert_eq!(texts[1], "[TRUNCATED:oversized-line]");
        assert!(texts
            .iter()
            .all(|t| !t.contains("xxxx") && !t.contains("tail-of")));
        let long = v
            .iter()
            .find(|r| r["attrs"]["text"] == "[TRUNCATED:oversized-line]")
            .unwrap();
        assert_eq!(long["attrs"]["truncated"], true);
        assert_eq!(long["attrs"]["bytes"], 70_000 + 21);
    }

    #[test]
    fn a_line_over_the_record_limit_is_cut_after_masking_and_marked() {
        let f = fx();
        let mut o = f.framer(OutStream::Stdout);
        o.push(format!("{}\n", "y".repeat(5000)).as_bytes())
            .unwrap();
        o.close().unwrap();
        let r = &f.out()[0];
        assert_eq!(r["attrs"]["truncated"], true);
        assert_eq!(r["attrs"]["bytes"], 5000);
        assert!(r["attrs"]["text"].as_str().unwrap().len() < 4096);
    }

    #[test]
    fn a_flood_is_rate_limited_and_reported_once() {
        let f = fx();
        let mut o = f.framer(OutStream::Stdout);
        let mut data = String::new();
        for n in 0..520 {
            data.push_str(&format!("line {n}\n"));
        }
        o.push(data.as_bytes()).unwrap();
        f.clock.fetch_add(1000, Ordering::SeqCst);
        o.tick().unwrap();
        o.close().unwrap();
        let v = f.out();
        assert_eq!(
            v.iter()
                .filter(|r| r["event"] == "process.output.line")
                .count(),
            500
        );
        let report = v
            .iter()
            .find(|r| r["event"] == "process.output.suppressed")
            .unwrap();
        assert_eq!(report["attrs"]["dropped"], 20);
    }

    #[test]
    fn an_idle_partial_line_is_written_by_the_tick() {
        let f = fx();
        let mut o = f.framer(OutStream::Stdout);
        o.push(b"prompt> ").unwrap();
        assert!(f.texts().is_empty());
        f.clock.fetch_add(1500, Ordering::SeqCst);
        o.tick().unwrap();
        assert_eq!(f.texts(), ["prompt> "]);
        o.close().unwrap();
        assert_eq!(
            o.push(b"x").unwrap_err().to_string(),
            "output wrapper closed"
        );
    }

    #[test]
    fn signal_levels() {
        let s = Signal::default();
        assert_eq!(signal_level(&s), Level::Info);
        assert_eq!(
            signal_level(&Signal {
                exit_code: Some(0),
                ..Signal::default()
            }),
            Level::Info
        );
        assert_eq!(
            signal_level(&Signal {
                exit_code: Some(1),
                ..Signal::default()
            }),
            Level::Error
        );
        assert_eq!(
            signal_level(&Signal {
                signal: Some("SIGKILL".into()),
                ..Signal::default()
            }),
            Level::Error
        );
        assert_eq!(
            signal_level(&Signal {
                protocol_error: true,
                ..Signal::default()
            }),
            Level::Error
        );
        assert_eq!(
            signal_level(&Signal {
                http_status: Some(503),
                retrying: true,
                ..Signal::default()
            }),
            Level::Warn
        );
        assert_eq!(
            signal_level(&Signal {
                http_status: Some(503),
                ..Signal::default()
            }),
            Level::Error
        );
        assert_eq!(
            signal_level(&Signal {
                http_status: Some(404),
                retrying: true,
                ..Signal::default()
            }),
            Level::Error
        );
        assert_eq!(
            signal_level(&Signal {
                http_status: Some(200),
                ..Signal::default()
            }),
            Level::Info
        );
    }

    #[test]
    fn wrap_output_reads_a_stream_to_its_end() {
        let f = fx();
        wrap_output(
            f.writer.clone(),
            OutStream::Stderr,
            std::io::Cursor::new(b"one\ntwo\nthree".to_vec()),
            None,
        )
        .unwrap();
        assert_eq!(f.texts(), ["one", "two", "three"]);
    }
}
