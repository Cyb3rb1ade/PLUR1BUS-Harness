//! Bounded tokenizer for the readable subset of HTML.

use std::collections::HashMap;

use crate::{http::Failure, text::decode_entities};

const MAX_ELEMENTS: usize = 300_000;
const MAX_DEPTH: usize = 200;
const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];
const RAW: &[&str] = &["script", "style", "textarea", "title"];
const INLINE_FORMAT: &[&str] = &[
    "b", "strong", "i", "em", "u", "s", "small", "big", "font", "mark", "sub", "sup",
];
const CLOSES_P: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "div",
    "dl",
    "fieldset",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "ul",
];

pub(super) enum Child {
    Text(String),
    Element(usize),
}

#[derive(Default)]
pub(super) struct Element {
    pub(super) tag: String,
    pub(super) attrs: HashMap<String, String>,
    pub(super) children: Vec<Child>,
    pub(super) frames_content: bool,
}

impl Element {
    pub(super) fn attr(&self, name: &str) -> &str {
        self.attrs.get(name).map_or("", String::as_str)
    }

    pub(super) fn is_main(&self) -> bool {
        self.tag == "main" || self.attr("role") == "main"
    }
}

pub(super) fn is_heading(tag: &str) -> bool {
    matches!(tag.as_bytes(), [b'h', b'1'..=b'6'])
}

pub(super) fn space(c: char) -> bool {
    (c != '\u{85}' && c.is_whitespace()) || c == '\u{feff}'
}

fn scan(s: &str, from: usize, condition: impl Fn(char) -> bool) -> usize {
    s[from..]
        .char_indices()
        .find(|(_, c)| !condition(*c))
        .map_or(s.len(), |(delta, _)| from + delta)
}

fn terminator(s: &str, from: usize, end: &str) -> usize {
    s[from..]
        .find(end)
        .map_or(s.len(), |offset| from + offset + end.len())
}

fn close_until(nodes: &[Element], stack: &mut Vec<usize>, names: &[&str], stop: &[&str]) {
    for index in (1..stack.len()).rev() {
        let tag = nodes[stack[index]].tag.as_str();
        if stop.contains(&tag) {
            return;
        }
        if names.contains(&tag) {
            stack.truncate(index);
            return;
        }
    }
}

fn implied_close(tag: &str, nodes: &[Element], stack: &mut Vec<usize>) {
    let closes_p = CLOSES_P.contains(&tag);
    if closes_p || matches!(tag, "li" | "tr" | "td" | "th") {
        while stack
            .last()
            .is_some_and(|&id| INLINE_FORMAT.contains(&nodes[id].tag.as_str()))
        {
            stack.pop();
        }
    }
    if closes_p {
        while stack.last().is_some_and(|&id| is_heading(&nodes[id].tag)) {
            stack.pop();
        }
        if stack.last().is_some_and(|&id| nodes[id].tag == "p") {
            stack.pop();
        }
    }
    match tag {
        "li" => close_until(nodes, stack, &["li"], &["ul", "ol"]),
        "dt" | "dd" => close_until(nodes, stack, &["dt", "dd"], &["dl"]),
        "tr" => close_until(nodes, stack, &["tr"], &["table"]),
        "td" | "th" => close_until(nodes, stack, &["td", "th"], &["tr", "table"]),
        "option" => close_until(nodes, stack, &["option"], &["select"]),
        _ => {}
    }
}

fn attribute_value(html: &str, at: usize) -> (&str, usize) {
    if let Some(quote @ (b'"' | b'\'')) = html.as_bytes().get(at).copied() {
        let start = at + 1;
        if let Some(delta) = html[start..].find(char::from(quote)) {
            return (&html[start..start + delta], start + delta + 1);
        }
        let end = html[start..]
            .find('>')
            .map_or(html.len(), |delta| start + delta);
        (&html[start..end], end)
    } else {
        let end = scan(html, at, |c| !space(c) && c != '>');
        (&html[at..end], end)
    }
}

fn start_tag(html: &str, at: usize) -> (Element, usize) {
    let mut end = scan(html, at, |c| !space(c) && !matches!(c, '/' | '>'));
    let mut node = Element {
        tag: html[at..end].to_lowercase(),
        ..Element::default()
    };
    loop {
        let start = scan(html, end, |c| space(c) || c == '/');
        match html.as_bytes().get(start) {
            None => return (node, html.len()),
            Some(b'>') => return (node, start + 1),
            _ => {}
        }
        end = scan(html, start, |c| !space(c) && !matches!(c, '=' | '/' | '>'));
        let name = html[start..end].to_lowercase();
        end = scan(html, end, space);
        let value = if html.as_bytes().get(end) == Some(&b'=') {
            let (value, after) = attribute_value(html, scan(html, end + 1, space));
            end = after;
            value
        } else {
            ""
        };
        if name.is_empty() {
            if let Some(c) = html[end..].chars().next() {
                end += c.len_utf8();
            }
        } else {
            node.attrs
                .entry(name)
                .or_insert_with(|| decode_entities(value).into_owned());
        }
    }
}

fn utf16_prefix_end(text: &str, limit: usize) -> usize {
    let mut units = 0;
    for (index, c) in text.char_indices() {
        units += c.len_utf16();
        if units > limit {
            return index;
        }
    }
    text.len()
}

pub(super) fn parse(
    html: &str,
    check: &dyn Fn() -> Result<(), Failure>,
) -> Result<Vec<Element>, Failure> {
    parse_limited(html, check, MAX_ELEMENTS, MAX_DEPTH)
}

fn parse_limited(
    html: &str,
    check: &dyn Fn() -> Result<(), Failure>,
    max_elements: usize,
    max_depth: usize,
) -> Result<Vec<Element>, Failure> {
    let mut nodes = vec![Element {
        tag: "#root".to_owned(),
        ..Element::default()
    }];
    let mut stack = vec![0];
    let mut lower = None;
    let mut at = 0;
    while at < html.len() {
        check()?;
        let Some(&parent) = stack.last() else {
            return Err(Failure::TooLarge);
        };
        if html.as_bytes()[at] != b'<' {
            let end = html[at..].find('<').map_or(html.len(), |n| at + n);
            nodes[parent]
                .children
                .push(Child::Text(decode_entities(&html[at..end]).into_owned()));
            at = end;
            continue;
        }
        if html[at..].starts_with("<!--") {
            at = terminator(html, at + 4, "-->");
            continue;
        }
        match html.as_bytes().get(at + 1) {
            Some(b'!' | b'?') => at = terminator(html, at + 2, ">"),
            Some(b'/')
                if html
                    .as_bytes()
                    .get(at + 2)
                    .is_some_and(u8::is_ascii_alphabetic) =>
            {
                let end = at + utf16_prefix_end(&html[at..], 300);
                let tag_end = scan(&html[..end], at + 2, |c| {
                    !space(c) && !matches!(c, '/' | '>')
                });
                let tag = html[at + 2..tag_end].to_lowercase();
                close_until(&nodes, &mut stack, &[&tag], &[]);
                at = terminator(&html[..end], tag_end, ">");
            }
            Some(letter) if letter.is_ascii_alphabetic() => {
                // The synthetic root does not count as an HTML element.
                if nodes.len() > max_elements {
                    return Err(Failure::TooLarge);
                }
                let (node, end) = start_tag(html, at + 1);
                implied_close(&node.tag, &nodes, &mut stack);
                let Some(&parent) = stack.last() else {
                    return Err(Failure::TooLarge);
                };
                let id = nodes.len();
                nodes[parent].children.push(Child::Element(id));
                nodes.push(node);
                at = end;
                let tag = nodes[id].tag.as_str();
                if RAW.contains(&tag) {
                    let lower = lower.get_or_insert_with(|| html.to_ascii_lowercase());
                    let closing = format!("</{tag}");
                    let end = lower[at..]
                        .find(&closing)
                        .map_or(html.len(), |offset| at + offset);
                    if end > at {
                        let body = &html[at..end];
                        let content = if matches!(tag, "script" | "style") {
                            body.to_owned()
                        } else {
                            decode_entities(body).into_owned()
                        };
                        nodes[id].children.push(Child::Text(content));
                    }
                    at = terminator(html, end, ">");
                } else if !VOID.contains(&tag) {
                    if stack.len() > max_depth {
                        return Err(Failure::TooLarge);
                    }
                    stack.push(id);
                }
            }
            _ => {
                nodes[parent].children.push(Child::Text("<".to_owned()));
                at += 1;
            }
        }
    }
    for id in (0..nodes.len()).rev() {
        check()?;
        nodes[id].frames_content = nodes[id].children.iter().any(|child| {
            if let Child::Element(child) = child {
                let el = &nodes[*child];
                el.is_main() || matches!(el.tag.as_str(), "article" | "h1") || el.frames_content
            } else {
                false
            }
        });
    }
    Ok(nodes)
}

#[cfg(test)]
mod tests {
    use super::{parse, parse_limited, Failure};

    #[test]
    fn the_public_parser_keeps_the_configured_element_and_depth_limits() {
        let check = || Ok(());
        let elements = "<hr>".repeat(300_000);
        assert_eq!(
            parse(&elements, &check).ok().map(|nodes| nodes.len()),
            Some(300_001)
        );
        assert_eq!(
            parse(&(elements + "<hr>"), &check).err(),
            Some(Failure::TooLarge)
        );
        let levels = "<div>".repeat(200);
        assert_eq!(
            parse(&levels, &check).ok().map(|nodes| nodes.len()),
            Some(201)
        );
        assert_eq!(
            parse(&(levels + "<div>"), &check).err(),
            Some(Failure::TooLarge)
        );
    }

    #[test]
    fn html_element_and_nesting_caps_apply_at_the_boundary() -> Result<(), Failure> {
        let check = || Ok(());
        assert_eq!(parse_limited("<hr><hr>", &check, 2, 3)?.len(), 3);
        assert_eq!(
            parse_limited("<hr><hr><hr>", &check, 2, 3).err(),
            Some(Failure::TooLarge)
        );
        let nodes = parse_limited("<div><section><p>ordinary text", &check, 4, 3)?;
        assert_eq!(nodes[3].children.len(), 1);
        assert_eq!(
            parse_limited("<div><section><p><span>ordinary text", &check, 4, 3).err(),
            Some(Failure::TooLarge)
        );
        Ok(())
    }
}
