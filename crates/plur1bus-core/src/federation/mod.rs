//! Content-free local simulation of time-bounded federation loans.

use std::fmt;

pub mod loan;
pub mod memory;

/// Stable model refusal with no content from the rejected input.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Error(pub &'static str);
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Error {}

fn valid_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
