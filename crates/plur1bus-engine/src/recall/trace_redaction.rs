//! Request-local known-value and shared catalogue redaction before trace previews are cut.
//! Deliberately no Debug/Serialize implementation: registry values are never diagnostic data.

use regex::Regex;

pub(crate) struct Redactor {
    forms: Vec<String>,
    patterns: Vec<Regex>,
}

impl Redactor {
    pub(crate) fn new(values: &[String]) -> Self {
        let mut forms = values
            .iter()
            .filter(|value| !value.is_empty())
            .flat_map(|value| secret_forms(value))
            .collect::<Vec<_>>();
        forms.sort_by_key(|form| std::cmp::Reverse(form.len()));
        forms.dedup();
        let patterns = ["pattern", "url"]
            .into_iter()
            .flat_map(plur1bus_log_schema::rule_patterns)
            .map(|pattern| pattern.regex())
            .collect();
        Self { forms, patterns }
    }

    pub(crate) fn redact(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for form in &self.forms {
            out = out.replace(form, "[REDACTED]");
            // Legacy canonical identifiers may already end in a preview cut. A suffix of
            // that identifier matching a registry prefix is hidden as well, even one unit.
            if let Some(prefix) = out.strip_suffix('…') {
                if let Some((offset, _)) = prefix
                    .char_indices()
                    .find(|(offset, _)| form.starts_with(&prefix[*offset..]))
                {
                    out.replace_range(offset.., "[REDACTED]");
                }
            }
        }
        for pattern in &self.patterns {
            out = pattern.replace_all(&out, "[REDACTED]").into_owned();
        }
        out
    }
}

fn secret_forms(value: &str) -> Vec<String> {
    let mut out = vec![value.to_owned()];
    for url in [false, true] {
        let encoded = base64(value.as_bytes(), url);
        out.push(encoded.trim_end_matches('=').to_owned());
        out.push(encoded);
    }
    let mut percent = String::new();
    let mut hex = String::new();
    for byte in value.bytes() {
        hex.push_str(&format!("{byte:02x}"));
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'~' | b'!' | b'\'' | b'(' | b')' | b'*'
            )
        {
            percent.push(char::from(byte));
        } else {
            percent.push_str(&format!("%{byte:02X}"));
        }
    }
    out.extend([percent, hex.to_ascii_uppercase(), hex]);
    if let Ok(quoted) = serde_json::to_string(value) {
        if let Some(escaped) = quoted
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
        {
            out.push(escaped.to_owned());
        }
    }
    out
}

fn base64(bytes: &[u8], url: bool) -> String {
    let alphabet = if url {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    } else {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    };
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = u32::from(chunk[0]) << 16
            | u32::from(*chunk.get(1).unwrap_or(&0)) << 8
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                char::from(alphabet[((n >> (18 - 6 * i)) & 63) as usize])
            } else {
                '='
            });
        }
    }
    out
}
