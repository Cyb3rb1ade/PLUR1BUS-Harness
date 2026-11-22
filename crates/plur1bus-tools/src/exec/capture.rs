//! The bounded capture of one output stream (`tools/sandbox/capture.ts`, `BoundedCapture`): the first `limit` bytes are
//! kept, the rest is drained and dropped, and the registered secret values of the moment the text is read are masked,
//! including one the byte limit would cut in half.
use plur1bus_log_schema::redact::matcher::SecretMatcher;
use std::sync::Arc;

/// The secret values this process holds right now (`knownSecrets`): asked again whenever text is produced, because the
/// set can change while a program runs.
pub type KnownSecrets<'a> = &'a dyn Fn() -> Arc<SecretMatcher>;

/// A UTF-8 byte bound never leaves an incomplete last character.
fn utf8_prefix(text: String, limit: usize) -> String {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn context_bytes(m: &SecretMatcher) -> usize {
    m.max_source_bytes().saturating_sub(1) + 3
}

/// Retains only the prefix of the source plus the context a secret match needs; the excess is counted, not kept.
pub struct BoundedCapture<'a> {
    bytes: Vec<u8>,
    limit: usize,
    retention: usize,
    known: Option<KnownSecrets<'a>>,
    seen: usize,
    discarded: bool,
    /// The stream had more than `limit` bytes, or its text did after masking.
    pub truncated: bool,
}

impl<'a> BoundedCapture<'a> {
    /// A capture of at most `limit` bytes.
    pub fn new(limit: usize, known: Option<KnownSecrets<'a>>) -> Self {
        let extra = known.map_or(0, |k| context_bytes(&k()));
        BoundedCapture {
            bytes: Vec::new(),
            limit,
            retention: limit + extra,
            known,
            seen: 0,
            discarded: false,
            truncated: false,
        }
    }

    /// One chunk of the stream.
    pub fn push(&mut self, chunk: &[u8]) {
        if chunk.len() > self.limit - self.seen {
            self.truncated = true;
        }
        self.seen = self.limit.min(self.seen + chunk.len());
        let room = self.retention.saturating_sub(self.bytes.len());
        if room == 0 {
            if !chunk.is_empty() {
                self.discarded = true;
            }
            return;
        }
        let take = &chunk[..room.min(chunk.len())];
        if take.len() < chunk.len() {
            self.discarded = true;
        }
        self.bytes.extend_from_slice(take);
    }

    /// The text of the stream so far. `complete: false` is a reader that arrives between two writes: only the prefix for
    /// which every byte of a possible match has arrived is shown.
    pub fn text(&mut self, complete: bool) -> String {
        let snapshot = self.known.map(|k| k());
        if let Some(m) = &snapshot {
            // A value registered since the capture began needs more context than was kept.
            if self.discarded && self.limit + context_bytes(m) > self.retention {
                return utf8_prefix(
                    "[output withheld: secret context changed]".to_owned(),
                    self.limit,
                );
            }
        }
        let pending = match &snapshot {
            Some(m) if !complete && m.max_source_bytes() > 0 => m.max_source_bytes() - 1 + 3,
            _ => 0,
        };
        let end = self.limit.min(self.bytes.len().saturating_sub(pending));
        // Process text is decoded with replacement characters, as Node decodes it.
        let prefix = String::from_utf8_lossy(&self.bytes[..end]).into_owned();
        let decoded = match &snapshot {
            Some(m) => {
                let whole = String::from_utf8_lossy(&self.bytes);
                let units = prefix.encode_utf16().count();
                // The window is inside the text by construction; a range the matcher refuses shows nothing.
                m.mask_text_window(&whole, 0, units).unwrap_or_default()
            }
            None => prefix,
        };
        if decoded.len() > self.limit {
            self.truncated = true;
        }
        utf8_prefix(decoded, self.limit)
    }
}
