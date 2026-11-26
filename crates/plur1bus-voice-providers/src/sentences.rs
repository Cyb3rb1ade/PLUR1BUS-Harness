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

enum Period {
    EndsSentence,
    Abbreviation,
    Ordinal { after_determiner: bool },
}

fn period(text: &str, at: usize, end: usize) -> Period {
    if text[at..end].contains("..") {
        return Period::EndsSentence;
    }
    let start = text[..at].rfind(whitespace).map_or(0, |pos| {
        pos + text[pos..].chars().next().map_or(0, char::len_utf8)
    });
    let token = text[start..at].trim_start_matches(opener);
    if token.len() <= 32
        && (matches_word(ABBREVIATIONS, token)
            || (token.chars().take(2).count() == 1 && token.starts_with(char::is_uppercase)))
    {
        return Period::Abbreviation;
    }
    if token.is_empty() || !token.bytes().all(|byte| byte.is_ascii_digit()) {
        return Period::EndsSentence;
    }
    let previous = text[..start].trim_end_matches(whitespace);
    let determiner = previous
        .rsplit(whitespace)
        .next()
        .unwrap_or_default()
        .trim_start_matches(opener)
        .trim_end_matches([',', ';', ':']);
    let after_determiner = matches_word(DETERMINERS, determiner);
    Period::Ordinal { after_determiner }
}

fn matches_word(list: &str, token: &str) -> bool {
    if token.len() > 32 {
        return false;
    }
    let token = token.to_lowercase();
    list.split_ascii_whitespace().any(|word| word == token)
}

fn ordinal_continues(word: &str, after_determiner: bool) -> bool {
    word.starts_with(|ch: char| ch.is_lowercase() || ch.is_ascii_digit())
        || (after_determiner && word.starts_with(char::is_uppercase))
        || matches_word(MONTHS, word)
}

#[derive(Clone, Copy)]
enum Lookahead {
    Punctuation {
        at: usize,
        first: char,
    },
    Ordinal {
        boundary: usize,
        word: Option<usize>,
        after_determiner: bool,
    },
}

#[derive(Default)]
struct SentenceScan {
    offset: usize,
    has_content: bool,
    lookahead: Option<Lookahead>,
}

const CHECK_INTERVAL: usize = 1024;

impl SentenceScan {
    fn boundary(
        &mut self,
        text: &str,
        check: &impl Fn() -> Result<(), Error>,
    ) -> Result<Option<usize>, Error> {
        let mut visited = 0usize;
        while let Some(ch) = text[self.offset..].chars().next() {
            if visited.is_multiple_of(CHECK_INTERVAL) {
                check()?;
            }
            visited += 1;
            let next = self.offset + ch.len_utf8();
            match self.lookahead {
                Some(Lookahead::Punctuation { at, first }) => {
                    if terminator(ch) || closer(ch) {
                        self.offset = next;
                    } else if !whitespace(ch) {
                        self.lookahead = None;
                    } else {
                        match if first == '.' {
                            period(text, at, self.offset)
                        } else {
                            Period::EndsSentence
                        } {
                            Period::EndsSentence => return Ok(Some(self.offset)),
                            Period::Abbreviation => self.lookahead = None,
                            Period::Ordinal { after_determiner } => {
                                self.lookahead = Some(Lookahead::Ordinal {
                                    boundary: self.offset,
                                    word: None,
                                    after_determiner,
                                });
                            }
                        }
                    }
                }
                Some(Lookahead::Ordinal {
                    boundary,
                    word,
                    after_determiner,
                }) => {
                    if ch.is_alphabetic() || ch.is_ascii_digit() {
                        self.lookahead = Some(Lookahead::Ordinal {
                            boundary,
                            word: word.or(Some(self.offset)),
                            after_determiner,
                        });
                        self.offset = next;
                    } else if word.is_none() && whitespace(ch) {
                        self.offset = next;
                    } else if word.is_some_and(|at| {
                        ordinal_continues(&text[at..self.offset], after_determiner)
                    }) {
                        // The lookahead word belongs to the same sentence. Let
                        // the ordinary scan handle its whitespace and delimiter.
                        self.lookahead = None;
                        self.offset = boundary;
                    } else {
                        return Ok(Some(boundary));
                    }
                }
                None => {
                    if ch == '\n' && self.has_content {
                        return Ok(Some(next));
                    }
                    self.has_content |= !whitespace(ch);
                    if terminator(ch) {
                        self.lookahead = Some(Lookahead::Punctuation {
                            at: self.offset,
                            first: ch,
                        });
                    }
                    self.offset = next;
                }
            }
        }
        Ok(None)
    }
}

#[derive(Default)]
struct Words {
    ends: Vec<usize>,
    word: bool,
    scan: usize,
}

impl Words {
    fn observe(
        &mut self,
        text: &str,
        final_: bool,
        check: &impl Fn() -> Result<(), Error>,
    ) -> Result<(), Error> {
        for (visited, (index, ch)) in text[self.scan..].char_indices().enumerate() {
            if visited.is_multiple_of(CHECK_INTERVAL) {
                check()?;
            }
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
        Ok(())
    }
}

fn emit_windows(
    text: &str,
    ends: &[usize],
    max: usize,
    out: &mut Vec<String>,
    check: &impl Fn() -> Result<(), Error>,
) -> Result<usize, Error> {
    let mut offset = 0;
    let mut consumed = 0;
    while ends.len() - consumed > max {
        check()?;
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
    Ok(offset)
}

pub(crate) struct SentenceWindows {
    text: String,
    scan: SentenceScan,
    words: Words,
    max_words: Option<usize>,
}

impl SentenceWindows {
    pub(crate) fn new(max_words: Option<usize>) -> Self {
        Self {
            text: String::new(),
            scan: SentenceScan::default(),
            words: Words::default(),
            max_words: max_words.filter(|max| *max > 0),
        }
    }

    pub(crate) fn push(
        &mut self,
        delta: &str,
        check: &impl Fn() -> Result<(), Error>,
    ) -> Result<Vec<String>, Error> {
        if delta.len() > MAX_JSON_BYTES {
            return Err(Error::InvalidRequest);
        }
        self.text.push_str(delta);
        let parts = self.drain(false, check)?;
        if self.text.len() > MAX_JSON_BYTES {
            return Err(Error::InvalidRequest);
        }
        Ok(parts)
    }

    pub(crate) fn finish(
        &mut self,
        check: &impl Fn() -> Result<(), Error>,
    ) -> Result<Vec<String>, Error> {
        self.drain(true, check)
    }

    fn drain(
        &mut self,
        final_: bool,
        check: &impl Fn() -> Result<(), Error>,
    ) -> Result<Vec<String>, Error> {
        check()?;
        let mut chunks = Vec::new();
        let mut start = 0;
        while let Some(end) = self.scan.boundary(&self.text[start..], check)? {
            self.emit_sentence(&self.text[start..start + end], &mut chunks, check)?;
            start += end;
            self.scan = SentenceScan::default();
        }
        if start > 0 {
            self.text.drain(..start);
            self.words = Words::default();
        }
        if let Some(max) = self.max_words {
            self.words.observe(&self.text, final_, check)?;
            let cut = emit_windows(&self.text, &self.words.ends, max, &mut chunks, check)?;
            if cut > 0 {
                self.text.drain(..cut);
                self.scan = SentenceScan::default();
                self.words = Words::default();
            }
        }
        if final_ {
            let remainder = std::mem::take(&mut self.text);
            let trimmed = remainder.trim_matches(whitespace);
            if !trimmed.is_empty() {
                chunks.push(trimmed.into());
            }
            self.scan = SentenceScan::default();
            self.words = Words::default();
        }
        check()?;
        Ok(chunks)
    }

    fn emit_sentence(
        &self,
        sentence: &str,
        out: &mut Vec<String>,
        check: &impl Fn() -> Result<(), Error>,
    ) -> Result<(), Error> {
        let sentence = sentence.trim_matches(whitespace);
        let cut = if let Some(max) = self.max_words {
            let mut words = Words::default();
            words.observe(sentence, true, check)?;
            emit_windows(sentence, &words.ends, max, out, check)?
        } else {
            0
        };
        let remaining = sentence[cut..].trim_matches(whitespace);
        if !remaining.is_empty() {
            out.push(remaining.to_owned());
        }
        Ok(())
    }
}

#[cfg(test)]
mod scan_tests {
    use super::{Error, SentenceScan, CHECK_INTERVAL};
    use std::cell::Cell;
    #[test]
    fn scan_observes_cancellation_inside_one_unbroken_delta() {
        let visited = Cell::new(0);
        let mut scan = SentenceScan::default();
        let result = scan.boundary(&"a".repeat(3 * CHECK_INTERVAL), &|| {
            visited.set(visited.get() + 1);
            if visited.get() == 2 {
                Err(Error::Aborted)
            } else {
                Ok(())
            }
        });
        assert_eq!(result, Err(Error::Aborted));
        assert_eq!(scan.offset, CHECK_INTERVAL);
    }
}
