//! MIME builder and bounded parser.
mod build;
mod html;
mod parse;

pub use build::{build, BuildInput, OutAttachment};
pub use parse::{
    parse, parse_addresses, parse_strict_mailbox, Attachment, FromProblem, Headers, ParseOptions,
    ParsedMessage,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Mailbox {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub address: String,
}

fn clean_filename(filename: &str) -> String {
    let name = filename
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .trim();
    let mut clean = String::new();
    let mut run = false;
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_') {
            clean.push(char::from(b));
            run = false;
        } else if !run {
            clean.push('_');
            run = true;
        }
    }
    let clean = clean.trim_start_matches('.');
    if clean.is_empty() {
        "attachment".into()
    } else {
        clean[..clean.len().min(100)].into()
    }
}
