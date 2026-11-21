//! Content-free local simulation of time-bounded federation loans.

use std::fmt;

// Let Serde enforce the original wire shape, then replace input-bearing diagnostics at the field boundary.
macro_rules! content_free_enum {
    ($remote:literal, $field:literal, [$($wire:tt)*]; $(#[$attr:meta])* pub enum $name:ident $variants:tt) => {
        $(#[$attr])*
        pub enum $name $variants

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                #[derive(serde::Deserialize)]
                #[serde(remote = $remote, $($wire)*)]
                enum Wire $variants

                Wire::deserialize(deserializer)
                    .map_err(|_| serde::de::Error::custom(concat!("invalid ", $field)))
            }
        }
    };
}

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

#[cfg(test)]
mod tests {
    use super::{loan, memory};
    use serde_json::json;

    #[test]
    fn unsupported_enum_input_reports_only_the_field() {
        let unexpected = "fixture content that must stay out of errors";
        let errors = [
            serde_json::from_value::<loan::Side>(json!(unexpected))
                .err()
                .unwrap(),
            serde_json::from_value::<memory::Level>(json!(unexpected))
                .err()
                .unwrap(),
            serde_json::from_value::<loan::Event>(json!({"type": unexpected}))
                .err()
                .unwrap(),
        ];
        assert_eq!(
            errors.map(|error| error.to_string()),
            ["invalid side", "invalid level", "invalid type"]
        );
    }
}
