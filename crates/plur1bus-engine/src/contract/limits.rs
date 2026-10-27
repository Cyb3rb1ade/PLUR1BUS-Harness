//! Input limits recorded from the pinned engine and string validation at parity.
//!
//! Ports accept strings, so this typed boundary represents absent/null input by
//! `None` and deliberately does not coerce arbitrary dynamic-language objects.
//! Lengths count UTF-16 code units, matching the source string contract.

include!(concat!(env!("OUT_DIR"), "/input_limits.rs"));

/// String validation options corresponding to the engine's input boundary.
#[derive(Clone, Copy, Debug)]
pub struct ValidationOptions<'a> {
    /// Maximum UTF-16 code units; `None` and zero impose no maximum.
    pub max_length: Option<usize>,
    /// Human-readable name used in validation errors.
    pub name: &'a str,
    /// Reject an absent or empty string. Whitespace is considered present.
    pub required: bool,
    /// Optional pattern; matching uses the supplied Rust regular expression.
    pub allowed_pattern: Option<&'a regex::Regex>,
}

impl Default for ValidationOptions<'_> {
    fn default() -> Self {
        Self {
            max_length: None,
            name: "input",
            required: false,
            allowed_pattern: None,
        }
    }
}

/// Validate an optional string without coercion or silent truncation.
///
/// Success preserves the original value, including `None` and empty strings.
/// Requiredness is checked before length, which is checked before the pattern.
pub fn validate_input<'a>(
    value: Option<&'a str>,
    options: ValidationOptions<'_>,
) -> Result<Option<&'a str>, String> {
    if options.required && value.is_none_or(str::is_empty) {
        return Err(format!("{} is required", options.name));
    }
    let Some(value) = value else {
        return Ok(None);
    };
    if let Some(maximum) = options.max_length.filter(|maximum| *maximum > 0) {
        let length = value.encode_utf16().count();
        if length > maximum {
            return Err(format!(
                "{} exceeds maximum length of {maximum} characters (received {length})",
                options.name
            ));
        }
    }
    if options
        .allowed_pattern
        .is_some_and(|pattern| !pattern.is_match(value))
    {
        return Err(format!("{} contains invalid characters", options.name));
    }
    Ok(Some(value))
}

macro_rules! string_validator {
    ($function:ident, $maximum:ident, $name:literal, $description:literal) => {
        #[doc = $description]
        pub fn $function(value: Option<&str>) -> Result<Option<&str>, String> {
            validate_input(
                value,
                ValidationOptions {
                    max_length: Some($maximum),
                    name: $name,
                    ..ValidationOptions::default()
                },
            )
        }
    };
}

string_validator!(
    validate_command_args,
    COMMAND_ARGS,
    "command arguments",
    "Validate command arguments."
);
string_validator!(
    validate_semantic_command_args,
    SEMANTIC_COMMAND_ARGS,
    "command arguments",
    "Validate long semantic command arguments before summarization."
);
string_validator!(
    validate_callback_data,
    CALLBACK_DATA,
    "callback data",
    "Validate callback data."
);
string_validator!(
    validate_correction_text,
    CORRECTION_TEXT,
    "correction text",
    "Validate correction text."
);
string_validator!(
    validate_search_query,
    SEARCH_QUERY,
    "search query",
    "Validate a search query."
);
string_validator!(
    validate_topic_query,
    TOPIC_QUERY,
    "topic query",
    "Validate a topic query."
);
string_validator!(
    validate_memory_text,
    MEMORY_TEXT,
    "memory text",
    "Validate memory text."
);
string_validator!(
    validate_agent_id,
    AGENT_ID,
    "agent ID",
    "Validate an agent ID's length."
);
string_validator!(
    validate_chat_id,
    CHAT_ID,
    "chat ID",
    "Validate a chat ID's length."
);
string_validator!(
    validate_user_id,
    USER_ID,
    "user ID",
    "Validate a user ID's length."
);

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn recorded_node_vectors_match() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/input-limits/vectors.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let input = case["input"].as_str();
            let options = &case["options"];
            let pattern = options["allowedPattern"]
                .as_str()
                .map(|pattern| regex::Regex::new(pattern).unwrap());
            let result = match case["operation"].as_str().unwrap() {
                "validateInput" => validate_input(
                    input,
                    ValidationOptions {
                        max_length: options["maxLength"].as_u64().map(|n| n as usize),
                        name: options["name"].as_str().unwrap_or("input"),
                        required: options["required"].as_bool().unwrap_or(false),
                        allowed_pattern: pattern.as_ref(),
                    },
                ),
                "validateCommandArgs" => validate_command_args(input),
                "validateSemanticCommandArgs" => validate_semantic_command_args(input),
                "validateCallbackData" => validate_callback_data(input),
                "validateCorrectionText" => validate_correction_text(input),
                "validateSearchQuery" => validate_search_query(input),
                "validateTopicQuery" => validate_topic_query(input),
                "validateMemoryText" => validate_memory_text(input),
                "validateAgentId" => validate_agent_id(input),
                "validateChatId" => validate_chat_id(input),
                "validateUserId" => validate_user_id(input),
                operation => panic!("unhandled vector operation {operation}"),
            };
            let actual = match result {
                Ok(Some(value)) => json!({ "ok": true, "value": value }),
                Ok(None) => json!({ "ok": true }),
                Err(error) => json!({ "ok": false, "error": error }),
            };
            assert_eq!(actual, case["expected"], "{}", case["name"]);
        }
    }
}
