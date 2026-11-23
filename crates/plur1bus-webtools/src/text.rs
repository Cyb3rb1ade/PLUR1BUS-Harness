//! Charset detection, entity decoding and Markdown sectioning for web tools.

use std::{borrow::Cow, sync::LazyLock};

use encoding_rs::{Encoding, UTF_8, WINDOWS_1252};
use regex::{Captures, Regex};
use serde::Serialize;

static HEADER: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r#"(?i)charset\s*=\s*["']?([A-Za-z0-9_.:-]+)"#).ok());
static META: LazyLock<Option<regex::bytes::Regex>> = LazyLock::new(|| {
    regex::bytes::Regex::new(r#"(?i-u)<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9_.:-]+)"#).ok()
});
static ENTITY: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"&(#(?:[xX][0-9a-fA-F]{1,8}|[0-9]{1,10})|[A-Za-z][A-Za-z0-9]{1,31});").ok()
});
static HEADING: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^(#{1,6}) +([^\r\u{2028}\u{2029}]+?)[\s\u{feff}]*$").ok());

pub fn decode_body(bytes: &[u8], content_type: Option<&str>) -> String {
    let header = content_type
        .and_then(|header| HEADER.as_ref()?.captures(header))
        .and_then(|groups| Encoding::for_label_no_replacement(groups.get(1)?.as_str().as_bytes()));
    let encoding = header
        .or_else(|| Encoding::for_bom(bytes).map(|(encoding, _)| encoding))
        .or_else(|| {
            let groups = META.as_ref()?.captures(&bytes[..bytes.len().min(2048)])?;
            Encoding::for_label_no_replacement(groups.get(1)?.as_bytes())
        })
        .unwrap_or_else(|| {
            if std::str::from_utf8(bytes).is_ok() {
                UTF_8
            } else {
                WINDOWS_1252
            }
        });
    encoding.decode_with_bom_removal(bytes).0.into_owned()
}

fn named(body: &str) -> Option<&'static str> {
    match body {
        "amp" => Some("&"),
        "lt" => Some("<"),
        "gt" => Some(">"),
        "quot" => Some("\""),
        "apos" => Some("'"),
        "nbsp" => Some(" "),
        "copy" => Some("©"),
        "reg" => Some("®"),
        "trade" => Some("™"),
        "mdash" => Some("—"),
        "ndash" => Some("–"),
        "hellip" => Some("…"),
        "laquo" => Some("«"),
        "raquo" => Some("»"),
        "lsquo" => Some("‘"),
        "rsquo" => Some("’"),
        "ldquo" => Some("“"),
        "rdquo" => Some("”"),
        "sbquo" => Some("‚"),
        "bdquo" => Some("„"),
        "euro" => Some("€"),
        "pound" => Some("£"),
        "yen" => Some("¥"),
        "cent" => Some("¢"),
        "sect" => Some("§"),
        "deg" => Some("°"),
        "plusmn" => Some("±"),
        "times" => Some("×"),
        "divide" => Some("÷"),
        "middot" => Some("·"),
        "bull" => Some("•"),
        "larr" => Some("←"),
        "rarr" => Some("→"),
        "uarr" => Some("↑"),
        "darr" => Some("↓"),
        "hearts" => Some("♥"),
        "para" => Some("¶"),
        "frac12" => Some("½"),
        "frac14" => Some("¼"),
        "frac34" => Some("¾"),
        "micro" => Some("µ"),
        "auml" => Some("ä"),
        "ouml" => Some("ö"),
        "uuml" => Some("ü"),
        "Auml" => Some("Ä"),
        "Ouml" => Some("Ö"),
        "Uuml" => Some("Ü"),
        "szlig" => Some("ß"),
        "eacute" => Some("é"),
        "egrave" => Some("è"),
        "agrave" => Some("à"),
        "aacute" => Some("á"),
        "ccedil" => Some("ç"),
        "ntilde" => Some("ñ"),
        "oacute" => Some("ó"),
        "uacute" => Some("ú"),
        "iacute" => Some("í"),
        "ecirc" => Some("ê"),
        "acirc" => Some("â"),
        "ocirc" => Some("ô"),
        "shy" => Some(""),
        "zwj" => Some(""),
        "zwnj" => Some(""),
        "ensp" => Some(" "),
        "emsp" => Some(" "),
        "thinsp" => Some(" "),
        _ => None,
    }
}

pub fn decode_entities(text: &str) -> Cow<'_, str> {
    let Some(pattern) = ENTITY.as_ref() else {
        return Cow::Borrowed(text);
    };
    pattern.replace_all(text, |parts: &Captures<'_>| {
        let body = &parts[1];
        if let Some(number) = body.strip_prefix('#') {
            let parsed = match number.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16),
                None => number.parse(),
            };
            if let Ok(n) = parsed {
                if n == 0 || (0xd800..=0xdfff).contains(&n) {
                    return "�".into();
                }
                if let Some(value) = char::from_u32(n) {
                    return value.to_string();
                }
            }
        } else if let Some(value) = named(body) {
            return value.into();
        }
        parts[0].to_owned()
    })
}

#[derive(Serialize)]
pub struct Section {
    pub id: String,
    pub title: String,
    pub level: usize,
    pub text: String,
    pub tokens: usize,
}

pub fn estimate_tokens(text: &str) -> usize {
    text.encode_utf16().count().div_ceil(4)
}

fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn split_sections(markdown: &str) -> Vec<Section> {
    let mut output = Vec::new();
    let mut lines = Vec::new();
    let mut title = "(start)";
    let mut level = 0;
    let mut fenced = false;
    for line in markdown.split('\n') {
        let fence = line.starts_with("```");
        if fence {
            fenced = !fenced;
        }
        if !fenced && !fence {
            if let Some(heading) = HEADING.as_ref().and_then(|pattern| pattern.captures(line)) {
                push(&mut output, &lines, title, level);
                lines.clear();
                level = heading.get(1).map_or(0, |group| group.as_str().len());
                title = heading.get(2).map_or("", |group| group.as_str());
            }
        }
        lines.push(line);
    }
    push(&mut output, &lines, title, level);
    output
}

fn push(output: &mut Vec<Section>, lines: &[&str], title: &str, level: usize) {
    let text = lines.join("\n");
    let text = text.trim_end_matches(js_space).trim_start_matches('\n');
    if level == 0 && text.trim_matches(js_space).is_empty() {
        return;
    }
    output.push(Section {
        id: format!("s{}", output.len()),
        title: title.into(),
        level,
        text: text.into(),
        tokens: estimate_tokens(text),
    });
}
