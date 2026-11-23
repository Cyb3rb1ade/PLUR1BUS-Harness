use super::Mailbox;
use crate::email::{Error, Kind};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Utc};
use serde::Deserialize;

const CRLF: &str = "\r\n";
const FOLD: &str = "\r\n ";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutAttachment {
    pub filename: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInput {
    pub from: Mailbox,
    pub to: String,
    pub subject: String,
    pub text: String,
    pub html: Option<String>,
    pub message_id: String,
    pub date: i64,
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub references: Vec<String>,
    #[serde(default)]
    pub attachments: Vec<OutAttachment>,
}

fn header<'a>(value: &'a str, refusal: &'static str) -> Result<&'a str, Error> {
    if value.contains(['\r', '\n', '\0']) {
        Err(Error::new(Kind::Protocol, refusal))
    } else {
        Ok(value)
    }
}

fn printable(s: &str) -> bool {
    s.bytes().all(|b| matches!(b, 0x20..=0x7e))
}

fn encode_words(value: &str, delimiter: &str) -> String {
    let mut words = Vec::new();
    let mut start = 0;
    for (idx, ch) in value.char_indices() {
        if idx + ch.len_utf8() - start > 45 {
            words.push(format!(
                "=?UTF-8?B?{}?=",
                STANDARD.encode(&value.as_bytes()[start..idx])
            ));
            start = idx;
        }
    }
    if start < value.len() {
        words.push(format!(
            "=?UTF-8?B?{}?=",
            STANDARD.encode(&value.as_bytes()[start..])
        ));
    }
    words.join(delimiter)
}

fn subject(value: &str) -> Result<String, Error> {
    header(value, "refusing header Subject with control characters")?;
    if !printable(value) {
        return Ok(encode_words(value, FOLD));
    }
    if value.len() <= 76 {
        return Ok(value.to_owned());
    }
    let mut lines = Vec::new();
    let mut line = String::new();
    for part in value.split(' ') {
        if part.len() > 900 {
            return Ok(encode_words(value, FOLD));
        }
        if !line.is_empty() && line.len() + 1 + part.len() > 76 {
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(part);
    }
    lines.push(line);
    Ok(lines.join(FOLD))
}

fn encoded_body(bytes: &[u8]) -> String {
    let value = STANDARD.encode(bytes);
    (0..value.len())
        .step_by(76)
        .map(|start| &value[start..(start + 76).min(value.len())])
        .collect::<Vec<_>>()
        .join(CRLF)
}

fn text_entity(subtype: &str, text: &str) -> String {
    format!("Content-Type: text/{subtype}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}", encoded_body(text.as_bytes()))
}

fn safe_boundary(value: String) -> Result<String, Error> {
    if value.is_empty()
        || value.len() > 70
        || value
            .bytes()
            .any(|b| !b.is_ascii_alphanumeric() && !b"._-".contains(&b))
    {
        return Err(Error::new(Kind::Protocol, "invalid MIME boundary"));
    }
    Ok(value)
}

pub fn build(input: &BuildInput, mut boundary: impl FnMut() -> String) -> Result<Vec<u8>, Error> {
    if input.from.address.contains(['\r', '\n', '\0']) || !input.from.address.contains('@') {
        return Err(Error::new(Kind::Protocol, "invalid sender address"));
    }
    let plain = text_entity("plain", &input.text);
    let primary = if let Some(html) = &input.html {
        let alt = safe_boundary(boundary())?;
        let html = text_entity("html", html);
        format!("Content-Type: multipart/alternative; boundary=\"{alt}\"\r\n\r\n--{alt}\r\n{plain}\r\n--{alt}\r\n{html}\r\n--{alt}--")
    } else {
        plain
    };
    let top = if input.attachments.is_empty() {
        primary
    } else {
        let mixed = safe_boundary(boundary())?;
        let mut body = format!(
            "Content-Type: multipart/mixed; boundary=\"{mixed}\"\r\n\r\n--{mixed}\r\n{primary}\r\n"
        );
        for attachment in &input.attachments {
            let name = super::clean_filename(&attachment.filename);
            let kind: String = header(
                &attachment.mime_type,
                "refusing header Content-Type with control characters",
            )?
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || ".+/-".contains(*c))
            .collect();
            if !kind.contains('/') {
                return Err(Error::new(Kind::Protocol, "invalid attachment type"));
            }
            body.push_str(&format!(
                "--{mixed}\r\nContent-Type: {kind}; name=\"{name}\"\r\nContent-Disposition: attachment; filename=\"{name}\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n",
                encoded_body(&attachment.bytes)
            ));
        }
        body.push_str(&format!("--{mixed}--"));
        body
    };
    let from_address = &input.from.address;
    let from = if let Some(name) = input.from.name.as_deref().filter(|s| !s.is_empty()) {
        header(name, "refusing header From with control characters")?;
        let name = if printable(name) {
            name.to_owned()
        } else {
            encode_words(name, " ")
        };
        format!("{name} <{from_address}>")
    } else {
        from_address.clone()
    };
    let to = header(&input.to, "refusing header To with control characters")?;
    let subject = subject(&input.subject)?;
    let date = DateTime::<Utc>::from_timestamp_millis(input.date)
        .map(|time| time.format("%a, %d %b %Y %H:%M:%S GMT").to_string())
        .unwrap_or_else(|| "Invalid Date".into());
    let msg_id = header(
        &input.message_id,
        "refusing header Message-ID with control characters",
    )?;
    let mut result = format!(
        "From: {from}\r\nTo: {to}\r\nSubject: {subject}\r\nDate: {date}\r\nMessage-ID: <{msg_id}>\r\nMIME-Version: 1.0\r\nAuto-Submitted: auto-replied\r\n"
    );
    if let Some(reply) = input.in_reply_to.as_deref().filter(|s| !s.is_empty()) {
        let reply = header(reply, "refusing header In-Reply-To with control characters")?;
        result.push_str(&format!("In-Reply-To: <{reply}>\r\n"));
    }
    if !input.references.is_empty() {
        let references = input
            .references
            .iter()
            .map(|value| {
                header(value, "refusing header References with control characters")
                    .map(|v| format!("<{v}>"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        result.push_str(&format!("References: {}\r\n", references.join(" ")));
    }
    result.push_str(&top);
    result.push_str(CRLF);
    Ok(result.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_values_disallow_line_separators_and_nul() {
        assert_eq!(header("a report", "invalid subject"), Ok("a report"));
        for value in ["a report\n", "a report\r", "a report\0"] {
            assert_eq!(
                header(value, "invalid subject").err().map(|e| e.kind),
                Some(Kind::Protocol)
            );
        }
    }
}
