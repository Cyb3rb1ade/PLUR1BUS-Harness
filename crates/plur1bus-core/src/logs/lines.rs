//! `lines.ts`: streaming line access over an open file: forward and backward iterators and a binary search by timestamp.
//! Memory is bounded by the chunk size and the line cap, never by the file size (D4: a log file may be hundreds of MiB).
//!
//! Rules shared by both directions:
//!  * A line is the bytes up to a `\n` (a trailing `\r` is dropped). Empty lines are skipped.
//!  * An unterminated last line is the writer's half-written line: it is never yielded (not even when it happens to be
//!    valid JSON, because the writer may still be appending to it).
//!  * A line longer than `max_line` is skipped without buffering it and reported once as `too_long`.
//!
//! Reads are positional (`pread` / `seek_read`), so an iterator never moves the file's own cursor.
use std::collections::VecDeque;
use std::fs::File;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Read size of the scans.
pub const CHUNK: usize = 64 * 1024;
/// Longest line that is returned; longer ones are reported as `too_long`.
pub const MAX_LINE: usize = 256 * 1024;
const SEEK_WINDOW: u64 = 64 * 1024;
const PROBE: usize = 4096;
const NL: u8 = 0x0a;
const CR: u8 = 0x0d;

/// One line of a scan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawLine {
    /// The line's text (lossy UTF-8, `\r` dropped); empty when `too_long`.
    pub text: String,
    /// The line exceeded `max_line` and was skipped.
    pub too_long: bool,
}

impl RawLine {
    fn text(text: String) -> RawLine {
        RawLine {
            text,
            too_long: false,
        }
    }

    fn too_long() -> RawLine {
        RawLine {
            text: String::new(),
            too_long: true,
        }
    }
}

/// The bytes a scan read (`ScanStats`); a clone counts into the same total.
#[derive(Clone, Debug, Default)]
pub struct ScanStats(Arc<AtomicU64>);

impl ScanStats {
    /// A zero counter.
    pub fn new() -> ScanStats {
        ScanStats::default()
    }

    /// Bytes read so far.
    pub fn bytes(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }

    fn add(&self, n: usize) {
        self.0.fetch_add(n as u64, Ordering::Relaxed);
    }
}

#[cfg(unix)]
fn read_at_once(file: &File, buf: &mut [u8], pos: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buf, pos)
}

#[cfg(windows)]
fn read_at_once(file: &File, buf: &mut [u8], pos: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, buf, pos)
}

/// Up to `len` bytes at `pos`; fewer when the file ends first.
fn read_at(file: &File, pos: u64, len: usize, stats: Option<&ScanStats>) -> io::Result<Vec<u8>> {
    let mut buf = vec![0u8; len];
    let mut got = 0;
    while got < len {
        match read_at_once(file, &mut buf[got..], pos + got as u64) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    if let Some(stats) = stats {
        stats.add(got);
    }
    buf.truncate(got);
    Ok(buf)
}

fn decode(b: &[u8]) -> String {
    let end = if b.last() == Some(&CR) {
        b.len() - 1
    } else {
        b.len()
    };
    String::from_utf8_lossy(&b[..end]).into_owned()
}

fn is_blank(line: &[u8]) -> bool {
    line.is_empty() || line == [CR]
}

fn push_line(queue: &mut VecDeque<RawLine>, line: &[u8], max_line: usize) {
    if line.len() > max_line {
        queue.push_back(RawLine::too_long());
    } else if !is_blank(line) {
        queue.push_back(RawLine::text(decode(line)));
    }
}

/// Options of [`forward_lines`].
#[derive(Clone, Debug)]
pub struct ForwardOptions {
    /// Where to start: a line start (0 or just after a `\n`).
    pub start: u64,
    /// Where to stop (exclusive).
    pub end: u64,
    /// The line cap; default [`MAX_LINE`].
    pub max_line: usize,
    /// Counts the bytes read.
    pub stats: Option<ScanStats>,
}

impl ForwardOptions {
    /// `[start, end)` with the default cap and no stats.
    pub fn new(start: u64, end: u64) -> ForwardOptions {
        ForwardOptions {
            start,
            end,
            max_line: MAX_LINE,
            stats: None,
        }
    }
}

/// Complete lines of `[start, end)` in file order (see the module doc).
pub struct ForwardLines<'a> {
    file: &'a File,
    pos: u64,
    end: u64,
    max_line: usize,
    stats: Option<ScanStats>,
    carry: Vec<u8>,
    skipping: bool,
    queue: VecDeque<RawLine>,
    failed: Option<io::Error>,
    done: bool,
}

/// `forwardLines(fh, { start, end, maxLine, stats })`.
pub fn forward_lines(file: &File, options: ForwardOptions) -> ForwardLines<'_> {
    ForwardLines {
        file,
        pos: options.start,
        end: options.end,
        max_line: options.max_line,
        stats: options.stats,
        carry: Vec::new(),
        skipping: false,
        queue: VecDeque::new(),
        failed: None,
        done: false,
    }
}

impl ForwardLines<'_> {
    fn fill(&mut self) {
        if self.pos >= self.end {
            self.done = true;
            return;
        }
        let want = usize::try_from((self.end - self.pos).min(CHUNK as u64)).unwrap_or(CHUNK);
        let chunk = match read_at(self.file, self.pos, want, self.stats.as_ref()) {
            Ok(chunk) => chunk,
            Err(e) => {
                self.failed = Some(e);
                self.done = true;
                return;
            }
        };
        if chunk.is_empty() {
            self.done = true;
            return;
        }
        self.pos += chunk.len() as u64;
        let mut from = 0;
        loop {
            let Some(rel) = chunk[from..].iter().position(|b| *b == NL) else {
                if !self.skipping {
                    self.carry.extend_from_slice(&chunk[from..]);
                    if self.carry.len() > self.max_line {
                        self.skipping = true;
                        self.carry.clear();
                        self.queue.push_back(RawLine::too_long());
                    }
                }
                break;
            };
            let nl = from + rel;
            if self.skipping {
                self.skipping = false;
            } else {
                if self.carry.is_empty() {
                    push_line(&mut self.queue, &chunk[from..nl], self.max_line);
                } else {
                    self.carry.extend_from_slice(&chunk[from..nl]);
                    push_line(&mut self.queue, &self.carry, self.max_line);
                }
                self.carry.clear();
            }
            from = nl + 1;
        }
    }
}

impl Iterator for ForwardLines<'_> {
    type Item = io::Result<RawLine>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(line) = self.queue.pop_front() {
                return Some(Ok(line));
            }
            if self.done {
                return self.failed.take().map(Err);
            }
            self.fill();
        }
    }
}

/// The offset just after the last `\n` before `end` (0 when there is none): the end of the last complete line.
pub fn last_line_boundary(file: &File, end: u64, stats: Option<&ScanStats>) -> io::Result<u64> {
    let mut pos = end;
    while pos > 0 {
        let n = pos.min(CHUNK as u64);
        let chunk = read_at(file, pos - n, n as usize, stats)?;
        if let Some(at) = chunk.iter().rposition(|b| *b == NL) {
            return Ok(pos - n + at as u64 + 1);
        }
        pos -= n;
    }
    Ok(0)
}

/// Complete lines before `end`, last to first. A partial last line (no `\n` before `end`) is ignored.
pub struct BackwardLines<'a> {
    file: &'a File,
    pos: u64,
    max_line: usize,
    stats: Option<ScanStats>,
    /// Bytes from `pos` up to (not including) a `\n` that terminates the line they belong to.
    rest: Vec<u8>,
    first: bool,
    skipping: bool,
    queue: VecDeque<RawLine>,
    failed: Option<io::Error>,
    done: bool,
}

/// `backwardLines(fh, { end, maxLine, stats })`.
pub fn backward_lines(
    file: &File,
    end: u64,
    max_line: usize,
    stats: Option<ScanStats>,
) -> io::Result<BackwardLines<'_>> {
    let pos = last_line_boundary(file, end, stats.as_ref())?;
    Ok(BackwardLines {
        file,
        pos,
        max_line,
        stats,
        rest: Vec::new(),
        first: true,
        skipping: false,
        queue: VecDeque::new(),
        failed: None,
        done: false,
    })
}

impl BackwardLines<'_> {
    fn fill(&mut self) {
        if self.pos == 0 {
            // The first line of the file.
            if !self.skipping && !self.rest.is_empty() {
                if self.rest.len() > self.max_line {
                    self.queue.push_back(RawLine::too_long());
                } else if self.rest != [CR] {
                    self.queue.push_back(RawLine::text(decode(&self.rest)));
                }
            }
            self.done = true;
            return;
        }
        let n = self.pos.min(CHUNK as u64);
        let chunk = match read_at(self.file, self.pos - n, n as usize, self.stats.as_ref()) {
            Ok(chunk) => chunk,
            Err(e) => {
                self.failed = Some(e);
                self.done = true;
                return;
            }
        };
        self.pos -= n;
        let mut buf: Vec<u8>;
        if self.skipping {
            let Some(nl) = chunk.iter().rposition(|b| *b == NL) else {
                return; // still inside the over-long line
            };
            self.skipping = false;
            buf = chunk;
            buf.truncate(nl); // the "\n" at `nl` terminates the earlier line
        } else {
            buf = chunk;
            buf.extend_from_slice(&self.rest);
            // The very first chunk ends with the "\n" of the last complete line (last_line_boundary): its terminator.
            if self.first {
                buf.pop();
                self.first = false;
            }
        }
        // `buf` is line content up to an implied terminator; its first element may continue before `pos`.
        let mut to = buf.len();
        while to > 0 {
            let Some(nl) = buf[..to].iter().rposition(|b| *b == NL) else {
                break;
            };
            push_line(&mut self.queue, &buf[nl + 1..to], self.max_line);
            to = nl;
        }
        buf.truncate(to);
        self.rest = buf;
        if self.rest.len() > self.max_line {
            self.rest = Vec::new();
            self.skipping = true;
            self.queue.push_back(RawLine::too_long());
        }
    }
}

impl Iterator for BackwardLines<'_> {
    type Item = io::Result<RawLine>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(line) = self.queue.pop_front() {
                return Some(Ok(line));
            }
            if self.done {
                return self.failed.take().map(Err);
            }
            self.fill();
        }
    }
}

/// The line start at or after `off`: `off` itself at 0 or right after a `\n`, else just after the next `\n`; `size` if none.
pub fn align_forward(
    file: &File,
    off: i64,
    size: u64,
    stats: Option<&ScanStats>,
) -> io::Result<u64> {
    if off <= 0 {
        return Ok(0);
    }
    let off = off as u64;
    if off >= size {
        return Ok(size);
    }
    let mut pos = off - 1;
    while pos < size {
        // small: a probe, not a scan
        let chunk = read_at(
            file,
            pos,
            usize::try_from((size - pos).min(PROBE as u64)).unwrap_or(PROBE),
            stats,
        )?;
        if chunk.is_empty() {
            return Ok(size);
        }
        if let Some(at) = chunk.iter().position(|b| *b == NL) {
            return Ok(pos + at as u64 + 1);
        }
        pos += chunk.len() as u64;
    }
    Ok(size)
}

/// The first line of the text at `at`, a line start: its text, or `None` at the end of the file / for an over-long line.
fn line_at(
    file: &File,
    at: u64,
    size: u64,
    stats: Option<&ScanStats>,
) -> io::Result<Option<String>> {
    let want = usize::try_from(size.saturating_sub(at).min(PROBE as u64)).unwrap_or(PROBE);
    let chunk = read_at(file, at, want, stats)?;
    Ok(chunk
        .iter()
        .position(|b| *b == NL)
        .map(|nl| decode(&chunk[..nl])))
}

/// Binary search for the first line whose timestamp is `>= ts` (`strict: false`) or `> ts` (`strict: true`), by the
/// timestamp `ts_of` reads from a probe line. Timestamps in one file are assumed non-decreasing (one writer, one clock);
/// the result is the start of a window of at most 64 KiB in front of the first such line, so a few lines out of order
/// inside the window are still seen. A probe that cannot be read makes the search give up with 0 (scan from the start).
pub fn seek_by_ts(
    file: &File,
    size: u64,
    ts: &str,
    ts_of: &dyn Fn(&str) -> Option<String>,
    strict: bool,
    stats: Option<&ScanStats>,
) -> io::Result<u64> {
    let (mut lo, mut hi) = (0u64, size);
    while hi - lo > SEEK_WINDOW {
        let mid = lo + (hi - lo) / 2;
        let s = align_forward(file, i64::try_from(mid).unwrap_or(i64::MAX), size, stats)?;
        if s >= hi {
            hi = mid;
            continue;
        }
        let Some(t) = line_at(file, s, size, stats)?.and_then(|line| ts_of(&line)) else {
            return Ok(0);
        };
        if if strict {
            t.as_str() <= ts
        } else {
            t.as_str() < ts
        } {
            lo = s;
        } else {
            hi = mid;
        }
    }
    Ok(lo)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn file_of(data: &[u8]) -> (tempfile::TempDir, File) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.log");
        File::create(&path).unwrap().write_all(data).unwrap();
        let file = File::open(&path).unwrap();
        (dir, file)
    }

    fn tok(lines: Vec<io::Result<RawLine>>) -> Vec<String> {
        lines
            .into_iter()
            .map(|l| {
                let l = l.unwrap();
                if l.too_long {
                    "<long>".to_string()
                } else {
                    l.text
                }
            })
            .collect()
    }

    fn fwd(file: &File, size: u64, max_line: Option<usize>) -> Vec<String> {
        let mut o = ForwardOptions::new(0, size);
        if let Some(m) = max_line {
            o.max_line = m;
        }
        tok(forward_lines(file, o).collect())
    }

    fn bwd(file: &File, size: u64, max_line: Option<usize>) -> Vec<String> {
        tok(
            backward_lines(file, size, max_line.unwrap_or(MAX_LINE), None)
                .unwrap()
                .collect(),
        )
    }

    /// The reference model of `logs-lines.coverage.test.ts`: complete lines only, CR stripped, blank lines skipped,
    /// over-long (raw bytes including the CR) replaced by a marker.
    fn reference(data: &[u8], max_line: usize) -> Vec<String> {
        let mut parts: Vec<&[u8]> = data.split(|b| *b == NL).collect();
        parts.pop();
        parts
            .into_iter()
            .filter_map(|raw| {
                if raw.len() > max_line {
                    Some("<long>".to_string())
                } else if is_blank(raw) {
                    None
                } else {
                    Some(decode(raw))
                }
            })
            .collect()
    }

    /// `lines.test.ts` and the forward/backward cases of the coverage file.
    #[test]
    fn complete_lines_both_ways_and_an_unterminated_last_line_is_ignored() {
        let data = b"one\ntwo\r\n\nthree\nhal";
        let (_d, f) = file_of(data);
        assert_eq!(fwd(&f, data.len() as u64, None), ["one", "two", "three"]);
        assert_eq!(bwd(&f, data.len() as u64, None), ["three", "two", "one"]);
        for t in ["", "half", "\n", "\n\n"] {
            let (_d, f) = file_of(t.as_bytes());
            assert!(fwd(&f, t.len() as u64, None).is_empty(), "{t:?}");
            assert!(bwd(&f, t.len() as u64, None).is_empty(), "{t:?}");
        }
    }

    #[test]
    fn start_end_and_a_shrunken_file() {
        let data = b"one\ntwo\nthree\n";
        let (_d, f) = file_of(data);
        let run = |start, end| tok(forward_lines(&f, ForwardOptions::new(start, end)).collect());
        assert_eq!(run(4, 14), ["two", "three"]);
        assert_eq!(run(0, 9), ["one", "two"]);
        assert_eq!(run(0, 8), ["one", "two"]);
        assert!(run(2, 2).is_empty());
        let (_d, f) = file_of(b"a\nb\npartial");
        assert_eq!(
            tok(forward_lines(&f, ForwardOptions::new(0, 5000)).collect()),
            ["a", "b"]
        );
        let (_d, f) = file_of(b"a\n");
        assert!(forward_lines(&f, ForwardOptions::new(100, 200))
            .next()
            .is_none());
        let (_d, f) = file_of(data);
        assert_eq!(
            tok(backward_lines(&f, 10, MAX_LINE, None).unwrap().collect()),
            ["two", "one"]
        );
        assert_eq!(
            tok(backward_lines(&f, 8, MAX_LINE, None).unwrap().collect()),
            ["two", "one"]
        );
        assert_eq!(
            tok(backward_lines(&f, 4, MAX_LINE, None).unwrap().collect()),
            ["one"]
        );
        assert!(backward_lines(&f, 0, MAX_LINE, None)
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn stats_count_the_bytes_read() {
        let (_d, f) = file_of(b"aa\nbb\n");
        let stats = ScanStats::new();
        let mut o = ForwardOptions::new(0, 6);
        o.stats = Some(stats.clone());
        let _ = forward_lines(&f, o).count();
        assert_eq!(stats.bytes(), 6);
        let stats = ScanStats::new();
        let _ = backward_lines(&f, 6, MAX_LINE, Some(stats.clone()))
            .unwrap()
            .count();
        assert!(stats.bytes() >= 6);
    }

    #[test]
    fn lines_across_chunk_boundaries_come_out_whole_and_in_the_same_set_both_ways() {
        let lines: Vec<String> = (0..3000)
            .map(|i| format!("line-{i}-{}", "x".repeat((i * 37) % 200)))
            .collect();
        let text = lines.join("\n") + "\n";
        assert!(text.len() > 3 * CHUNK);
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(fwd(&f, text.len() as u64, None), lines);
        let mut reversed = lines.clone();
        reversed.reverse();
        assert_eq!(bwd(&f, text.len() as u64, None), reversed);
    }

    #[test]
    fn cr_only_lines_a_multibyte_character_and_a_long_line_at_chunk_boundaries() {
        let text = format!("{}\n\r\nafter\n", "y".repeat(CHUNK - 2));
        assert_eq!(text.find('\r'), Some(CHUNK - 1));
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(
            fwd(&f, text.len() as u64, None),
            ["y".repeat(CHUNK - 2), "after".into()]
        );
        let text = format!("{}€\nnext\n", "a".repeat(CHUNK - 1));
        let (_d, f) = file_of(text.as_bytes());
        let expect = vec![format!("{}€", "a".repeat(CHUNK - 1)), "next".to_string()];
        assert_eq!(fwd(&f, text.len() as u64, None), expect);
        assert_eq!(
            bwd(&f, text.len() as u64, None),
            [expect[1].clone(), expect[0].clone()]
        );
        let mid = "m".repeat(CHUNK * 2 + 10);
        let text = format!("a\n{mid}\nb\n");
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(fwd(&f, text.len() as u64, None), ["a", &mid, "b"]);
        assert_eq!(bwd(&f, text.len() as u64, None), ["b", &mid, "a"]);
        let (l1, l2) = ("a".repeat(CHUNK - 1), "b".repeat(CHUNK - 1));
        let text = format!("{l1}\n{l2}\n");
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(bwd(&f, text.len() as u64, None), [l2.clone(), l1.clone()]);
        assert_eq!(fwd(&f, text.len() as u64, None), [l1, l2]);
    }

    #[test]
    fn an_over_long_line_is_reported_once_and_the_neighbours_survive() {
        let big = "y".repeat(300_000);
        let text = format!("a\n{big}\nb\n");
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(
            fwd(&f, text.len() as u64, Some(100_000)),
            ["a", "<long>", "b"]
        );
        assert_eq!(
            bwd(&f, text.len() as u64, Some(100_000)),
            ["b", "<long>", "a"]
        );
        let text = format!("a\n{}\nb\n", "z".repeat(CHUNK * 3));
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(fwd(&f, text.len() as u64, Some(1000)), ["a", "<long>", "b"]);
        let text = format!("start\nmiddle\n{}\nlast\n", "L".repeat(CHUNK * 3));
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(
            bwd(&f, text.len() as u64, Some(2000)),
            ["last", "<long>", "middle", "start"]
        );
        let text = format!("{}\nlast\n", "F".repeat(CHUNK * 2 + 5));
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(bwd(&f, text.len() as u64, Some(2000)), ["last", "<long>"]);
        // exactly maxLine is kept, one more is too long, the CR counts as a raw byte
        let text = format!(
            "{}\n{}\n{}\r\n{}\r\n",
            "k".repeat(10),
            "k".repeat(11),
            "k".repeat(9),
            "k".repeat(10)
        );
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(
            fwd(&f, text.len() as u64, Some(10)),
            [
                "k".repeat(10),
                "<long>".into(),
                "k".repeat(9),
                "<long>".into()
            ]
        );
    }

    #[test]
    fn an_unterminated_tail_is_never_yielded_as_text() {
        let text = format!("a\n{}", "t".repeat(5000));
        let (_d, f) = file_of(text.as_bytes());
        let out: Vec<RawLine> = forward_lines(&f, {
            let mut o = ForwardOptions::new(0, text.len() as u64);
            o.max_line = 100;
            o
        })
        .map(Result::unwrap)
        .collect();
        // Known asymmetry of the TypeScript source, kept: the forward scan reports an unterminated over-long tail as
        // too long, the backward scan does not (docs/testing/coverage-2026-10.md).
        assert_eq!(
            out.iter()
                .filter(|l| !l.too_long)
                .map(|l| l.text.as_str())
                .collect::<Vec<_>>(),
            ["a"]
        );
        assert_eq!(bwd(&f, text.len() as u64, Some(100)), ["a"]);
        let (_d, f) = file_of(b"{\"ts\":\"x\"}\n{\"ts\":\"y\"}");
        assert_eq!(fwd(&f, 21, None), ["{\"ts\":\"x\"}"]);
    }

    #[test]
    fn nul_and_invalid_utf8_do_not_fail() {
        let (_d, f) = file_of(&[0x61, 0x00, 0xff, 0xfe, 0x0a, 0x62, 0x0a]);
        let out = fwd(&f, 7, None);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1], "b");
        assert!(out[0].starts_with("a\u{0}"));
    }

    #[test]
    fn first_line_handling_of_the_backward_scan() {
        let text = "\r\nabc\n\r\ndef\r\n";
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(bwd(&f, text.len() as u64, None), ["def", "abc"]);
        let text = "first\r\nsecond\n";
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(bwd(&f, text.len() as u64, None), ["second", "first"]);
        let text = "first-line-is-long\nsecond\n";
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(bwd(&f, text.len() as u64, Some(8)), ["second", "<long>"]);
        let text = format!("\r\n{}\n", "q".repeat(CHUNK));
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(bwd(&f, text.len() as u64, None), ["q".repeat(CHUNK)]);
    }

    /// A small deterministic generator (the linear congruential one of the TypeScript test).
    fn prng(seed: u32) -> impl FnMut() -> f64 {
        let mut s = seed;
        move || {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            f64::from(s) / 4_294_967_296.0
        }
    }

    #[test]
    fn forward_and_backward_agree_with_a_reference_model() {
        let mut rnd = prng(20_261_008);
        let alphabet = ["a", "b", "ü", "€", "😀", " ", "\r", "{", "\""];
        let mut random_text = |lines: usize, max_len: f64| {
            let mut out = String::new();
            for _ in 0..lines {
                let n = (rnd() * max_len) as usize;
                for _ in 0..n {
                    out.push_str(alphabet[(rnd() * alphabet.len() as f64) as usize]);
                }
                out.push_str(if rnd() < 0.15 { "\r\n" } else { "\n" });
            }
            out
        };
        let configs: Vec<(String, Option<usize>)> = vec![
            (random_text(200, 12.0), None),
            (random_text(300, 60.0), Some(25)),
            (random_text(1500, 200.0), None),
            (random_text(3000, 120.0), Some(90)),
            ("\n".repeat(500), None),
            ("\r\n".repeat(500), None),
            ("\r".repeat(10) + "\n", None),
        ];
        for (text, max_line) in configs {
            let expected = reference(text.as_bytes(), max_line.unwrap_or(MAX_LINE));
            let (_d, f) = file_of(text.as_bytes());
            assert_eq!(fwd(&f, text.len() as u64, max_line), expected);
            let mut reversed = expected.clone();
            reversed.reverse();
            assert_eq!(bwd(&f, text.len() as u64, max_line), reversed);
        }
        let mut lines: Vec<String> = (0..400)
            .map(|i| format!("row-{i}-{}", "p".repeat(i % 300)))
            .collect();
        lines.insert(150, "G".repeat(CHUNK + 100));
        lines.insert(300, "H".repeat(CHUNK * 2 + 1));
        let text = lines.join("\n") + "\n";
        let expected = reference(text.as_bytes(), 5000);
        assert_eq!(expected.iter().filter(|x| *x == "<long>").count(), 2);
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(fwd(&f, text.len() as u64, Some(5000)), expected);
        let mut reversed = expected;
        reversed.reverse();
        assert_eq!(bwd(&f, text.len() as u64, Some(5000)), reversed);
    }

    #[test]
    fn last_line_boundary_and_align_forward() {
        let (_d, f) = file_of(b"ab\ncd\nef");
        for (end, want) in [(8, 6), (6, 6), (5, 3), (3, 3), (2, 0), (0, 0)] {
            assert_eq!(last_line_boundary(&f, end, None).unwrap(), want, "{end}");
        }
        let text = format!("x\n{}", "y".repeat(CHUNK * 2 + 3));
        let (_d, f) = file_of(text.as_bytes());
        let stats = ScanStats::new();
        assert_eq!(
            last_line_boundary(&f, text.len() as u64, Some(&stats)).unwrap(),
            2
        );
        assert!(stats.bytes() >= text.len() as u64);
        let (_d, f) = file_of("y".repeat(CHUNK + 5).as_bytes());
        assert_eq!(last_line_boundary(&f, (CHUNK + 5) as u64, None).unwrap(), 0);

        let (_d, f) = file_of(b"ab\ncd\nef\n");
        let size = 9;
        for (off, want) in [
            (0, 0),
            (-5, 0),
            (9, 9),
            (19, 9),
            (3, 3),
            (1, 3),
            (2, 3),
            (4, 6),
            (8, 9),
        ] {
            assert_eq!(align_forward(&f, off, size, None).unwrap(), want, "{off}");
        }
        let text = format!("a\n{}", "n".repeat(10_000));
        let (_d, f) = file_of(text.as_bytes());
        let stats = ScanStats::new();
        assert_eq!(
            align_forward(&f, 5, text.len() as u64, Some(&stats)).unwrap(),
            text.len() as u64
        );
        assert!(stats.bytes() >= 9000);
        let text = format!("{}\nx\n", "n".repeat(9000));
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(
            align_forward(&f, 10, text.len() as u64, None).unwrap(),
            9001
        );
        let (_d, f) = file_of(b"abcdef");
        assert_eq!(align_forward(&f, 2, 100, None).unwrap(), 100);
    }

    fn key(i: usize) -> String {
        format!("{i:08}")
    }

    fn ts_of(line: &str) -> Option<String> {
        let at = line.find("\"ts\":\"")? + 6;
        let digits: String = line[at..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        (!digits.is_empty()).then_some(digits)
    }

    fn numbered(n: usize) -> (String, u64) {
        let line = |i: usize| format!("{{\"ts\":\"{}\",\"pad\":\"{}\"}}\n", key(i), "p".repeat(90));
        let text: String = (0..n).map(line).collect();
        (text, line(0).len() as u64)
    }

    /// `seekByTs` of `lines.test.ts` and the coverage file.
    #[test]
    fn seek_by_ts_lands_in_a_bounded_window_in_front_of_the_target() {
        let (text, l) = numbered(3000);
        let (_d, f) = file_of(text.as_bytes());
        let size = text.len() as u64;
        for target in [0usize, 1, 700, 1500, 2999] {
            let off = seek_by_ts(&f, size, &key(target), &ts_of, false, None).unwrap();
            assert!(off <= target as u64 * l, "target {target}: {off}");
            assert!(
                off + 2 * 64 * 1024 >= target as u64 * l,
                "target {target}: {off} too early"
            );
        }
        let late = seek_by_ts(&f, size, &key(99_999), &ts_of, false, None).unwrap();
        assert!(late + 2 * 64 * 1024 >= size && late <= size);
        assert_eq!(
            seek_by_ts(&f, size, "00000000", &ts_of, false, None).unwrap(),
            0
        );
        assert_eq!(seek_by_ts(&f, size, "", &ts_of, false, None).unwrap(), 0);
        let stats = ScanStats::new();
        seek_by_ts(&f, size, &key(1500), &ts_of, false, Some(&stats)).unwrap();
        assert!(
            stats.bytes() > 0 && stats.bytes() < size / 4,
            "{}",
            stats.bytes()
        );
        let (_d, small) = file_of(&text.as_bytes()[..(l * 10) as usize]);
        assert_eq!(
            seek_by_ts(&small, l * 10, &key(5), &ts_of, false, None).unwrap(),
            0
        );
        let (_d, empty) = file_of(b"");
        assert_eq!(
            seek_by_ts(&empty, 0, &key(5), &ts_of, false, None).unwrap(),
            0
        );
    }

    #[test]
    fn seek_by_ts_strict_mode_gives_up_on_unreadable_probes_and_survives_a_giant_tail() {
        let line = |i: usize| format!("{{\"ts\":\"{}\",\"pad\":\"{}\"}}\n", key(i), "p".repeat(90));
        let l = line(0).len() as u64;
        let dup: String = (0..3000).map(|i| line(i / 100)).collect();
        let (_d, f) = file_of(dup.as_bytes());
        let size = dup.len() as u64;
        let lax = seek_by_ts(&f, size, &key(20), &ts_of, false, None).unwrap();
        let strict = seek_by_ts(&f, size, &key(20), &ts_of, true, None).unwrap();
        assert!(lax <= strict && lax <= 20 * 100 * l && strict <= 21 * 100 * l);
        let fat = |i: usize| {
            format!(
                "{{\"ts\":\"{}\",\"pad\":\"{}\"}}\n",
                key(i),
                "x".repeat(5000)
            )
        };
        let text: String = (0..200).map(fat).collect();
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(
            seek_by_ts(&f, text.len() as u64, &key(150), &ts_of, false, None).unwrap(),
            0
        );
        let text = "no timestamp here ".repeat(5) + "\n";
        let text = text.repeat(2000);
        let (_d, f) = file_of(text.as_bytes());
        assert_eq!(
            seek_by_ts(&f, text.len() as u64, &key(1), &ts_of, false, None).unwrap(),
            0
        );
        let tail: String = (0..50).map(line).collect::<String>() + &"g".repeat(400_000) + "\n";
        let (_d, f) = file_of(tail.as_bytes());
        let off = seek_by_ts(&f, tail.len() as u64, &key(10), &ts_of, false, None).unwrap();
        assert!(off <= tail.len() as u64);
    }
}
