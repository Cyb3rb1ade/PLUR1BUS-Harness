use regex::{Captures, Regex};
use std::borrow::Cow;
use std::sync::LazyLock;

const MAX_HTML: usize = 1024 * 1024;
static COMMENT: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?s)<!--.*?(?:-->|$)").ok());
static ACTIVE: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"(?i)</?(script|style|head|title|template|noscript)\b[^>]*>").ok()
});
static LINKS: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?is)<a\b([^>]*)>(.*?)</a\s*>").ok());
static HREF: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r#"(?i)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).ok());
static TAG: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"<[^>]*>").ok());
static BR: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"(?i)<br\s*/?>").ok());
static LIST: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"(?i)<li\b[^>]*>").ok());
static BLOCK: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
    r"(?i)</?(?:address|article|aside|blockquote|body|dd|details|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|main|nav|ol|p|pre|section|table|tbody|thead|tfoot|tr|ul|center)\b[^>]*>"
).ok()
});
static CELL: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"(?i)</(?:td|th)\s*>").ok());
static ENTITY: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i)&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,8});").ok());

fn strip<'a>(s: &'a str, re: &Option<Regex>, replace: &str) -> Cow<'a, str> {
    re.as_ref()
        .map_or(Cow::Borrowed(s), |re| re.replace_all(s, replace))
}

fn entities(raw: &str) -> Cow<'_, str> {
    ENTITY.as_ref().map_or(Cow::Borrowed(raw), |re| {
        re.replace_all(raw, |caps: &Captures<'_>| {
            let key = &caps[1];
            if let Some(digits) = key.strip_prefix('#') {
                let number = if let Some(hex) = digits.strip_prefix(['x', 'X']) {
                    u32::from_str_radix(hex, 16)
                } else {
                    digits.parse()
                };
                return number
                    .ok()
                    .filter(|n| *n != 0)
                    .and_then(char::from_u32)
                    .map(|ch| ch.to_string())
                    .unwrap_or_default();
            }
            let folded;
            let key = if matches!(key, "Auml" | "Ouml" | "Uuml") {
                key
            } else {
                folded = key.to_ascii_lowercase();
                &folded
            };
            match key {
                "amp" => "&",
                "lt" => "<",
                "gt" => ">",
                "quot" => "\"",
                "apos" => "'",
                "nbsp" => " ",
                "copy" => "©",
                "reg" => "®",
                "hellip" => "…",
                "mdash" => "—",
                "ndash" => "–",
                "lsquo" => "‘",
                "rsquo" => "’",
                "ldquo" => "“",
                "rdquo" => "”",
                "euro" => "€",
                "pound" => "£",
                "yen" => "¥",
                "bull" => "•",
                "middot" => "·",
                "laquo" => "«",
                "raquo" => "»",
                "auml" => "ä",
                "ouml" => "ö",
                "uuml" => "ü",
                "Auml" => "Ä",
                "Ouml" => "Ö",
                "Uuml" => "Ü",
                "szlig" => "ß",
                "eacute" => "é",
                "egrave" => "è",
                "agrave" => "à",
                "aacute" => "á",
                "ccedil" => "ç",
                "ntilde" => "ñ",
                "times" => "×",
                "deg" => "°",
                "trade" => "™",
                "sect" => "§",
                "para" => "¶",
                _ => &caps[0],
            }
            .to_owned()
        })
    })
}

fn active(raw: &str) -> String {
    let Some(regex) = &*ACTIVE else {
        return raw.into();
    };
    let mut output = String::new();
    let mut pos = 0;
    let mut skip: Option<String> = None;
    for captures in regex.captures_iter(raw) {
        let Some(tag) = captures.get(0) else { continue };
        let label = captures[1].to_ascii_lowercase();
        if let Some(prior) = &skip {
            if tag.as_str().starts_with("</") && *prior == label {
                skip = None;
                pos = tag.end();
            }
        } else if !tag.as_str().starts_with("</") {
            output.push_str(&raw[pos..tag.start()]);
            skip = Some(label);
        }
    }
    if skip.is_none() {
        output.push_str(&raw[pos..]);
    }
    output
}

pub(super) fn to_text(input: &str) -> String {
    let input = &input[..input.floor_char_boundary(input.len().min(MAX_HTML))];
    let without_comments = strip(input, &COMMENT, "");
    let last_tag = without_comments.rfind('>').map_or(0, |i| i + 1);
    let s = format!(
        "{}{}",
        &without_comments[..last_tag],
        without_comments[last_tag..].replace('<', "&lt;")
    );
    let s = active(&s);
    let s = LINKS.as_ref().map_or(Cow::Borrowed(s.as_str()), |re| {
        re.replace_all(&s, |caps: &Captures<'_>| {
            let target = HREF
                .as_ref()
                .and_then(|re| re.captures(&caps[1]))
                .and_then(|c| (1..=3).find_map(|i| c.get(i).map(|m| m.as_str())))
                .unwrap_or_default();
            let stripped = strip(&caps[2], &TAG, "");
            let label = entities(&stripped)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            let url = entities(target);
            let url = url.trim();
            let Some((scheme, rest)) = url.split_once(':') else {
                return label;
            };
            if !["http", "https", "mailto"]
                .iter()
                .any(|allowed| scheme.eq_ignore_ascii_case(allowed))
            {
                return label;
            }
            let bare = if scheme.eq_ignore_ascii_case("mailto") {
                rest
            } else {
                url
            };
            if label.is_empty() || label == url || label == bare {
                bare.to_owned()
            } else {
                format!("{label} ({url})")
            }
        })
    });
    let s = strip(&s, &BR, "\n");
    let s = strip(&s, &LIST, "\n- ");
    let s = strip(&s, &BLOCK, "\n");
    let s = strip(&s, &CELL, "\t");
    let s = strip(&s, &TAG, "");
    let mut result = String::new();
    let mut empty = false;
    for line in entities(&s).split('\n') {
        let line = line
            .split([' ', '\t', '\u{a0}'])
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if line.trim().is_empty() {
            empty = true;
        } else {
            if !result.is_empty() {
                result.push('\n');
                if empty {
                    result.push('\n');
                }
            }
            result.push_str(line.trim());
            empty = false;
        }
    }
    result
}
