//! Render escaped text and a small Markdown subset for document templates.
use regex::{Captures, Regex};
use std::sync::LazyLock;

pub fn escape_html(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            other => escaped.push(other),
        }
    }
    escaped
}

static LINK: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"\[([^\]]+)\]\(([^)\s]+)\)").ok());
static ANCHOR: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^#[A-Za-z][A-Za-z0-9:_-]*$").ok());
static CODE: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"`([^`]+)`").ok());
static STRONG: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"\*\*([^*]+)\*\*").ok());
static EMPHASIS: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(^|[^*])\*([^*\s][^*]*)\*").ok());
static FENCE: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"^\s*```").ok());
static HEAD: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"^(#{1,6})\s+(.*)$").ok());
static RULE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^\s*(?:---+|\*\*\*+)\s*$").ok());
static BULLET: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"^\s*[-*]\s+(.*)$").ok());
static NUMBERED: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^\s*[0-9]+[.)]\s+(.*)$").ok());
static QUOTE: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"^\s*>\s?(.*)$").ok());

fn inline(text: &str) -> String {
    let mut rendered = escape_html(text);
    if let Some(links) = &*LINK {
        rendered = links
            .replace_all(&rendered, |caps: &Captures<'_>| {
                let url = &caps[2];
                let permitted = ["http://", "https://"].iter().any(|prefix| {
                    url.get(..prefix.len())
                        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
                }) || ANCHOR.as_ref().is_some_and(|re| re.is_match(url));
                if permitted {
                    format!(
                        "<a href=\"{}\" rel=\"noopener noreferrer\">{}</a>",
                        escape_html(url),
                        &caps[1]
                    )
                } else {
                    caps[1].to_owned()
                }
            })
            .into_owned();
    }
    for (regex, replacement) in [
        (&*CODE, "<code>${1}</code>"),
        (&*STRONG, "<strong>${1}</strong>"),
        (&*EMPHASIS, "${1}<em>${2}</em>"),
    ] {
        if let Some(regex) = regex {
            rendered = regex.replace_all(&rendered, replacement).into_owned();
        }
    }
    rendered
}

#[derive(Default)]
struct Renderer<'a> {
    html: Vec<String>,
    para: Vec<&'a str>,
    list: Option<&'static str>,
    code: Option<Vec<&'a str>>,
}

impl<'a> Renderer<'a> {
    fn finish_para(&mut self) {
        if !self.para.is_empty() {
            self.html
                .push(format!("<p>{}</p>", inline(&self.para.join(" "))));
            self.para.clear();
        }
    }

    fn close_list(&mut self) {
        if let Some(tag) = self.list.take() {
            self.html.push(format!("</{tag}>"));
        }
    }

    fn close_code(&mut self) {
        if let Some(lines) = self.code.take() {
            self.html.push(format!(
                "<pre><code>{}</code></pre>",
                escape_html(&lines.join("\n"))
            ));
        }
    }

    fn flush_block(&mut self) {
        self.finish_para();
        self.close_list();
    }

    fn item(&mut self, kind: &'static str, text: &str) {
        self.finish_para();
        if self.list != Some(kind) {
            self.close_list();
            self.html.push(format!("<{kind}>"));
            self.list = Some(kind);
        }
        self.html.push(format!("<li>{}</li>", inline(text.trim())));
    }

    fn line(&mut self, raw: &'a str) {
        let fence = FENCE.as_ref().is_some_and(|regex| regex.is_match(raw));
        if let Some(code) = &mut self.code {
            if fence {
                self.close_code();
            } else {
                code.push(raw);
            }
        } else if fence {
            self.flush_block();
            self.code = Some(Vec::new());
        } else if let Some(head) = HEAD.as_ref().and_then(|regex| regex.captures(raw)) {
            self.flush_block();
            let level = head[1].len();
            self.html
                .push(format!("<h{level}>{}</h{level}>", inline(head[2].trim())));
        } else if RULE.as_ref().is_some_and(|regex| regex.is_match(raw)) {
            self.flush_block();
            self.html.push("<hr>".into());
        } else if let Some(item) = BULLET.as_ref().and_then(|regex| regex.captures(raw)) {
            self.item("ul", &item[1]);
        } else if let Some(item) = NUMBERED.as_ref().and_then(|regex| regex.captures(raw)) {
            self.item("ol", &item[1]);
        } else if let Some(quote) = QUOTE.as_ref().and_then(|regex| regex.captures(raw)) {
            self.flush_block();
            self.html.push(format!(
                "<blockquote>{}</blockquote>",
                inline(quote[1].trim())
            ));
        } else if raw.trim().is_empty() {
            self.flush_block();
        } else {
            self.para.push(raw.trim());
        }
    }
}

/// Render the supported inline and block forms. The output is a fragment for the
/// caller's template and independent resource-loading policy.
pub fn to_html(markdown: &str) -> String {
    let canonical = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let mut renderer = Renderer::default();
    for line in canonical.split('\n') {
        renderer.line(line);
    }
    renderer.flush_block();
    renderer.close_code();
    renderer.html.join("\n")
}
