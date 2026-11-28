//! Static review checks for the renderer's HTML vocabulary.

use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

use regex::{Captures, Regex};
use serde::Serialize;

use crate::contrast::{self, BODY_CONTRAST};

pub const LAYOUT_SCRIPT: &str = include_str!("layout-check.js");
const CHECK_IDS: &[&str] = &[
    "links",
    "images",
    "fonts",
    "contrast",
    "overflow",
    "widow",
    "empty-page",
];
const SYSTEM_FONTS: &[&str] = &[
    "system-ui",
    "-apple-system",
    "segoe ui",
    "roboto",
    "georgia",
    "times new roman",
    "ui-monospace",
    "sf mono",
    "menlo",
    "consolas",
    "monospace",
    "sans-serif",
    "serif",
    "cursive",
    "fantasy",
];

struct Patterns {
    href: Regex,
    id: Regex,
    image: Regex,
    attribute: Regex,
    face: Regex,
    family: Regex,
    font_variable: Regex,
    stylesheet: Regex,
    inline_style: Regex,
}

static PATTERNS: LazyLock<Result<Patterns, regex::Error>> = LazyLock::new(|| {
    Ok(Patterns {
        href: Regex::new(r#"(?i)<a\b[^>]*\bhref\s*=\s*"([^"]*)""#)?,
        id: Regex::new(r#"(?i)\bid\s*=\s*"([^"]+)""#)?,
        image: Regex::new(r"(?i)<img\b[^>]*>")?,
        attribute: Regex::new(r#"(?i)(\b[a-z-]+)\s*=\s*"([^"]*)""#)?,
        face: Regex::new(r#"(?i)@font-face\s*\{[^}]*font-family\s*:\s*"([^"]+)""#)?,
        family: Regex::new(r"(?i)font-family\s*:\s*([^;}]+)")?,
        font_variable: Regex::new(r"(--font-(?:sans|serif|mono))\s*:\s*([^;}]+)")?,
        stylesheet: Regex::new(r"(?is)<style\b[^>]*>(.*?)</style>")?,
        inline_style: Regex::new(r#"(?i)<[^>]+\bstyle\s*=\s*"([^"]*)""#)?,
    })
});

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warn,
}

#[derive(Serialize)]
pub struct Finding {
    pub check: &'static str,
    pub severity: Severity,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Serialize)]
pub struct Report {
    pub checked: &'static [&'static str],
    pub findings: Vec<Finding>,
    pub summary: Vec<String>,
    pub passed: bool,
    pub vision: bool,
}

fn group<'a>(captures: &Captures<'a>, index: usize) -> &'a str {
    captures.get(index).map_or("", |capture| capture.as_str())
}

fn check_links<'a>(html: &'a str, patterns: &'a Patterns) -> impl Iterator<Item = Finding> + 'a {
    let ids: HashSet<_> = patterns
        .id
        .captures_iter(html)
        .map(|capture| group(&capture, 1))
        .collect();
    patterns
        .href
        .captures_iter(html)
        .filter_map(move |capture| {
            let href = group(&capture, 1);
            let lower = href.to_ascii_lowercase();
            let (severity, message) = if ["javascript:", "file:", "data:"]
                .iter()
                .any(|scheme| lower.starts_with(scheme))
            {
                (Severity::Error, format!("unsafe link target {href}"))
            } else if let Some(fragment) = href.strip_prefix('#') {
                if ids.contains(fragment) {
                    return None;
                }
                (
                    Severity::Warn,
                    format!("fragment link to a missing target {href}"),
                )
            } else if lower.starts_with("https://") || lower.starts_with("http://") {
                return None;
            } else {
                (Severity::Warn, format!("unverifiable link target {href}"))
            };
            Some(Finding {
                check: "links",
                severity,
                message,
                detail: Some(href.into()),
            })
        })
}

fn check_images<'a>(html: &'a str, patterns: &'a Patterns) -> impl Iterator<Item = Finding> + 'a {
    patterns.image.find_iter(html).filter_map(|tag| {
        let attributes: HashMap<_, _> = patterns
            .attribute
            .captures_iter(tag.as_str())
            .map(|capture| (group(&capture, 1), group(&capture, 2)))
            .collect();
        let width = attributes
            .get("width")
            .and_then(|value| value.trim().parse::<f64>().ok())
            .filter(|width| width.is_finite() && *width > 0.0);
        let natural = attributes
            .get("data-natural-width")
            .or_else(|| attributes.get("naturalwidth"))
            .and_then(|value| value.trim().parse::<f64>().ok())
            .filter(|width| width.is_finite());
        let (severity, message) = match width.zip(natural) {
            Some((width, natural)) => {
                let dpi = natural / (width / 96.0);
                if dpi >= 150.0 {
                    return None;
                }
                (
                    Severity::Error,
                    format!(
                        "image is {} dpi at print size (below 150)",
                        (dpi + 0.5).floor()
                    ),
                )
            }
            None => (
                Severity::Warn,
                "image has no intrinsic pixel width to compute print dpi".into(),
            ),
        };
        Some(Finding {
            check: "images",
            severity,
            message,
            detail: attributes
                .get("src")
                .or_else(|| attributes.get("alt"))
                .map(|source| (*source).to_owned()),
        })
    })
}

fn check_fonts<'a>(html: &'a str, patterns: &'a Patterns) -> impl Iterator<Item = Finding> + 'a {
    let stylesheets = || {
        patterns
            .stylesheet
            .captures_iter(html)
            .map(|capture| group(&capture, 1))
    };
    let variables: HashMap<_, _> = stylesheets()
        .flat_map(|css| patterns.font_variable.captures_iter(css))
        .map(|capture| (group(&capture, 1), group(&capture, 2)))
        .collect();
    let embedded: HashSet<_> = stylesheets()
        .flat_map(|css| patterns.face.captures_iter(css))
        .map(|capture| group(&capture, 1).to_lowercase())
        .collect();
    stylesheets()
        .chain(
            patterns
                .inline_style
                .captures_iter(html)
                .map(|capture| group(&capture, 1)),
        )
        .flat_map(|css| patterns.family.captures_iter(css))
        .flat_map(move |capture| {
            let families = group(&capture, 1).trim();
            families
                .strip_prefix("var(")
                .and_then(|name| name.strip_suffix(')'))
                .and_then(|name| variables.get(name).copied())
                .unwrap_or(families)
                .split(',')
        })
        .filter_map(move |family| {
            let family = family.trim();
            let name = family.trim_matches(['\'', '"']).to_lowercase();
            if name.is_empty() || SYSTEM_FONTS.contains(&name.as_str()) || embedded.contains(&name)
            {
                return None;
            }
            Some(Finding {
                check: "fonts",
                severity: Severity::Error,
                message: format!(
                    "font family \"{family}\" is used but not embedded and has no system fallback"
                ),
                detail: Some(family.into()),
            })
        })
}

fn check_contrast<'a>(html: &'a str, patterns: &'a Patterns) -> impl Iterator<Item = Finding> + 'a {
    patterns
        .inline_style
        .captures_iter(html)
        .filter_map(|capture| {
            let mut fg = None;
            let mut bg = None;
            for (property, value) in group(&capture, 1)
                .split(';')
                .filter_map(|line| line.split_once(':'))
            {
                let value = value.trim();
                match property.trim().to_ascii_lowercase().as_str() {
                    "color" => fg = Some(value),
                    "background" | "background-color" if bg.is_none() => bg = Some(value),
                    _ => {}
                }
            }
            let (fg, bg) = (fg?, bg?);
            let ratio = contrast::ratio(fg, bg).ok()?;
            (ratio < BODY_CONTRAST).then(|| Finding {
                check: "contrast",
                severity: Severity::Error,
                message: format!(
                    "inline text contrast {ratio:.2}:1 is below {BODY_CONTRAST}:1 ({fg} on {bg})"
                ),
                detail: Some(format!("{fg} on {bg}")),
            })
        })
}

pub fn static_checks(html: &str) -> Vec<Finding> {
    let Ok(patterns) = &*PATTERNS else {
        return vec![Finding {
            check: "links",
            severity: Severity::Error,
            message: "static document checks could not be initialized".to_owned(),
            detail: None,
        }];
    };
    check_links(html, patterns)
        .chain(check_images(html, patterns))
        .chain(check_fonts(html, patterns))
        .chain(check_contrast(html, patterns))
        .collect()
}

pub fn summarize<'a>(
    findings: Vec<Finding>,
    vision: bool,
    fixed: impl IntoIterator<Item = &'a str>,
) -> Report {
    let summary = findings
        .iter()
        .map(|finding| format!("{}: {}", finding.check, finding.message))
        .chain(fixed.into_iter().map(|entry| format!("fixed: {entry}")))
        .chain([if vision {
            "vision review: ran"
        } else {
            "vision review: not configured — automatic checks only"
        }
        .to_owned()])
        .collect();
    let passed = findings
        .iter()
        .all(|finding| matches!(finding.severity, Severity::Warn));
    Report {
        checked: CHECK_IDS,
        findings,
        summary,
        passed,
        vision,
    }
}
