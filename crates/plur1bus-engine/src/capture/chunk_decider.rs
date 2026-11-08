//! Pure Jev answer and request shapes from the Node capture chunk decider.
//!
//! Credentials and guarded HTTP belong to the caller. This module never formats errors or
//! receives a secret, and all state cuts retain JavaScript UTF-16 behavior (RE-D17).

use crate::text::js::JsString;

/// The three storage decisions recognized by the capture expander.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Storage {
    /// Keep the original message without parts.
    Whole,
    /// Store only the deterministic parts.
    Parts,
    /// Keep the original message and deterministic parts; also the safe failure default.
    Both,
}

impl Storage {
    /// The exact spelling returned by `storageForJevAnswer`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Whole => "whole",
            Self::Parts => "parts",
            Self::Both => "both",
        }
    }
}

/// Map an already JS-number-coerced confidence and optional choice as Node does.
#[must_use]
pub fn storage_for_answer(choice: Option<&str>, confidence: Option<f64>, minimum: f64) -> Storage {
    let Some(confidence) = confidence else {
        return Storage::Both;
    };
    if !confidence.is_finite() || confidence < minimum {
        return Storage::Both;
    }
    match choice {
        Some("coherent") => Storage::Whole,
        Some("independent") => Storage::Parts,
        _ => Storage::Both,
    }
}

/// Node's fixed structure question, in the insertion order used for prompt-hash fixtures.
const STRUCTURE_QUESTION: &str = concat!(
    "{\"type\":\"choice\",\"instructions\":",
    "\"Is this message one coherent unit that should be kept together (e.g. a recipe, instructions, one explanation or argument), or a collection of independent statements or requests that each make sense on their own?\",",
    "\"criteria\":{",
    "\"coherent\":\"One topic or one connected piece: parts depend on each other and lose meaning when separated (recipe with ingredients and steps, how-to, single explanation).\",",
    "\"independent\":\"Several unrelated statements, facts or requests that each make sense alone.\",",
    "\"mixed\":\"Partly connected, partly independent.\"}}"
);

/// Build the exact credential-free `JSON.stringify` body sent by Node's chunk decider.
/// The state is cut to 60,000 UTF-16 units, including a possible final lone surrogate.
#[must_use]
pub fn request_json(model: &str, text: &JsString) -> String {
    format!(
        "{{\"model\":{},\"state\":{},\"questions\":{{\"structure\":{STRUCTURE_QUESTION}}}}}",
        JsString::from(model).to_json(),
        text.utf16_slice(0, 60_000).to_json()
    )
}
