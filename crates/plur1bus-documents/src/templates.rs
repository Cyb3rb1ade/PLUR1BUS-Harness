//! D100's authored HTML templates. Only Markdown and escaped metadata enter the body.

use std::{str::FromStr, sync::LazyLock};

use regex::Regex;

use crate::{contrast::Rgb, markdown};

const BASE_CSS: &str = include_str!("template-base.css");
const DEFAULT_COLORS: [(&str, &str); 9] = [
    ("paper", "#ffffff"),
    ("text", "#1a1c20"),
    ("muted", "#4b5563"),
    ("accent", "#2563eb"),
    ("on-accent", "#ffffff"),
    ("cover-light-text", "#ffffff"),
    ("cover-light-ground", "#2563eb"),
    ("cover-dark-text", "#f5f7fa"),
    ("cover-dark-ground", "#111827"),
];

static REMOTE_LINK: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r#"(?i) href="https?://[^"]*""#).ok());

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Template {
    Report,
    Essay,
    WhitePaper,
    Proposal,
    OnePager,
    Letter,
    Invoice,
    Cv,
    Slides,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    UnknownTemplate,
    UnknownColor,
    InvalidColor,
}

impl FromStr for Template {
    type Err = Error;

    fn from_str(name: &str) -> Result<Self, Error> {
        match name {
            "report" => Ok(Self::Report),
            "essay" => Ok(Self::Essay),
            "white-paper" => Ok(Self::WhitePaper),
            "proposal" => Ok(Self::Proposal),
            "one-pager" => Ok(Self::OnePager),
            "letter" => Ok(Self::Letter),
            "invoice" => Ok(Self::Invoice),
            "cv" => Ok(Self::Cv),
            "slides" => Ok(Self::Slides),
            _ => Err(Error::UnknownTemplate),
        }
    }
}

pub struct Kit([String; 9]);

impl Default for Kit {
    fn default() -> Self {
        Self(DEFAULT_COLORS.map(|(_, value)| value.into()))
    }
}

impl Kit {
    /// Accept only known colour tokens and complete hexadecimal CSS colours.
    pub fn set(&mut self, token: &str, value: &str) -> Result<(), Error> {
        let index = DEFAULT_COLORS
            .iter()
            .position(|(name, _)| *name == token)
            .ok_or(Error::UnknownColor)?;
        if !value.starts_with('#') || value.trim() != value || Rgb::from_hex(value).is_err() {
            return Err(Error::InvalidColor);
        }
        self.0[index] = value.into();
        Ok(())
    }

    fn css(&self) -> String {
        DEFAULT_COLORS
            .iter()
            .zip(&self.0)
            .map(|((token, _), color)| format!("  --doc-{token}: {color};"))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[derive(Default)]
pub struct Meta<'a> {
    pub title: Option<&'a str>,
    pub author: &'a str,
    pub date: &'a str,
    pub from: &'a str,
    pub to: &'a str,
    pub subject: &'a str,
    pub salutation: &'a str,
    pub closing: &'a str,
    pub role: &'a str,
    pub total: &'a str,
    pub line_items: &'a [LineItem<'a>],
}

pub struct LineItem<'a> {
    pub label: &'a str,
    pub amount: &'a str,
}

pub struct Document<'a> {
    pub title: &'a str,
    pub subtitle: &'a str,
    pub markdown: &'a str,
    pub meta: Meta<'a>,
    pub kit: Kit,
}

const ESSAY_CSS: &str = "body { font-size: 1.05rem; } h1 { text-align: center; } p { text-align: justify; hyphens: auto; }";
const WHITE_PAPER_CSS: &str = "h2 { border-bottom: 1px solid color-mix(in srgb, var(--doc-text) 15%, transparent); padding-bottom: 0.25em; }";
const PROPOSAL_CSS: &str = "body { font-family: var(--font-sans); }";
const ONE_PAGER_CSS: &str = "body { font-family: var(--font-sans); } h1 { font-size: 1.8rem; }";
const LETTER_CSS: &str = "body { font-size: 1.02rem; } .letter-meta { font-family: var(--font-sans); font-size: 0.85rem; color: var(--doc-muted); margin-bottom: 1.4em; }";
const INVOICE_CSS: &str = "body { font-family: var(--font-sans); } table { width: 100%; border-collapse: collapse; margin: 1.4em 0; } th, td { text-align: left; padding: 0.5em 0.6em; border-bottom: 1px solid color-mix(in srgb, var(--doc-text) 12%, transparent); } .num { text-align: right; font-variant-numeric: tabular-nums; }";
const CV_CSS: &str = "body { font-family: var(--font-sans); } h3 { margin-bottom: 0.2em; } .role-meta { font-size: 0.8rem; color: var(--doc-muted); text-transform: uppercase; letter-spacing: .06em; }";
const SLIDES_CSS: &str = "body { font-family: var(--font-sans); } section.slide { break-after: page; min-height: 80vh; display: flex; flex-direction: column; justify-content: center; } @page { size: 254mm 190.5mm; } .slide h2 { font-size: 1.8rem; }";

impl Template {
    fn style(self) -> (&'static str, &'static str) {
        match self {
            Self::Report => ("serif", ""),
            Self::Essay => ("serif", ESSAY_CSS),
            Self::WhitePaper => ("serif", WHITE_PAPER_CSS),
            Self::Proposal => ("sans", PROPOSAL_CSS),
            Self::OnePager => ("sans", ONE_PAGER_CSS),
            Self::Letter => ("serif", LETTER_CSS),
            Self::Invoice => ("sans", INVOICE_CSS),
            Self::Cv => ("sans", CV_CSS),
            Self::Slides => ("sans", SLIDES_CSS),
        }
    }
}

fn title_block(title: &str, subtitle: &str) -> String {
    let sub = if subtitle.is_empty() {
        String::new()
    } else {
        format!(
            r#"<div class="subtitle" style="font-size:1.1rem;color:var(--doc-muted)">{subtitle}</div>"#
        )
    };
    format!("<header>{sub}<h1>{title}</h1></header>")
}

fn cover(template: Template, title: &str, subtitle: &str, author: &str, body: &str) -> String {
    let (kicker, scheme, rgba) = match template {
        Template::Report => ("Report", "dark", "rgba(245,247,250,0.72)"),
        Template::WhitePaper => ("White paper", "light", "rgba(255,255,255,0.82)"),
        _ => ("Proposal", "light", "rgba(255,255,255,0.82)"),
    };
    // The TypeScript template escapes the byline both before and within the cover.
    let author = markdown::escape_html(&markdown::escape_html(author));
    format!(
        r#"<div class="cover" style="background:var(--doc-cover-{scheme}-ground);color:var(--doc-cover-{scheme}-text);--cover-sub:{rgba}">
  <div class="kicker">{kicker}</div>
  <h1>{title}</h1>
  <div class="subtitle" style="color:var(--cover-sub)">{subtitle}</div>
  <div class="byline" style="color:var(--cover-sub)">{author}</div>
</div>
{}{body}"#,
        title_block(title, subtitle)
    )
}

fn letter(meta: &Meta<'_>, body: &str) -> String {
    let escape = markdown::escape_html;
    format!(
        r#"<div class="letter-meta">{from}<br>{date}<br><br>{to}</div>
<div style="font-family:var(--font-sans);font-size:.9rem;color:var(--doc-muted);text-transform:uppercase;letter-spacing:.08em">{subject}</div>
<h1 style="font-size:1.4rem">{salutation}</h1>
{body}
<p>{closing}</p>
<p style="font-family:var(--font-sans)">{author}</p>"#,
        from = escape(meta.from),
        date = escape(meta.date),
        to = escape(meta.to),
        subject = escape(meta.subject),
        salutation = escape(meta.salutation),
        closing = escape(meta.closing),
        author = escape(meta.author)
    )
}

fn invoice(meta: &Meta<'_>, body: &str) -> String {
    let escape = markdown::escape_html;
    let items = meta
        .line_items
        .iter()
        .map(|line| {
            format!(
                r#"<tr><td>{}</td><td class="num">{}</td></tr>"#,
                escape(line.label),
                escape(line.amount)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"<h1>{title}</h1>
<div style="font-family:var(--font-sans);font-size:.85rem;color:var(--doc-muted)">{from} &rarr; {to}<br>{date}</div>
<table><thead><tr><th>Item</th><th class="num">Amount</th></tr></thead><tbody>{items}</tbody></table>
<p style="font-family:var(--font-sans);font-weight:600;text-align:right">Total: {total}</p>
{body}"#,
        title = escape(meta.title.unwrap_or("Invoice")),
        from = escape(meta.from),
        to = escape(meta.to),
        date = escape(meta.date),
        total = escape(meta.total)
    )
}

fn slides(body: &str) -> String {
    let breaks: Vec<_> = body
        .match_indices("<h2>")
        .map(|(start, _)| start)
        .filter(|&start| start != 0)
        .collect();
    if breaks.is_empty() {
        return format!(r#"<section class="slide"><h2>Slides</h2>{body}</section>"#);
    }
    let mut start = 0;
    breaks
        .into_iter()
        .chain([body.len()])
        .map(|end| {
            let page = format!(r#"<section class="slide">{}</section>"#, &body[start..end]);
            start = end;
            page
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Assemble the template over escaped Markdown, using only the renderer's HTML
/// vocabulary. External links are removed from the fragment before assembly.
pub const DOCUMENT_CSP: &str = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; worker-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:";

pub fn assemble(template: Template, document: &Document<'_>) -> String {
    let title = markdown::escape_html(document.title);
    let subtitle = markdown::escape_html(document.subtitle);
    let raw = markdown::to_html(document.markdown);
    let body = REMOTE_LINK
        .as_ref()
        .map_or(raw.as_str().into(), |pattern| pattern.replace_all(&raw, ""));
    let (font, css) = template.style();
    let meta = &document.meta;
    let body = match template {
        Template::Report | Template::Proposal | Template::WhitePaper => {
            cover(template, &title, &subtitle, meta.author, &body)
        }
        Template::Essay => format!(
            r#"<header style="margin-top:12mm;text-align:center"><div class="kicker" style="font-family:var(--font-sans);text-transform:uppercase;letter-spacing:.14em;font-size:.8rem;color:var(--doc-muted)">Essay</div><h1>{title}</h1><div class="subtitle" style="color:var(--doc-muted)">{subtitle}</div></header>{body}"#
        ),
        Template::OnePager => format!("{}{body}", title_block(&title, &subtitle)),
        Template::Letter => letter(meta, &body),
        Template::Invoice => invoice(meta, &body),
        Template::Cv => format!(
            r#"<h1>{}</h1>
<div style="font-family:var(--font-sans);color:var(--doc-muted)">{} &middot; {}</div>
{body}"#,
            markdown::escape_html(meta.title.unwrap_or_default()),
            markdown::escape_html(meta.role),
            markdown::escape_html(meta.author)
        ),
        Template::Slides => slides(&body),
    };
    let base = BASE_CSS.replacen("__KIT__", &document.kit.css(), 1);
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="{DOCUMENT_CSP}">
<title>{title}</title>
<style>
{base}
{css}
</style>
</head>
<body class="{font}">
{body}
</body>
</html>"#
    )
}
