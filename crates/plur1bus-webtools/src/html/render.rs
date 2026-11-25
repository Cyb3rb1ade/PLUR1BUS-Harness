//! Render the bounded readable HTML tree as Markdown data.

use regex::Regex;
use std::{cell::Cell, sync::LazyLock};
use url::Url;

use super::{
    tree::{is_heading, space, Child, Element},
    units,
};
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

pub(super) fn raw_text(
    nodes: &[Element],
    id: usize,
    emit: &mut impl FnMut(&str) -> Result<(), Failure>,
    check: &dyn Fn() -> Result<(), Failure>,
) -> Result<(), Failure> {
    check()?;
    let element = &nodes[id];
    if element.tag == "br" {
        return emit("\n");
    }
    if DROP.contains(&element.tag.as_str()) && element.tag != "head" {
        return Ok(());
    }
    for child in &element.children {
        check()?;
        match child {
            Child::Text(text) => emit(text)?,
            Child::Element(id) => raw_text(nodes, *id, emit, check)?,
        }
    }
    Ok(())
}

struct Reservation<'a> {
    live: &'a Cell<usize>,
    held: usize,
    limit: usize,
}

impl<'a> Reservation<'a> {
    fn new(renderer: &'a Renderer<'_>) -> Self {
        Self {
            live: &renderer.live_units,
            held: 0,
            limit: renderer.max_units,
        }
    }

    fn reserve(&mut self, units: usize) -> Result<(), Failure> {
        let next = self.live.get().saturating_add(units);
        if next > self.limit {
            return Err(Failure::TooLarge);
        }
        self.live.set(next);
        self.held += units;
        Ok(())
    }

    fn release(&mut self, units: usize) {
        self.live.set(self.live.get() - units);
        self.held -= units;
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        self.release(self.held);
    }
}

struct Output<'a> {
    text: String,
    memory: Reservation<'a>,
}

impl<'a> Output<'a> {
    fn new(renderer: &'a Renderer<'_>) -> Self {
        Self {
            text: String::new(),
            memory: Reservation::new(renderer),
        }
    }

    fn push(&mut self, piece: &str) -> Result<(), Failure> {
        self.memory.reserve(units(piece))?;
        self.text.push_str(piece);
        Ok(())
    }

    fn into_text(self) -> String {
        self.text
    }
}

struct Blocks<'a> {
    items: Vec<String>,
    memory: Reservation<'a>,
}

impl<'a> Blocks<'a> {
    fn new(renderer: &'a Renderer<'_>) -> Self {
        Self {
            items: Vec::new(),
            memory: Reservation::new(renderer),
        }
    }

    fn push(&mut self, text: String) -> Result<(), Failure> {
        if !text.is_empty() {
            let separator = if self.items.is_empty() { 0 } else { 2 };
            self.memory
                .reserve(units(&text).saturating_add(separator))?;
            self.items.push(text);
        }
        Ok(())
    }

    fn extend(&mut self, items: Vec<String>) -> Result<(), Failure> {
        for text in items {
            self.push(text)?;
        }
        Ok(())
    }

    fn into_items(self) -> Vec<String> {
        self.items
    }
}

pub(super) struct Renderer<'a> {
    pub(super) nodes: &'a [Element],
    pub(super) base: Option<&'a Url>,
    pub(super) keep: Option<usize>,
    pub(super) keep_header: bool,
    pub(super) max_units: usize,
    pub(super) live_units: Cell<usize>,
    pub(super) check: &'a dyn Fn() -> Result<(), Failure>,
}

impl Renderer<'_> {
    pub(super) fn bound(&self, units: usize) -> Result<(), Failure> {
        if units > self.max_units {
            return Err(Failure::TooLarge);
        }
        Ok(())
    }

    pub(super) fn join(&self, items: &[String], separator: &str) -> Result<String, Failure> {
        let mut total = units(separator).saturating_mul(items.len().saturating_sub(1));
        for text in items {
            (self.check)()?;
            total = total.saturating_add(units(text));
            self.bound(total)?;
        }
        Ok(items.join(separator))
    }

    fn raw(&self, id: usize) -> Result<String, Failure> {
        let mut output = Output::new(self);
        raw_text(self.nodes, id, &mut |text| output.push(text), self.check)?;
        Ok(output.into_text())
    }

    fn preformatted(&self, id: usize, preserve_newlines: bool) -> Result<String, Failure> {
        // Locate the final content before charging buffers. Whitespace may
        // continue across several inline elements in a preformatted block.
        let mut offset = 0usize;
        let mut content_end = 0usize;
        raw_text(
            self.nodes,
            id,
            &mut |piece| {
                let trimmed = piece.trim_end_matches(space);
                if !trimmed.is_empty() {
                    content_end = offset + trimmed.len();
                }
                offset += piece.len();
                Ok(())
            },
            self.check,
        )?;
        let mut remaining = content_end;
        let mut output = Output::new(self);
        let mut seen_content = false;
        let mut consecutive_breaks = 0usize;
        raw_text(
            self.nodes,
            id,
            &mut |piece| {
                let used = piece.len().min(remaining);
                remaining -= used;
                let piece = &piece[..used];
                let piece = if !seen_content && !piece.is_empty() {
                    seen_content = true;
                    piece.strip_prefix('\n').unwrap_or(piece)
                } else {
                    piece
                };
                if preserve_newlines {
                    return output.push(piece);
                }
                for (index, line) in piece.split_inclusive('\n').enumerate() {
                    if index.is_multiple_of(1024) {
                        (self.check)()?;
                    }
                    let text = line.strip_suffix('\n').unwrap_or(line);
                    if !text.is_empty() {
                        consecutive_breaks = 0;
                        output.push(text)?;
                    }
                    if line.ends_with('\n') && consecutive_breaks < 2 {
                        output.push("\n")?;
                        consecutive_breaks += 1;
                    }
                }
                Ok(())
            },
            self.check,
        )?;
        Ok(output.into_text())
    }

    fn collapse(&self, text: &str) -> Result<String, Failure> {
        let mut out = String::new();
        let mut used = 0usize;
        let mut blank = false;
        for (index, c) in text.chars().enumerate() {
            if index.is_multiple_of(1024) {
                (self.check)()?;
            }
            let whitespace = space(c);
            if !whitespace || !blank {
                let c = if whitespace { ' ' } else { c };
                used += c.len_utf16();
                self.bound(used)?;
                out.push(c);
            }
            blank = whitespace;
        }
        Ok(out)
    }

    fn wrapped(&self, text: String, marker: &str) -> Result<String, Failure> {
        self.bound(units(&text).saturating_add(2 * marker.len()))?;
        Ok(wrap(text, marker))
    }

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

    fn inline_children(&self, id: usize) -> Result<String, Failure> {
        let mut output = Output::new(self);
        for child in &self.nodes[id].children {
            output.push(&self.inline(child)?)?;
        }
        Ok(output.into_text())
    }

    fn inline(&self, child: &Child) -> Result<String, Failure> {
        (self.check)()?;
        let id = match child {
            Child::Text(text) => return self.collapse(text),
            Child::Element(id) => *id,
        };
        if self.skip(id) {
            return Ok(String::new());
        }
        let el = &self.nodes[id];
        let text = match el.tag.as_str() {
            "br" => "\n".to_owned(),
            "b" | "strong" => return self.wrapped(self.inline_children(id)?, "**"),
            "i" | "em" => return self.wrapped(self.inline_children(id)?, "*"),
            "del" | "s" => return self.wrapped(self.inline_children(id)?, "~~"),
            "code" | "kbd" | "samp" => {
                let text = self.collapse(&self.raw(id)?)?;
                if text.trim_matches(space).is_empty() {
                    String::new()
                } else {
                    self.bound(units(&text).saturating_add(2))?;
                    format!("`{text}`")
                }
            }
            "a" => {
                let text = self.inline_children(id)?;
                let text = text.trim_matches(space);
                match absolute(el.attr("href"), self.base, &["http", "https", "mailto"]) {
                    Some(href) if !text.is_empty() => {
                        self.bound(units(text).saturating_add(units(&href)).saturating_add(4))?;
                        format!("[{text}]({href})")
                    }
                    _ => text.to_owned(),
                }
            }
            "img" => {
                let alt = self.collapse(el.attr("alt"))?;
                let alt = alt.trim_matches(space);
                match absolute(el.attr("src"), self.base, &["http", "https"]) {
                    Some(src) if !alt.is_empty() => {
                        self.bound(units(alt).saturating_add(units(&src)).saturating_add(5))?;
                        format!("![{alt}]({src})")
                    }
                    _ => String::new(),
                }
            }
            tag if is_heading(tag) || BLOCK.contains(&tag) => {
                let text = self.inline_children(id)?;
                self.bound(units(&text).saturating_add(2))?;
                format!(" {text} ")
            }
            _ => return self.inline_children(id),
        };
        Ok(text)
    }

    pub(super) fn blocks(
        &self,
        children: &[Child],
        preserve_newlines: bool,
    ) -> Result<Vec<String>, Failure> {
        let mut blocks = Blocks::new(self);
        let mut buffer = Output::new(self);
        for child in children {
            (self.check)()?;
            if let Child::Element(id) = child {
                if self.skip(*id) {
                    continue;
                }
                let tag = self.nodes[*id].tag.as_str();
                if is_heading(tag) || BLOCK.contains(&tag) {
                    blocks.push(tidy(&buffer.into_text()))?;
                    buffer = Output::new(self);
                    blocks.extend(self.block(*id, preserve_newlines)?)?;
                    continue;
                }
            }
            buffer.push(&self.inline(child)?)?;
        }
        blocks.push(tidy(&buffer.into_text()))?;
        Ok(blocks.into_items())
    }

    fn block(&self, id: usize, preserve_newlines: bool) -> Result<Vec<String>, Failure> {
        let node = &self.nodes[id];
        let tag = node.tag.as_str();
        let text = match tag {
            "ul" | "ol" => self.list(id, tag == "ol")?,
            "table" => return self.table(id, preserve_newlines),
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
                let body = self.preformatted(id, preserve_newlines)?;
                let body = body.trim_end_matches(space);
                if body.is_empty() {
                    String::new()
                } else {
                    self.bound(units(body).saturating_add(lang.len()).saturating_add(8))?;
                    format!("```{lang}\n{body}\n```")
                }
            }
            "blockquote" => {
                let body = self.join(&self.blocks(&node.children, true)?, "\n\n")?;
                if body.is_empty() {
                    String::new()
                } else {
                    let mut expanded = units(&body);
                    for line in body.split('\n') {
                        (self.check)()?;
                        expanded = expanded.saturating_add(if line.is_empty() { 1 } else { 2 });
                        self.bound(expanded)?;
                    }
                    let mut result = String::new();
                    for (index, line) in body.split('\n').enumerate() {
                        (self.check)()?;
                        if index > 0 {
                            result.push('\n');
                        }
                        if line.is_empty() {
                            result.push('>');
                        } else {
                            result.push_str("> ");
                            result.push_str(line);
                        }
                    }
                    result
                }
            }
            "hr" => "---".to_owned(),
            "dt" => self.wrapped(tidy(&self.inline_children(id)?), "**")?,
            _ if is_heading(tag) => {
                let text = tidy(&self.inline_children(id)?).replace('\n', " ");
                if text.is_empty() {
                    String::new()
                } else {
                    let prefix = usize::from(tag.as_bytes()[1] - b'0');
                    self.bound(units(&text).saturating_add(prefix + 1))?;
                    format!("{} {text}", "#".repeat(prefix))
                }
            }
            _ => return self.blocks(&node.children, preserve_newlines),
        };
        Ok(nonempty(text))
    }

    fn list(&self, id: usize, ordered: bool) -> Result<String, Failure> {
        let mut output = Output::new(self);
        let mut items = 0usize;
        for li in self.nodes[id].children.iter().filter_map(as_node) {
            (self.check)()?;
            if self.nodes[li].tag != "li" || self.skip(li) {
                continue;
            }
            let body = self.join(&self.blocks(&self.nodes[li].children, true)?, "\n")?;
            if body.is_empty() {
                continue;
            }
            items += 1;
            let mark = if ordered {
                format!("{items}. ")
            } else {
                "- ".to_owned()
            };
            let pad = " ".repeat(mark.len());
            for (index, line) in body.split('\n').enumerate() {
                (self.check)()?;
                if !output.text.is_empty() {
                    output.push("\n")?;
                }
                if index == 0 {
                    output.push(&mark)?;
                } else if !line.is_empty() {
                    output.push(&pad)?;
                }
                output.push(line)?;
            }
        }
        Ok(output.into_text())
    }

    fn table(&self, id: usize, preserve_newlines: bool) -> Result<Vec<String>, Failure> {
        let mut rows = Vec::new();
        self.rows(id, &mut rows)?;
        for &row in &rows {
            for cell in self.cells(row) {
                (self.check)()?;
                if self.has_layout_content(cell)? {
                    let mut out = Blocks::new(self);
                    for row in rows {
                        for cell in self.cells(row) {
                            out.extend(
                                self.blocks(&self.nodes[cell].children, preserve_newlines)?,
                            )?;
                        }
                    }
                    return Ok(out.into_items());
                }
            }
        }
        let mut pending: Vec<usize> = Vec::new();
        let mut grid = Vec::new();
        let mut width = 0;
        let mut content_units = 0usize;
        let mut retained_grid = Reservation::new(self);
        for row in rows {
            (self.check)()?;
            let mut cells = Vec::new();
            for cell in self.cells(row) {
                (self.check)()?;
                place_pending(&mut cells, &mut pending);
                let node = &self.nodes[cell];
                let colspan = span(node.attr("colspan"));
                let rowspan = span(node.attr("rowspan"));
                let first = cells.len();
                let end = checked_cell_end(first, colspan)?;
                let text = tidy(&self.inline_children(cell)?).replace('\n', " ");
                let escaped_units =
                    units(&text).saturating_add(text.bytes().filter(|byte| *byte == b'|').count());
                retained_grid.reserve(escaped_units)?;
                content_units = content_units.saturating_add(escaped_units);
                cells.push(text.replace('|', "\\|"));
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
        let row_count = grid.len() + 1;
        let separators = row_count.saturating_mul(width.saturating_mul(3).saturating_add(1));
        self.bound(
            content_units
                .saturating_add(separators)
                .saturating_add(width.saturating_mul(3))
                .saturating_add(row_count - 1),
        )?;
        retained_grid.reserve(width.saturating_mul(3))?;
        grid.insert(1, vec!["---".to_owned(); width]);
        let mut table = Output::new(self);
        for mut row in grid {
            (self.check)()?;
            row.resize(width, String::new());
            if !table.text.is_empty() {
                table.push("\n")?;
            }
            table.push("| ")?;
            for (index, cell) in row.into_iter().enumerate() {
                if index > 0 {
                    table.push(" | ")?;
                }
                retained_grid.release(units(&cell));
                table.push(&cell)?;
            }
            table.push(" |")?;
        }

        let mut blocks = Vec::new();
        if let Some(caption) = self.nodes[id]
            .children
            .iter()
            .filter_map(as_node)
            .find(|&id| self.nodes[id].tag == "caption")
        {
            blocks.extend(nonempty(
                tidy(&self.inline_children(caption)?).replace('\n', " "),
            ));
        }
        blocks.push(table.into_text());
        Ok(blocks)
    }

    fn rows(&self, id: usize, rows: &mut Vec<usize>) -> Result<(), Failure> {
        for child in self.nodes[id].children.iter().filter_map(as_node) {
            (self.check)()?;
            match self.nodes[child].tag.as_str() {
                "tr" => rows.push(child),
                "thead" | "tbody" | "tfoot" => self.rows(child, rows)?,
                _ => {}
            }
        }
        Ok(())
    }

    fn cells(&self, row: usize) -> impl Iterator<Item = usize> + '_ {
        self.nodes[row]
            .children
            .iter()
            .filter_map(as_node)
            .filter(|&id| matches!(self.nodes[id].tag.as_str(), "td" | "th"))
    }

    fn has_layout_content(&self, id: usize) -> Result<bool, Failure> {
        for child in self.nodes[id].children.iter().filter_map(as_node) {
            (self.check)()?;
            let tag = self.nodes[child].tag.as_str();
            if tag == "table" || is_heading(tag) || self.has_layout_content(child)? {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

pub(super) fn as_node(child: &Child) -> Option<usize> {
    match child {
        Child::Element(id) => Some(*id),
        Child::Text(_) => None,
    }
}

fn checked_cell_end(first: usize, colspan: usize) -> Result<usize, Failure> {
    let end = first.saturating_add(colspan);
    if end > MAX_TABLE_CELLS {
        return Err(Failure::TooLarge);
    }
    Ok(end)
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

#[cfg(test)]
mod tests {
    use super::{checked_cell_end, Blocks, Failure, Output, Renderer};

    #[test]
    fn nested_buffers_share_the_live_render_budget() -> Result<(), Failure> {
        let renderer = Renderer {
            nodes: &[],
            base: None,
            keep: None,
            keep_header: false,
            max_units: 10,
            live_units: std::cell::Cell::new(0),
            check: &|| Ok(()),
        };
        let mut outer = Blocks::new(&renderer);
        outer.push("12345678".into())?;
        let mut child = Output::new(&renderer);
        assert_eq!(child.push("abc"), Err(Failure::TooLarge));
        drop(outer);
        child.push("abc")?;
        assert_eq!(child.text, "abc");
        Ok(())
    }

    #[test]
    fn individual_formatting_operations_reject_growth_before_returning_a_fragment(
    ) -> Result<(), Failure> {
        let check = || Ok(());
        let nodes = super::super::tree::parse(
            "<blockquote><p>Book</p></blockquote><p><b>Book</b></p>",
            &check,
        )?;
        let renderer = Renderer {
            nodes: &nodes,
            base: None,
            keep: None,
            keep_header: false,
            max_units: 5,
            live_units: std::cell::Cell::new(0),
            check: &check,
        };
        assert_eq!(renderer.block(1, false), Err(Failure::TooLarge));
        let bold = nodes
            .iter()
            .position(|el| el.tag == "b")
            .ok_or(Failure::TooLarge)?;
        assert_eq!(
            renderer.inline(&super::Child::Element(bold)),
            Err(Failure::TooLarge)
        );
        assert_eq!(renderer.collapse("Sunday  news"), Err(Failure::TooLarge));
        assert_eq!(
            renderer.join(&["A".into(), "book".into()], " "),
            Err(Failure::TooLarge)
        );
        Ok(())
    }

    #[test]
    fn table_reservation_checks_cells_before_allocating_a_grid() {
        assert_eq!(checked_cell_end(299_999, 1), Ok(300_000));
        assert_eq!(checked_cell_end(299_999, 2), Err(Failure::TooLarge));
    }
}
