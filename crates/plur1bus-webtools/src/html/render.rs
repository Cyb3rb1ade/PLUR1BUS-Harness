//! Render the bounded readable HTML tree as Markdown data.

use regex::Regex;
use std::sync::LazyLock;
use url::Url;

use super::tree::{is_heading, space, Child, Element};
use crate::http::Failure;

static BANNER: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i)cookie|consent|gdpr|onetrust|cc-banner|cc-window").ok());
static FURNITURE: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^a-z0-9])(?:side-?bar|widget(?:-area)?s?|share(?:-?bar|-?buttons|-?links)?|sharing|social(?:-?links|-?media|-?share|-?buttons)?|newsletter|subscribe|breadcrumbs?|pager|pagination|page-?nav|advert(?:isement)?s?|ad-?(?:slot|container|banner)|adsbygoogle|related(?:-?posts|-?stories|-?articles)?|recommended|toc|table-of-contents|(?:mw-)?edit-?section|skip-?link|catlinks|print-?footer|masthead|(?:site-?|page-?|post-?)?footer|site-?(?:header|nav))(?:$|[^a-z0-9])").ok()
});
static HIDDEN: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i)display\s*:\s*none|visibility\s*:\s*hidden").ok());
static LANGUAGE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?:^|\s)(?:language|lang)-([A-Za-z0-9_+-]{1,20})").ok());

const DROP: &[&str] = &[
    "script", "style", "noscript", "template", "svg", "iframe", "object", "embed", "canvas",
    "head", "select", "button", "input", "textarea", "form", "nav", "footer", "aside", "dialog",
    "audio", "video", "map",
];
const BLOCK: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "details",
    "dd",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "header",
    "hgroup",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "summary",
    "table",
    "tbody",
    "thead",
    "tfoot",
    "tr",
    "td",
    "th",
    "ul",
    "body",
    "html",
    "#root",
];
const MAX_TABLE_CELLS: usize = 300_000;

pub(super) fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank = false;
    for c in text.chars() {
        if space(c) {
            if !blank {
                out.push(' ');
            }
            blank = true;
        } else {
            out.push(c);
            blank = false;
        }
    }
    out
}

fn tidy(text: &str) -> String {
    let mut out = String::new();
    for line in text.lines() {
        let line = line.trim_matches([' ', '\t']);
        if line.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        let mut blank = false;
        for c in line.chars() {
            if c != ' ' || !blank {
                out.push(c);
            }
            blank = c == ' ';
        }
    }
    out.trim_matches(space).to_owned()
}

fn wrap(text: String, mark: &str) -> String {
    let middle = text.trim_matches(space);
    if middle.is_empty() {
        return text;
    }
    let left = text.len() - text.trim_start_matches(space).len();
    let right = text.trim_end_matches(space).len();
    format!("{}{mark}{middle}{mark}{}", &text[..left], &text[right..])
}

pub(super) fn absolute(raw: &str, base: Option<&Url>, schemes: &[&str]) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    let raw = raw.trim_matches(space);
    let url = base
        .map_or_else(|| Url::parse(raw), |base| base.join(raw))
        .ok()?;
    schemes.contains(&url.scheme()).then(|| url.into())
}

pub(super) fn hidden(el: &Element) -> bool {
    el.attrs.contains_key("hidden")
        || el.attr("aria-hidden") == "true"
        || HIDDEN
            .as_ref()
            .is_some_and(|rule| rule.is_match(el.attr("style")))
}

pub(super) fn raw_text(nodes: &[Element], id: usize, out: &mut String) {
    let element = &nodes[id];
    if element.tag == "br" {
        out.push('\n');
        return;
    }
    if DROP.contains(&element.tag.as_str()) && element.tag != "head" {
        return;
    }
    for child in &element.children {
        match child {
            Child::Text(text) => out.push_str(text),
            Child::Element(id) => raw_text(nodes, *id, out),
        }
    }
}

pub(super) struct Renderer<'a> {
    pub(super) nodes: &'a [Element],
    pub(super) base: Option<&'a Url>,
    pub(super) keep: Option<usize>,
    pub(super) keep_header: bool,
}

impl Renderer<'_> {
    fn skip(&self, id: usize) -> bool {
        let el = &self.nodes[id];
        if Some(id) == self.keep || (el.tag == "header" && self.keep_header) {
            return false;
        }
        DROP.contains(&el.tag.as_str())
            || el.tag == "header"
            || hidden(el)
            || matches!(
                el.attr("role"),
                "navigation" | "banner" | "contentinfo" | "dialog"
            )
            || BANNER
                .as_ref()
                .is_some_and(|rule| rule.is_match(el.attr("id")) || rule.is_match(el.attr("class")))
            || (!el.frames_content
                && FURNITURE.as_ref().is_some_and(|rule| {
                    (el.attrs.contains_key("class") || el.attrs.contains_key("id"))
                        && rule.is_match(&format!("{} {}", el.attr("class"), el.attr("id")))
                }))
    }

    fn inline_children(&self, id: usize) -> String {
        self.nodes[id]
            .children
            .iter()
            .map(|child| self.inline(child))
            .collect()
    }

    fn inline(&self, child: &Child) -> String {
        let id = match child {
            Child::Text(text) => return collapse(text),
            Child::Element(id) => *id,
        };
        if self.skip(id) {
            return String::new();
        }
        let el = &self.nodes[id];
        match el.tag.as_str() {
            "br" => "\n".to_owned(),
            "b" | "strong" => wrap(self.inline_children(id), "**"),
            "i" | "em" => wrap(self.inline_children(id), "*"),
            "del" | "s" => wrap(self.inline_children(id), "~~"),
            "code" | "kbd" | "samp" => {
                let mut text = String::new();
                raw_text(self.nodes, id, &mut text);
                let text = collapse(&text);
                if text.trim_matches(space).is_empty() {
                    String::new()
                } else {
                    format!("`{text}`")
                }
            }
            "a" => {
                let text = self.inline_children(id);
                let text = text.trim_matches(space);
                match absolute(el.attr("href"), self.base, &["http", "https", "mailto"]) {
                    Some(href) if !text.is_empty() => format!("[{text}]({href})"),
                    _ => text.to_owned(),
                }
            }
            "img" => {
                let alt = collapse(el.attr("alt"));
                let alt = alt.trim_matches(space);
                match absolute(el.attr("src"), self.base, &["http", "https"]) {
                    Some(src) if !alt.is_empty() => format!("![{alt}]({src})"),
                    _ => String::new(),
                }
            }
            tag if is_heading(tag) || BLOCK.contains(&tag) => {
                format!(" {} ", self.inline_children(id))
            }
            _ => self.inline_children(id),
        }
    }

    pub(super) fn blocks(&self, children: &[Child]) -> Result<Vec<String>, Failure> {
        let mut blocks = Vec::new();
        let mut buffer = String::new();
        for child in children {
            if let Child::Element(id) = child {
                if self.skip(*id) {
                    continue;
                }
                let tag = self.nodes[*id].tag.as_str();
                if is_heading(tag) || BLOCK.contains(&tag) {
                    flush(&mut buffer, &mut blocks);
                    blocks.extend(self.block(*id)?);
                    continue;
                }
            }
            buffer.push_str(&self.inline(child));
        }
        flush(&mut buffer, &mut blocks);
        Ok(blocks)
    }

    fn block(&self, id: usize) -> Result<Vec<String>, Failure> {
        let node = &self.nodes[id];
        let tag = node.tag.as_str();
        let text = match tag {
            "ul" | "ol" => self.list(id, tag == "ol")?,
            "table" => return self.table(id),
            "pre" => {
                let first_code = node
                    .children
                    .iter()
                    .find_map(|child| as_node(child).filter(|&id| self.nodes[id].tag == "code"));
                let class = first_code
                    .and_then(|id| self.nodes[id].attrs.get("class"))
                    .map_or(node.attr("class"), String::as_str);
                let lang = LANGUAGE
                    .as_ref()
                    .and_then(|regex| regex.captures(class))
                    .and_then(|parts| parts.get(1))
                    .map_or("", |lang| lang.as_str());
                let mut body = String::new();
                raw_text(self.nodes, id, &mut body);
                let body = body
                    .strip_prefix('\n')
                    .unwrap_or(&body)
                    .trim_end_matches(space);
                if body.is_empty() {
                    String::new()
                } else {
                    format!("```{lang}\n{body}\n```")
                }
            }
            "blockquote" => {
                let body = self.blocks(&node.children)?.join("\n\n");
                if body.is_empty() {
                    String::new()
                } else {
                    body.split('\n')
                        .map(|line| {
                            if line.is_empty() {
                                ">".to_owned()
                            } else {
                                format!("> {line}")
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                }
            }
            "hr" => "---".to_owned(),
            "dt" => wrap(tidy(&self.inline_children(id)), "**"),
            _ if is_heading(tag) => {
                let text = tidy(&self.inline_children(id)).replace('\n', " ");
                if text.is_empty() {
                    String::new()
                } else {
                    format!(
                        "{} {text}",
                        "#".repeat(usize::from(tag.as_bytes()[1] - b'0'))
                    )
                }
            }
            _ => return self.blocks(&node.children),
        };
        Ok(nonempty(text))
    }

    fn list(&self, id: usize, ordered: bool) -> Result<String, Failure> {
        let mut lines = Vec::new();
        for li in self.nodes[id].children.iter().filter_map(as_node) {
            if self.nodes[li].tag != "li" || self.skip(li) {
                continue;
            }
            let body = self.blocks(&self.nodes[li].children)?.join("\n");
            if body.is_empty() {
                continue;
            }
            let mark = if ordered {
                format!("{}. ", lines.len() + 1)
            } else {
                "- ".to_owned()
            };
            let pad = " ".repeat(mark.len());
            let lines_in_item = body.split('\n').enumerate().map(|(index, line)| {
                if index == 0 {
                    format!("{mark}{line}")
                } else if line.is_empty() {
                    String::new()
                } else {
                    format!("{pad}{line}")
                }
            });
            lines.push(lines_in_item.collect::<Vec<_>>().join("\n"));
        }
        Ok(lines.join("\n"))
    }

    fn table(&self, id: usize) -> Result<Vec<String>, Failure> {
        let mut rows = Vec::new();
        self.rows(id, &mut rows);
        if rows
            .iter()
            .any(|&row| self.cells(row).any(|cell| self.has_layout_content(cell)))
        {
            let mut out = Vec::new();
            for row in rows {
                for cell in self.cells(row) {
                    out.extend(self.blocks(&self.nodes[cell].children)?);
                }
            }
            return Ok(out);
        }
        let mut pending: Vec<usize> = Vec::new();
        let mut grid = Vec::new();
        let mut width = 0;
        for row in rows {
            let mut cells = Vec::new();
            for cell in self.cells(row) {
                place_pending(&mut cells, &mut pending);
                let node = &self.nodes[cell];
                let colspan = span(node.attr("colspan"));
                let rowspan = span(node.attr("rowspan"));
                let first = cells.len();
                let end = first + colspan;
                if end > MAX_TABLE_CELLS {
                    return Err(Failure::TooLarge);
                }
                cells.push(
                    tidy(&self.inline_children(cell))
                        .replace('\n', " ")
                        .replace('|', "\\|"),
                );
                cells.resize(end, String::new());
                if rowspan > 1 {
                    if pending.len() < end {
                        pending.resize(end, 0);
                    }
                    pending[first..end].fill(rowspan - 1);
                }
            }
            place_pending(&mut cells, &mut pending);
            if !cells.is_empty() {
                width = width.max(cells.len());
                if width.saturating_mul(grid.len() + 1) > MAX_TABLE_CELLS {
                    return Err(Failure::TooLarge);
                }
                grid.push(cells);
            }
        }
        if grid.is_empty() {
            return Ok(Vec::new());
        }
        grid.insert(1, vec!["---".to_owned(); width]);
        let table = grid
            .into_iter()
            .map(|mut row| {
                row.resize(width, String::new());
                format!("| {} |", row.join(" | "))
            })
            .collect::<Vec<_>>()
            .join("\n");
        let mut blocks = Vec::new();
        if let Some(caption) = self.nodes[id]
            .children
            .iter()
            .filter_map(as_node)
            .find(|&id| self.nodes[id].tag == "caption")
        {
            blocks.extend(nonempty(
                tidy(&self.inline_children(caption)).replace('\n', " "),
            ));
        }
        blocks.push(table);
        Ok(blocks)
    }

    fn rows(&self, id: usize, rows: &mut Vec<usize>) {
        for child in self.nodes[id].children.iter().filter_map(as_node) {
            match self.nodes[child].tag.as_str() {
                "tr" => rows.push(child),
                "thead" | "tbody" | "tfoot" => self.rows(child, rows),
                _ => {}
            }
        }
    }

    fn cells(&self, row: usize) -> impl Iterator<Item = usize> + '_ {
        self.nodes[row]
            .children
            .iter()
            .filter_map(as_node)
            .filter(|&id| matches!(self.nodes[id].tag.as_str(), "td" | "th"))
    }

    fn has_layout_content(&self, id: usize) -> bool {
        self.nodes[id]
            .children
            .iter()
            .filter_map(as_node)
            .any(|child| {
                let tag = self.nodes[child].tag.as_str();
                tag == "table" || is_heading(tag) || self.has_layout_content(child)
            })
    }
}

pub(super) fn as_node(child: &Child) -> Option<usize> {
    match child {
        Child::Element(id) => Some(*id),
        Child::Text(_) => None,
    }
}

fn span(value: &str) -> usize {
    let value = value
        .trim_start_matches(space)
        .strip_prefix('+')
        .unwrap_or(value.trim_start_matches(space));
    let end = value
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(value.len());
    value[..end]
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && *n > 1.0)
        .map_or(1, |n| n.min(100.0) as usize)
}

fn place_pending(out: &mut Vec<String>, pending: &mut [usize]) {
    while let Some(remaining) = pending
        .get_mut(out.len())
        .filter(|remaining| **remaining > 0)
    {
        *remaining -= 1;
        out.push(String::new());
    }
}

fn nonempty(text: String) -> Vec<String> {
    if text.is_empty() {
        Vec::new()
    } else {
        vec![text]
    }
}

fn flush(buffer: &mut String, blocks: &mut Vec<String>) {
    blocks.extend(nonempty(tidy(buffer)));
    buffer.clear();
}
