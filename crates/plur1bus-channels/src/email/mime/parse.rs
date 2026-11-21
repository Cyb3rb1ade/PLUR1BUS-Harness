use super::{html, Mailbox};
use base64::{
    alphabet,
    engine::{
        general_purpose::{GeneralPurpose, GeneralPurposeConfig},
        DecodePaddingMode,
    },
    Engine as _,
};
use chrono::DateTime;
use encoding_rs::{Encoding, UTF_8, WINDOWS_1252};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::LazyLock;

const MIME_BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

#[derive(Default)]
pub struct Headers(BTreeMap<String, Vec<String>>);

impl Headers {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.get_all(name).first().map(String::as_str)
    }

    pub fn get_all(&self, name: &str) -> &[String] {
        self.0
            .get(&name.to_ascii_lowercase())
            .map_or(&[], Vec::as_slice)
    }

    fn add(&mut self, name: &str, value: &str) {
        self.0
            .entry(name.to_ascii_lowercase())
            .or_default()
            .push(value.to_owned());
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    pub mime_type: String,
    pub bytes: Vec<u8>,
    pub inline: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FromProblem {
    Missing,
    Duplicate,
    Malformed,
    Multiple,
    Group,
    SenderMismatch,
    DuplicateReturnPath,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedMessage {
    #[serde(skip)]
    pub headers: Headers,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<Mailbox>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_problem: Option<FromProblem>,
    pub to: Vec<Mailbox>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_path: Option<String>,
    pub text: String,
    pub from_html: bool,
    pub attachments: Vec<Attachment>,
    pub skipped_attachments: usize,
    pub is_report: bool,
    pub content_type: String,
}

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ParseOptions {
    pub max_attachment_bytes: usize,
    pub max_parts: usize,
    pub max_depth: usize,
}

impl Default for ParseOptions {
    fn default() -> Self {
        Self {
            max_attachment_bytes: 10 * 1024 * 1024,
            max_parts: 100,
            max_depth: 8,
        }
    }
}

#[derive(Default)]
struct PartType {
    kind: String,
    subtype: String,
    params: BTreeMap<String, String>,
}

impl PartType {
    fn name(&self) -> String {
        format!("{}/{}", self.kind, self.subtype)
    }
}

struct Entity<'a> {
    headers: Headers,
    kind: PartType,
    transfer: String,
    disposition: String,
    filename: Option<String>,
    body: &'a [u8],
}

pub fn parse(bytes: &[u8], options: ParseOptions) -> ParsedMessage {
    let root = entity(bytes);
    let mut walk = Walk {
        attachments: Vec::new(),
        skipped: 0,
        parts: 0,
        report: root.kind.kind == "multipart" && root.kind.subtype == "report",
        options,
    };
    let rendered = walk.render(&root, 0);
    let content_type = root.kind.name();
    let headers = root.headers;
    let (from, from_problem) =
        resolve_from(&headers).map_or_else(|e| (None, Some(e)), |mailbox| (Some(mailbox), None));
    let date = headers.get("date").and_then(|raw| {
        DateTime::parse_from_rfc2822(raw)
            .or_else(|_| DateTime::parse_from_rfc3339(raw))
            .ok()
            .map(|time| time.timestamp_millis())
    });
    let subject = encoded_words(headers.get("subject").unwrap_or_default())
        .split_inclusive(['\r', '\n', '\t'])
        .fold(String::new(), |mut output, part| {
            let plain = part.trim_end_matches(['\r', '\n', '\t']);
            output.push_str(plain);
            if plain.len() != part.len() && !output.ends_with(' ') {
                output.push(' ');
            }
            output
        });
    let message_id = message_ids(headers.get("message-id").unwrap_or_default()).next();
    let in_reply_to = message_ids(headers.get("in-reply-to").unwrap_or_default()).next();
    ParsedMessage {
        message_id,
        in_reply_to,
        references: headers
            .get_all("references")
            .iter()
            .flat_map(|v| message_ids(v))
            .collect(),
        subject: subject.trim().to_owned(),
        from,
        from_problem,
        to: headers
            .get_all("to")
            .iter()
            .flat_map(|v| parse_addresses(v))
            .collect(),
        date,
        return_path: headers.get("return-path").map(str::to_owned),
        text: rendered.text.replace("\r\n", "\n").replace('\0', ""),
        from_html: rendered.from_html,
        attachments: walk.attachments,
        skipped_attachments: walk.skipped,
        is_report: walk.report,
        headers,
        content_type,
    }
}

fn decode_text(bytes: &[u8], charset: Option<&str>) -> String {
    let label = charset.unwrap_or("utf-8").trim().trim_matches('"');
    let charset = if label.is_empty() {
        UTF_8
    } else {
        Encoding::for_label(label.as_bytes()).unwrap_or(WINDOWS_1252)
    };
    charset.decode_with_bom_removal(bytes).0.into_owned()
}

fn base64_decode(bytes: &[u8]) -> Vec<u8> {
    let mut data: Vec<_> = bytes
        .iter()
        .copied()
        .take_while(|b| *b != b'=')
        .filter(|b| b.is_ascii_alphanumeric() || b"+/".contains(b))
        .collect();
    if data.len() % 4 == 1 {
        data.pop();
    }
    MIME_BASE64.decode(&data).unwrap_or_default()
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn hex_decode(input: &[u8], marker: u8, underscore: bool, output: &mut Vec<u8>) {
    let mut cursor = 0;
    while cursor < input.len() {
        let b = input[cursor];
        if b == marker {
            if let Some((high, low)) = input
                .get(cursor + 1)
                .and_then(|b| hex(*b))
                .zip(input.get(cursor + 2).and_then(|b| hex(*b)))
            {
                output.push(high * 16 + low);
                cursor += 3;
                continue;
            }
        }
        output.push(if underscore && b == b'_' { b' ' } else { b });
        cursor += 1;
    }
}

fn quoted_printable(bytes: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(bytes.len());
    for fragment in bytes.split_inclusive(|b| *b == b'\n') {
        let end = fragment.ends_with(b"\n");
        let line = if end {
            let tail = &fragment[..fragment.len() - 1];
            tail.strip_suffix(b"\r").unwrap_or(tail)
        } else {
            fragment
        };
        if let Some(soft) = line.strip_suffix(b"=") {
            hex_decode(soft, b'=', false, &mut output);
        } else {
            let stop = line
                .iter()
                .rposition(|b| !matches!(b, b' ' | b'\t'))
                .map_or(0, |i| i + 1);
            hex_decode(&line[..stop], b'=', false, &mut output);
            if end {
                output.extend_from_slice(b"\r\n");
            }
        }
    }
    output
}

fn encoded_words(input: &str) -> String {
    static WORD: LazyLock<Option<Regex>> = LazyLock::new(|| {
        Regex::new(r"=\?([A-Za-z0-9_-]+)(?:\*[A-Za-z0-9-]+)?\?([bBqQ])\?([^?\s]*)\?=").ok()
    });
    let Some(re) = &*WORD else {
        return input.to_owned();
    };
    let mut output = String::new();
    let mut last = 0;
    for captures in re.captures_iter(input) {
        let Some(full) = captures.get(0) else {
            continue;
        };
        let prefix = &input[last..full.start()];
        if last == 0 || !prefix.trim().is_empty() {
            output.push_str(prefix);
        }
        let bytes = if captures[2].eq_ignore_ascii_case("b") {
            base64_decode(captures[3].as_bytes())
        } else {
            let mut data = Vec::new();
            hex_decode(captures[3].as_bytes(), b'=', true, &mut data);
            data
        };
        output.push_str(&decode_text(&bytes, Some(&captures[1])));
        last = full.end();
    }
    output.push_str(&input[last..]);
    output
}

fn parameters(value: &str) -> (String, BTreeMap<String, String>) {
    let mut parts = Vec::new();
    let mut part = String::new();
    let mut quoted = false;
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' if quoted => part.extend(chars.next()),
            '"' => {
                quoted = !quoted;
                part.push(c);
            }
            ';' if !quoted => parts.push(std::mem::take(&mut part)),
            _ => part.push(c),
        }
    }
    parts.push(part);
    let mut simple = BTreeMap::new();
    let mut spans = BTreeMap::<String, Vec<(u64, String)>>::new();
    let mut parts = parts.into_iter();
    let main = parts.next().unwrap_or_default().trim().to_owned();
    for part in parts {
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .unwrap_or(value)
            .to_owned();
        if let Some((name, rest)) = name.split_once('*') {
            let rest = rest.strip_suffix('*').unwrap_or(rest);
            if !name.is_empty() && (rest.is_empty() || rest.bytes().all(|b| b.is_ascii_digit())) {
                let index = rest.parse().unwrap_or(0);
                spans
                    .entry(name.to_owned())
                    .or_default()
                    .push((index, value));
                continue;
            }
        }
        simple.insert(name, value);
    }
    for (name, mut spans) in spans {
        spans.sort_by_key(|(i, _)| *i);
        let combined = spans.into_iter().map(|(_, part)| part).collect::<String>();
        let value = if let Some((charset, rest)) = combined.split_once('\'') {
            if let Some((_, data)) = rest.split_once('\'') {
                let data: Vec<_> = data.encode_utf16().map(|c| c as u8).collect();
                let mut decoded = Vec::new();
                hex_decode(&data, b'%', false, &mut decoded);
                decode_text(&decoded, Some(charset))
            } else {
                combined
            }
        } else {
            combined
        };
        simple.insert(name, value);
    }
    (main, simple)
}

fn type_of(raw: &str) -> PartType {
    let (value, params) = parameters(raw);
    let lower = value.to_ascii_lowercase();
    let mut tokens = lower.split('/');
    let first = tokens.next().unwrap_or_default();
    let second = tokens.next().unwrap_or_default();
    let good = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b))
    };
    let (kind, subtype) = if good(first) && good(second) {
        (first, second)
    } else {
        ("text", "plain")
    };
    PartType {
        kind: kind.to_owned(),
        subtype: subtype.to_owned(),
        params,
    }
}

fn message_ids(value: &str) -> impl Iterator<Item = String> + '_ {
    static ID: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"<([^<>\s]{1,998})>").ok());
    ID.as_ref()
        .into_iter()
        .flat_map(|re| re.captures_iter(value))
        .map(|m| m[1].to_owned())
}

#[derive(Default)]
struct Item {
    text: String,
    angles: Vec<String>,
}

fn scan(value: &str) -> (Vec<Item>, bool, bool) {
    let mut items = Vec::new();
    let mut item = Item::default();
    let mut angle = None::<String>;
    let mut quote = false;
    let mut comment = 0usize;
    let mut group = false;
    let mut malformed = false;
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if comment > 0 {
            match c {
                '\\' => {
                    chars.next();
                }
                '(' => comment += 1,
                ')' => comment -= 1,
                _ => {}
            }
        } else if quote {
            let out = angle.as_mut().unwrap_or(&mut item.text);
            out.push(c);
            if c == '\\' {
                out.extend(chars.next());
            } else if c == '"' {
                quote = false;
            }
        } else {
            match c {
                '"' => {
                    quote = true;
                    angle.as_mut().unwrap_or(&mut item.text).push(c);
                }
                '(' => {
                    comment = 1;
                    if angle.is_none() {
                        item.text.push(' ');
                    }
                }
                '<' => {
                    malformed |= angle.is_some();
                    angle = Some(String::new());
                }
                '>' => {
                    if let Some(buffer) = angle.take() {
                        item.angles.push(buffer.trim().to_owned());
                        item.text.push(' ');
                    } else {
                        malformed = true;
                    }
                }
                _ if angle.is_some() => {
                    if let Some(angle) = &mut angle {
                        angle.push(c);
                    }
                }
                ':' => {
                    group = true;
                    item.text.push(c);
                }
                ',' | ';' => items.push(std::mem::take(&mut item)),
                _ => item.text.push(c),
            }
        }
    }
    items.push(item);
    items.retain(|it| !it.text.trim().is_empty() || !it.angles.is_empty());
    (
        items,
        group,
        malformed || quote || comment > 0 || angle.is_some(),
    )
}

fn mailbox(item: &Item) -> Option<Mailbox> {
    let (address, name) = match item.angles.as_slice() {
        [angle] => {
            let mut name = item.text.trim();
            let mut unescaped = String::new();
            if let Some(quoted) = name.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
                let mut chars = quoted.chars();
                while let Some(ch) = chars.next() {
                    if ch == '\\' {
                        unescaped.extend(chars.next());
                    } else {
                        unescaped.push(ch);
                    }
                }
                name = &unescaped;
            }
            let decoded = encoded_words(name);
            let name = decoded.trim();
            (angle.as_str(), (!name.is_empty()).then(|| name.to_owned()))
        }
        [] => (item.text.trim(), None),
        _ => return None,
    };
    let (local, domain) = address.split_once('@')?;
    let valid = |part: &str| {
        !part.is_empty()
            && !part
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || "@<>\"(),;:\\[]".contains(c))
    };
    (valid(local) && valid(domain)).then(|| Mailbox {
        name,
        address: address.to_lowercase(),
    })
}

pub fn parse_addresses(value: &str) -> Vec<Mailbox> {
    scan(value).0.iter().filter_map(mailbox).collect()
}

pub fn parse_strict_mailbox(raw: &str) -> Result<Mailbox, FromProblem> {
    let (items, group, malformed) = scan(raw);
    if malformed {
        return Err(FromProblem::Malformed);
    }
    if group {
        return Err(FromProblem::Group);
    }
    match items.as_slice() {
        [item] if item.angles.len() <= 1 => mailbox(item).ok_or(FromProblem::Malformed),
        _ => Err(FromProblem::Multiple),
    }
}

fn resolve_from(headers: &Headers) -> Result<Mailbox, FromProblem> {
    let raw = match headers.get_all("from") {
        [] => return Err(FromProblem::Missing),
        [raw] => raw,
        _ => return Err(FromProblem::Duplicate),
    };
    if headers.get_all("return-path").len() > 1 {
        return Err(FromProblem::DuplicateReturnPath);
    }
    let from = parse_strict_mailbox(raw)?;
    match headers.get_all("sender") {
        [] => Ok(from),
        [sender] if parse_strict_mailbox(sender).is_ok_and(|m| m.address == from.address) => {
            Ok(from)
        }
        _ => Err(FromProblem::SenderMismatch),
    }
}

fn entity(bytes: &[u8]) -> Entity<'_> {
    let split = bytes
        .iter()
        .enumerate()
        .find_map(|(idx, b)| {
            if *b != b'\n' {
                return None;
            }
            let rest = &bytes[idx + 1..];
            if rest.starts_with(b"\n") {
                Some((idx, idx + 2))
            } else if rest.starts_with(b"\r\n") {
                Some((idx, idx + 3))
            } else {
                None
            }
        })
        .unwrap_or((bytes.len(), bytes.len()));
    let block = &bytes[..split.0];
    let decoded;
    let text = if let Ok(utf8) = std::str::from_utf8(block) {
        utf8.trim_start_matches('\u{feff}')
    } else {
        decoded = decode_text(block, Some("windows-1252"));
        &decoded
    };
    let mut unfolded: Vec<String> = Vec::new();
    for line in text.lines().filter(|s| !s.is_empty()) {
        if line.starts_with([' ', '\t']) {
            if let Some(last) = unfolded.last_mut() {
                last.push(' ');
                last.push_str(line.trim());
                continue;
            }
        }
        unfolded.push(line.to_owned());
    }
    let mut headers = Headers::default();
    for line in unfolded {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim();
            if !name.is_empty() && name.bytes().all(|b| matches!(b, 0x21..=0x39 | 0x3b..=0x7e)) {
                headers.add(name, value.trim());
            }
        }
    }
    let kind = type_of(headers.get("content-type").unwrap_or_default());
    let (disposition, disposition_params) =
        parameters(headers.get("content-disposition").unwrap_or_default());
    let filename = disposition_params
        .get("filename")
        .or_else(|| kind.params.get("name"))
        .filter(|s| !s.is_empty())
        .map(|s| encoded_words(s));
    let transfer = headers
        .get("content-transfer-encoding")
        .unwrap_or("7bit")
        .to_ascii_lowercase();
    Entity {
        headers,
        kind,
        disposition: disposition.to_ascii_lowercase(),
        filename,
        transfer,
        body: &bytes[split.1..],
    }
}

fn multipart<'a>(body: &'a [u8], boundary: &str, limit: usize) -> Vec<&'a [u8]> {
    let delimiter = format!("--{boundary}");
    let mut parts = Vec::new();
    let mut start = None::<usize>;
    let mut pos = 0;
    for line in body.split_inclusive(|b| *b == b'\n') {
        let before = pos;
        pos += line.len();
        let Some(rest) = line.strip_prefix(delimiter.as_bytes()) else {
            continue;
        };
        let closing = rest.starts_with(b"--");
        if !closing
            && !rest
                .iter()
                .all(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
        {
            continue;
        }
        if let Some(start) = start.take() {
            let part = &body[start..before];
            let part = part.strip_suffix(b"\n").unwrap_or(part);
            parts.push(part.strip_suffix(b"\r").unwrap_or(part));
        }
        if closing || parts.len() >= limit {
            break;
        }
        start = Some(pos);
    }
    if let Some(start) = start {
        parts.push(&body[start..]);
    }
    parts
}

impl Entity<'_> {
    fn decoded(&self) -> Vec<u8> {
        match self.transfer.as_str() {
            "base64" => base64_decode(self.body),
            "quoted-printable" => quoted_printable(self.body),
            _ => self.body.to_vec(),
        }
    }

    fn mime_is(&self, kind: &str, subtypes: &[&str]) -> bool {
        self.kind.kind == kind && subtypes.contains(&self.kind.subtype.as_str())
    }
}

#[derive(Default)]
struct Rendered {
    text: String,
    has_plain: bool,
    from_html: bool,
}

struct Walk {
    attachments: Vec<Attachment>,
    skipped: usize,
    report: bool,
    parts: usize,
    options: ParseOptions,
}

impl Walk {
    fn render(&mut self, root: &Entity<'_>, depth: usize) -> Rendered {
        self.parts += 1;
        if self.parts > self.options.max_parts || depth > self.options.max_depth.min(64) {
            return Rendered::default();
        }
        if root.kind.kind == "multipart" {
            self.report |= root.kind.subtype == "report";
            let Some(boundary) = root.kind.params.get("boundary").filter(|b| !b.is_empty()) else {
                return Rendered::default();
            };
            let mut rendered = multipart(
                root.body,
                boundary,
                self.options.max_parts.saturating_sub(self.parts),
            )
            .into_iter()
            .map(|body| self.render(&entity(body), depth + 1))
            .collect::<Vec<_>>();
            if root.kind.subtype == "alternative" {
                let best = rendered
                    .iter()
                    .position(|r| r.has_plain)
                    .or_else(|| rendered.iter().rposition(|r| !r.text.trim().is_empty()));
                return match best {
                    Some(index) => rendered.swap_remove(index),
                    None => rendered.pop().unwrap_or_default(),
                };
            }
            let mut combined = Rendered::default();
            for child in rendered.into_iter().filter(|r| !r.text.trim().is_empty()) {
                combined.has_plain |= child.has_plain;
                combined.from_html |= child.from_html;
                if !combined.text.is_empty() {
                    combined.text.push_str("\n\n");
                }
                combined.text.push_str(&child.text);
            }
            combined.from_html &= !combined.has_plain;
            return combined;
        }
        if root.mime_is(
            "message",
            &[
                "delivery-status",
                "disposition-notification",
                "feedback-report",
            ],
        ) {
            self.report = true;
            return Rendered::default();
        }
        if root.mime_is("message", &["rfc822"]) {
            return Rendered::default();
        }
        let body = root.mime_is("text", &["plain", "html"])
            && root.disposition != "attachment"
            && root.filename.is_none();
        if body {
            let text = decode_text(
                &root.decoded(),
                root.kind.params.get("charset").map(String::as_str),
            );
            return if root.kind.subtype == "html" {
                Rendered {
                    text: html::to_text(&text),
                    has_plain: false,
                    from_html: true,
                }
            } else {
                Rendered {
                    text,
                    has_plain: true,
                    from_html: false,
                }
            };
        }
        let size = if root.transfer == "base64" {
            root.body.len().saturating_mul(3) / 4
        } else {
            root.body.len()
        };
        if size <= self.options.max_attachment_bytes {
            let data = root.decoded();
            if data.len() <= self.options.max_attachment_bytes {
                self.attachments.push(Attachment {
                    filename: root.filename.clone(),
                    mime_type: root.kind.name(),
                    bytes: data,
                    inline: root.disposition == "inline",
                });
                return Rendered::default();
            }
        }
        self.skipped += 1;
        Rendered::default()
    }
}
