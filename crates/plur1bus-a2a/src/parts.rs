//! Validate and project 0.3 Parts for the host turn port.
use plur1bus_providers::Json;
use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_parts: usize,
    pub max_text_bytes: usize,
    pub max_file_bytes: usize,
    pub max_data_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_parts: 16,
            max_text_bytes: 64 * 1024,
            max_file_bytes: 256 * 1024,
            max_data_bytes: 64 * 1024,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Invalid(&'static str),
    Unsupported,
    TooLarge(&'static str, &'static str),
    TooMany,
}

impl Error {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Invalid(_) => "invalid",
            Self::Unsupported => "content-type",
            Self::TooLarge(..) => "too-large",
            Self::TooMany => "too-many",
        }
    }

    pub const fn message(self) -> &'static str {
        match self {
            Self::Invalid(message) | Self::TooLarge(message, _) => message,
            Self::Unsupported => "part kind is not supported",
            Self::TooMany => "too many parts",
        }
    }
}

#[derive(Debug)]
pub struct Parsed {
    pub parts: Vec<Json>,
    pub text: String,
}

pub(crate) fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{0085}') || c == '\u{feff}'
}

fn flat(field: &Json, max: usize) -> String {
    let mut units = 0;
    let cleaned: String = field
        .text()
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
                ' '
            } else {
                c
            }
        })
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect();
    cleaned.trim_matches(js_space).to_owned()
}

fn file(part: &Json, limit: usize) -> Result<(Json, String), Error> {
    let f = &part["file"];
    if f.as_object().is_none() {
        return Err(Error::Invalid("file part needs a file object"));
    }
    let name = flat(&f["name"], 256);
    let mime_type = flat(&f["mimeType"], 128);
    let uri = flat(&f["uri"], 2048);
    let encoded = f["bytes"].string().or_else(|| f["data"].string());
    let mut out = Json::object();
    let mut label = String::from("[file");
    for (key, tag, value) in [("name", "name", name), ("mimeType", "mime", mime_type)] {
        if !value.is_empty() {
            label.push_str(&format!(" {tag}={value}"));
            out.set(key, value);
        }
    }
    if encoded.is_none() && uri.is_empty() {
        return Err(Error::Invalid("file part needs bytes or a uri"));
    }
    if !uri.is_empty() {
        out.set("uri", uri.as_str());
    }
    if let Some(encoded) = encoded {
        let compact: String = encoded.chars().filter(|c| !js_space(*c)).collect();
        // Match the source's conservative preflight, then check the grammar without decoding.
        if compact.encode_utf16().count().saturating_mul(3) / 4 > limit {
            return Err(Error::TooLarge("file part is too large", "file-too-large"));
        }
        let payload = compact.trim_end_matches('=');
        let padding = compact.len() - payload.len();
        if !compact.len().is_multiple_of(4)
            || padding > 2
            || !payload
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/'))
        {
            return Err(Error::Invalid("file bytes are not valid base64"));
        }
        label.push_str(&format!(" bytes={}", compact.len() / 4 * 3 - padding));
        out.set("bytes", compact);
    }
    if !uri.is_empty() {
        label.push_str(&format!(" uri={uri}"));
    }
    label.push(']');
    Ok((out, label))
}

pub fn parse(raw: &Json, limits: Limits) -> Result<Parsed, Error> {
    let inputs = raw
        .array()
        .filter(|v| !v.is_empty())
        .ok_or(Error::Invalid("message.parts must be a non-empty array"))?;
    if inputs.len() > limits.max_parts {
        return Err(Error::TooMany);
    }
    let mut parts = Vec::with_capacity(inputs.len());
    let mut texts = Vec::with_capacity(inputs.len());
    let mut text_bytes = 0usize;
    for input in inputs {
        let kind = input["kind"]
            .string()
            .ok_or(Error::Invalid("invalid part"))?;
        let mut part = Json::object();
        part.set("kind", kind);
        match kind {
            "text" => {
                let text = input["text"]
                    .string()
                    .ok_or(Error::Invalid("text part needs a text string"))?;
                text_bytes = text_bytes.saturating_add(text.len());
                if text_bytes > limits.max_text_bytes {
                    return Err(Error::TooLarge(
                        "message text is too large",
                        "text-too-large",
                    ));
                }
                part.set("text", text);
                texts.push(text.to_owned());
            }
            "file" => {
                let (file, label) = file(input, limits.max_file_bytes)?;
                part.set("file", file);
                texts.push(label);
            }
            "data" => {
                let data = &input["data"];
                if data.as_object().is_none() {
                    return Err(Error::Invalid("data part needs a data object"));
                }
                let encoded = data.encode();
                if encoded.len() > limits.max_data_bytes {
                    return Err(Error::TooLarge("data part is too large", "data-too-large"));
                }
                part.set("data", data.clone());
                texts.push(format!("[data] {encoded}"));
            }
            _ => return Err(Error::Unsupported),
        }
        parts.push(part);
    }
    let text = texts.join("\n");
    if text.trim_matches(js_space).is_empty() {
        return Err(Error::Invalid("message text is empty"));
    }
    Ok(Parsed { parts, text })
}
