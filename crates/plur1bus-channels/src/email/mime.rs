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
