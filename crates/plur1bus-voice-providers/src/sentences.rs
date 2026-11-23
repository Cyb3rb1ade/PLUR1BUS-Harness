//! Sentence and word windows for providers that accept complete requests.
use crate::http::{Error, MAX_JSON_BYTES};

const ABBREVIATIONS: &str = "z.b d.h u.a u.u i.d.r o.ä s.o s.u v.a z.t bzw ca dr prof nr hr fr str abb inkl ggf evtl usw etc vgl bsp zzgl max min tel ggü mr mrs ms st vs e.g i.e approx no inc ltd co jr sr mt dept fig";
const MONTHS: &str =
    "januar februar märz april mai juni juli august september oktober november dezember";
const DETERMINERS: &str = "der die das den dem des am im zum zur beim vom auf ein eine einen einem einer mein dein sein unser euer";

fn whitespace(ch: char) -> bool {
    (ch.is_whitespace() && ch != '\u{0085}') || ch == '\u{feff}'
}

fn terminator(ch: char) -> bool {
    ".!?…。！？".contains(ch)
}

fn closer(ch: char) -> bool {
    "\"')]}”’»«“".contains(ch) && ch != '}'
}

fn opener(ch: char) -> bool {
    "(\"'“«[".contains(ch)
}

fn period_stops(text: &str, at: usize, end: usize) -> Option<bool> {
    if text[at..end].contains("..") {
        return Some(true);
    }
    let start = text[..at].rfind(whitespace).map_or(0, |pos| {
        pos + text[pos..].chars().next().map_or(0, char::len_utf8)
    });
    let token = text[start..at].trim_start_matches(opener);
    let lower = token.to_lowercase();
    if lower.is_empty() {
        return Some(true);
    }
    if ABBREVIATIONS
        .split_ascii_whitespace()
        .any(|word| word == lower)
        || (token.chars().count() == 1 && token.starts_with(char::is_uppercase))
    {
        return Some(false);
    }
    if token.bytes().all(|byte| byte.is_ascii_digit()) {
        let tail = text[end..].trim_start_matches(whitespace);
        if tail.is_empty() {
            return None;
        }
        let next = tail
            .split(|ch: char| !ch.is_alphabetic() && !ch.is_ascii_digit())
            .next()
            .unwrap_or_default();
        if next.len() == tail.len() {
            return None;
        }
        if next.is_empty() {
            return Some(true);
        }
        if next.starts_with(|ch: char| ch.is_lowercase() || ch.is_ascii_digit())
            || MONTHS
                .split_ascii_whitespace()
                .any(|word| word == next.to_lowercase())
        {
            return Some(false);
        }
        let previous = text[..start].trim_end_matches(whitespace);
        let determiner = previous
            .rsplit(whitespace)
            .next()
            .unwrap_or_default()
            .trim_start_matches(opener)
            .trim_end_matches([',', ';', ':'])
            .to_lowercase();
        if next.starts_with(char::is_uppercase)
            && DETERMINERS
                .split_ascii_whitespace()
                .any(|word| word == determiner)
        {
            return Some(false);
        }
    }
    Some(true)
}

/// A missing boundary carries the first offset that needs to be revisited.
fn boundary(text: &str, from: usize) -> Result<usize, usize> {
    let mut chars = text[from..].char_indices().peekable();
    while let Some((index, ch)) = chars.next() {
        let at = from + index;
        if ch == '\n' && !text[..at].trim_matches(whitespace).is_empty() {
            return Ok(at + 1);
        }
        if !terminator(ch) {
            continue;
        }
        while chars
            .peek()
            .is_some_and(|(_, c)| terminator(*c) || closer(*c))
        {
            chars.next();
        }
        let Some(&(next, next_char)) = chars.peek() else {
            return Err(at);
        };
        if !whitespace(next_char) {
            continue;
        }
        let end = from + next;
        if ch == '.' {
            match period_stops(text, at, end) {
                Some(false) => continue,
                None => return Err(at),
                Some(true) => {}
            }
        }
        return Ok(end);
    }
    Err(text.len())
}

#[derive(Default)]
struct Words {
    ends: Vec<usize>,
    word: bool,
    scan: usize,
}

impl Words {
    fn observe(&mut self, text: &str, final_: bool) {
        for (index, ch) in text[self.scan..].char_indices() {
            let separated = whitespace(ch);
            if self.word && separated {
                self.ends.push(self.scan + index);
            }
            self.word = !separated;
        }
        if self.word && final_ {
            self.ends.push(text.len());
            self.word = false;
        }
        self.scan = text.len();
    }
}

fn emit_windows(text: &str, ends: &[usize], max: usize, out: &mut Vec<String>) -> usize {
    let mut offset = 0;
    let mut consumed = 0;
    while ends.len() - consumed > max {
        let window = &ends[consumed..consumed + max];
        let choice = (max / 2..max)
            .rev()
            .find(|&idx| text[..window[idx]].ends_with([',', ';', ':', '—', '–', ')']))
            .unwrap_or(max - 1);
        consumed += choice + 1;
        let cut = window[choice];
        out.push(text[offset..cut].trim_matches(whitespace).to_owned());
        offset = cut;
    }
    offset
}

pub(crate) struct SentenceWindows {
    text: String,
    scanned: usize,
    words: Words,
    max_words: Option<usize>,
}

impl SentenceWindows {
    pub(crate) fn new(max_words: Option<usize>) -> Self {
        Self {
            text: String::new(),
            scanned: 0,
            words: Words::default(),
            max_words: max_words.filter(|max| *max > 0),
        }
    }

    pub(crate) fn push(&mut self, delta: &str) -> Result<Vec<String>, Error> {
        if delta.len() > MAX_JSON_BYTES {
            return Err(Error::InvalidRequest);
        }
        self.text.push_str(delta);
        let parts = self.drain(false);
        if self.text.len() > MAX_JSON_BYTES {
            return Err(Error::InvalidRequest);
        }
        Ok(parts)
    }

    pub(crate) fn finish(&mut self) -> Vec<String> {
        self.drain(true)
    }

    fn drain(&mut self, final_: bool) -> Vec<String> {
        let mut chunks = Vec::new();
        let mut start = 0;
        loop {
            match boundary(&self.text[start..], self.scanned) {
                Ok(end) => {
                    self.emit_sentence(&self.text[start..start + end], &mut chunks);
                    start += end;
                    self.scanned = 0;
                }
                Err(scanned) => {
                    self.scanned = scanned;
                    break;
                }
            }
        }
        if start > 0 {
            self.text.drain(..start);
            self.words = Words::default();
        }
        if let Some(max) = self.max_words {
            self.words.observe(&self.text, final_);
            let cut = emit_windows(&self.text, &self.words.ends, max, &mut chunks);
            if cut > 0 {
                self.text.drain(..cut);
                self.scanned = 0;
                self.words = Words::default();
            }
        }
        if final_ {
            let remainder = std::mem::take(&mut self.text);
            let trimmed = remainder.trim_matches(whitespace);
            if !trimmed.is_empty() {
                chunks.push(trimmed.into());
            }
            self.scanned = 0;
            self.words = Words::default();
        }
        chunks
    }

    fn emit_sentence(&self, sentence: &str, out: &mut Vec<String>) {
        let sentence = sentence.trim_matches(whitespace);
        let cut = self.max_words.map_or(0, |max| {
            let mut words = Words::default();
            words.observe(sentence, true);
            emit_windows(sentence, &words.ends, max, out)
        });
        let remaining = sentence[cut..].trim_matches(whitespace);
        if !remaining.is_empty() {
            out.push(remaining.to_owned());
        }
    }
}
