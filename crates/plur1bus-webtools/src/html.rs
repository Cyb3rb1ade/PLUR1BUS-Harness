//! Extract readable Markdown and page evidence from bounded HTML.

mod render;
mod tree;

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use url::Url;

use crate::http::Failure;
use render::{absolute, as_node, collapse, hidden, raw_text, Renderer};
use tree::{space, Child, Element};

#[derive(Clone, Copy)]
pub enum Metadata {
    Title,
    Lang,
    CanonicalUrl,
    PublishedAt,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSignals {
    pub password_form: bool,
    pub captcha: bool,
    pub paywall: bool,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Extracted {
    pub markdown: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    pub looks_client_rendered: bool,
    pub signals: PageSignals,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_noscript: Option<bool>,
}

static APP_ROOT: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:root|app|__next|__nuxt|app-root|svelte|___gatsby|q-app)$").ok()
});
static NOSCRIPT_NAG: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:enable|turn on|activate)\s+javascript|javascript\s+(?:is\s+)?(?:required|disabled|turned off|needed)|requires?\s+javascript").ok()
});
static CAPTCHA_MARK: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
        r"(?i)re-?captcha|h-?captcha|turnstile|captcha|cf-chl|challenge-platform|arkose|funcaptcha",
    )
    .ok()
});
static CAPTCHA_WORDS: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:verify|confirm|prove)\s+(?:that\s+)?you(?:'re|\s+are|\s+a)\s+(?:a\s+)?(?:human|person|not\s+a\s+robot)|are\s+you\s+a\s+(?:robot|human)|not\s+a\s+robot|unusual\s+traffic|just\s+a\s+moment").ok()
});
static PAYWALL_MARK: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^a-z0-9])(?:paywall(?:ed)?|pay-?wall-?(?:prompt|overlay|modal)|subscriber-?(?:only|wall)|subscription-?wall|reg(?:istration)?-?wall|premium-?(?:wall|gate)|metered-?wall)(?:$|[^a-z0-9])").ok()
});
static LONG_BREAK: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"\n{3,}").ok());

fn matches(rule: &LazyLock<Option<Regex>>, text: &str) -> bool {
    rule.as_ref().is_some_and(|regex| regex.is_match(text))
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn clip(text: String, cap: usize) -> String {
    if units(&text) <= cap {
        return text;
    }
    let mut used = 0;
    let mut prefix = String::new();
    for c in text.chars() {
        used += c.len_utf16();
        if used >= cap {
            break;
        }
        prefix.push(c);
    }
    prefix.push('…');
    prefix
}

fn text_of(
    nodes: &[Element],
    id: usize,
    check: &dyn Fn() -> Result<(), Failure>,
) -> Result<String, Failure> {
    let mut text = String::new();
    raw_text(
        nodes,
        id,
        &mut |piece| {
            text.push_str(piece);
            Ok(())
        },
        check,
    )?;
    Ok(text)
}

fn is_small_root(
    nodes: &[Element],
    id: usize,
    check: &dyn Fn() -> Result<(), Failure>,
) -> Result<bool, Failure> {
    let mut units = 0;
    let mut blank = false;
    match raw_text(
        nodes,
        id,
        &mut |piece| {
            for (index, ch) in piece.chars().enumerate() {
                if index.is_multiple_of(1024) {
                    check()?;
                }
                if space(ch) {
                    blank = units > 0;
                } else {
                    units += usize::from(blank) + ch.len_utf16();
                    blank = false;
                    if units >= 25 {
                        return Err(Failure::TooLarge);
                    }
                }
            }
            Ok(())
        },
        check,
    ) {
        Ok(()) => Ok(true),
        Err(Failure::TooLarge) => Ok(false),
        Err(error) => Err(error),
    }
}

fn metadata(
    nodes: &[Element],
    base: Option<&Url>,
    mask: &dyn Fn(&str, Metadata) -> String,
    check: &dyn Fn() -> Result<(), Failure>,
) -> Result<Extracted, Failure> {
    let mut meta = Extracted::default();
    for (id, el) in nodes.iter().enumerate() {
        check()?;
        match el.tag.as_str() {
            "title" if meta.title.is_none() => {
                let title = collapse(&text_of(nodes, id, check)?);
                let title = title.trim_matches(space);
                if !title.is_empty() {
                    meta.title = Some(clip(mask(title, Metadata::Title), 300));
                }
            }
            "html" if meta.lang.is_none() && !el.attr("lang").is_empty() => {
                meta.lang = Some(clip(
                    mask(el.attr("lang").trim_matches(space), Metadata::Lang),
                    35,
                ));
            }
            "link"
                if meta.canonical_url.is_none()
                    && el
                        .attr("rel")
                        .split(space)
                        .any(|rel| rel.eq_ignore_ascii_case("canonical")) =>
            {
                meta.canonical_url = absolute(el.attr("href"), base, &["http", "https"])
                    .filter(|url| units(url) <= 2048)
                    .map(|url| mask(&url, Metadata::CanonicalUrl));
            }
            "meta" if meta.published_at.is_none() => {
                let name = ["property", "name", "itemprop"]
                    .iter()
                    .find_map(|&key| el.attrs.get(key))
                    .map_or(String::new(), |name| name.to_lowercase());
                if matches!(
                    name.as_str(),
                    "article:published_time" | "date" | "datepublished" | "og:published_time"
                ) && !el.attr("content").is_empty()
                {
                    meta.published_at = Some(clip(
                        mask(
                            el.attr("content").trim_matches(space),
                            Metadata::PublishedAt,
                        ),
                        64,
                    ));
                }
            }
            "time" if meta.published_at.is_none() && !el.attr("datetime").is_empty() => {
                meta.published_at = Some(clip(
                    mask(
                        el.attr("datetime").trim_matches(space),
                        Metadata::PublishedAt,
                    ),
                    64,
                ));
            }
            _ => {}
        }
    }
    Ok(meta)
}

fn signals(
    nodes: &[Element],
    markdown: &str,
    check: &dyn Fn() -> Result<(), Failure>,
) -> Result<PageSignals, Failure> {
    let mut evidence = PageSignals::default();
    let mut todo = vec![(0, false)];
    while let Some((id, ancestor_hidden)) = todo.pop() {
        check()?;
        let node = &nodes[id];
        let now_hidden = ancestor_hidden || hidden(node) || node.tag == "template";
        if node.tag == "input" && node.attr("type").eq_ignore_ascii_case("password") && !now_hidden
        {
            evidence.password_form = true;
        }
        if !ancestor_hidden {
            let names = format!("{} {}", node.attr("class"), node.attr("id"));
            evidence.captcha |= matches(&CAPTCHA_MARK, &names)
                || (matches!(node.tag.as_str(), "script" | "iframe")
                    && matches(&CAPTCHA_MARK, node.attr("src")));
            evidence.paywall |= !now_hidden && matches(&PAYWALL_MARK, &names);
        }
        if !matches!(node.tag.as_str(), "script" | "style") {
            todo.extend(
                node.children
                    .iter()
                    .filter_map(as_node)
                    .map(|child| (child, now_hidden)),
            );
        }
    }
    let len = units(markdown.trim_matches(space));
    let title = nodes
        .iter()
        .position(|el| el.tag == "title")
        .map(|id| text_of(nodes, id, check))
        .transpose()?
        .map_or_else(String::new, |text| collapse(&text));
    evidence.captcha = len < 400
        && (evidence.captcha
            || matches(&CAPTCHA_WORDS, &title)
            || matches(&CAPTCHA_WORDS, markdown));
    evidence.password_form &= len < 400;
    evidence.paywall &= len < 1500;
    Ok(evidence)
}

fn render(nodes: &[Element], id: usize, renderer: &Renderer<'_>) -> Result<String, Failure> {
    let selection = [Child::Element(id)];
    let children = if matches!(nodes[id].tag.as_str(), "#root" | "body") {
        nodes[id].children.as_slice()
    } else {
        &selection
    };
    let body = renderer.join(&renderer.blocks(children)?, "\n\n")?;
    let body = LONG_BREAK.as_ref().map_or_else(
        || std::borrow::Cow::Borrowed(body.as_str()),
        |pattern| pattern.replace_all(&body, "\n\n"),
    );
    Ok(body.trim_matches(space).to_owned())
}

/// Extract readable content with a hard output budget and a caller-supplied
/// deadline and cancellation check.
pub fn extract(
    html: &str,
    base_url: &str,
    mask: &dyn Fn(&str, Metadata) -> String,
    max_units: usize,
    check: &dyn Fn() -> Result<(), Failure>,
) -> Result<Extracted, Failure> {
    let nodes = tree::parse(html, check)?;
    let base = Url::parse(base_url).ok();
    let base = base.as_ref();
    let mut meta = metadata(&nodes, base, mask, check)?;
    let body_id = nodes.iter().position(|el| el.tag == "body").unwrap_or(0);
    let mut articles = nodes
        .iter()
        .enumerate()
        .filter(|(_, el)| el.tag == "article");
    let picked = nodes.iter().position(Element::is_main).or_else(|| {
        let first = articles.next()?.0;
        articles.next().is_none().then_some(first)
    });
    let mut renderer = Renderer {
        nodes: &nodes,
        base,
        keep: picked,
        keep_header: picked.is_some(),
        max_units: max_units.min(crate::http::DEFAULT_BODY_BYTES),
        check,
    };
    let mut markdown = render(&nodes, picked.unwrap_or(body_id), &renderer)?;
    if picked.is_some() && units(&markdown) < 200 {
        renderer.keep_header = false;
        let whole = render(&nodes, body_id, &renderer)?;
        if units(&whole) >= units(&markdown) * 10 {
            markdown = whole;
        }
    }
    meta.signals = signals(&nodes, &markdown, check)?;

    let text_len = units(markdown.trim_matches(space));
    let mut has_script = false;
    let mut loaded = false;
    let mut empty_root = false;
    for (id, el) in nodes.iter().enumerate() {
        check()?;
        if el.tag == "script" {
            has_script = true;
            loaded |= !el.attr("src").is_empty();
        }
        if !empty_root && text_len < 80 && matches(&APP_ROOT, el.attr("id")) {
            empty_root = is_small_root(&nodes, id, check)?;
        }
    }
    meta.looks_client_rendered =
        has_script && (text_len == 0 || (text_len < 80 && empty_root) || (text_len < 25 && loaded));
    if meta.looks_client_rendered || text_len == 0 {
        renderer.keep = None;
        renderer.keep_header = true;
        let mut text = String::new();
        let mut used = 0usize;
        for el in &nodes {
            check()?;
            if el.tag == "noscript"
                && el.children.iter().any(|child| match child {
                    Child::Element(_) => true,
                    Child::Text(text) => !text.trim_matches(space).is_empty(),
                })
            {
                let alternative = renderer.join(&renderer.blocks(&el.children)?, "\n\n")?;
                let separator = if text.is_empty() { "" } else { "\n\n" };
                used = used
                    .saturating_add(separator.len())
                    .saturating_add(units(&alternative));
                renderer.bound(used)?;
                text.push_str(separator);
                text.push_str(&alternative);
            }
        }
        let text = text.trim_matches(space);
        if units(text) >= 80 && !matches(&NOSCRIPT_NAG, text) {
            markdown = text.to_owned();
            meta.looks_client_rendered = false;
            meta.from_noscript = Some(true);
        }
    }
    check()?;
    meta.markdown = markdown;
    Ok(meta)
}

#[cfg(test)]
mod budget_tests {
    use super::{extract, Failure};

    #[test]
    fn quote_formatting_counts_against_the_output_limits() -> Result<(), Failure> {
        let html = "<blockquote><blockquote><p>Ordinary quote</p></blockquote></blockquote>";
        let mask = |text: &str, _| text.to_owned();
        let base = "https://edition.example.invalid/";
        let limit = ">> Ordinary quote".len() + 1;
        assert_eq!(
            extract(html, base, &mask, limit, &|| Ok(()))?.markdown,
            "> > Ordinary quote"
        );
        assert_eq!(
            extract(html, base, &mask, limit - 1, &|| Ok(())).err(),
            Some(Failure::TooLarge)
        );
        Ok(())
    }
}
