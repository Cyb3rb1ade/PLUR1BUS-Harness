//! Per-family provider constraints (`toolcall/quirks.ts`). The table is data: a model override is an explicit row, never
//! inferred from a substring of a name. `fixtures/parity/toolcall/tables.json` holds the TypeScript table and the replay
//! compares every row, so the two cannot drift.
use super::json::V;

/// What one model family accepts and gets wrong (`ModelQuirks`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModelQuirks {
    /// The wire family (`openai-chat`, `openai-responses`, `anthropic`, `gemini`).
    pub family: &'static str,
    /// Parallel tool calls.
    pub parallel: bool,
    /// Strict schemas.
    pub strict: bool,
    /// Whether a tool choice can be forced.
    pub supports_forced_tool_choice: bool,
    /// The most tools one request may carry.
    pub max_tools: usize,
    /// The pattern a tool name must match (an ECMAScript regular expression without flags).
    pub name_pattern: &'static str,
    /// The longest tool name, in UTF-16 code units.
    pub max_name_length: usize,
    /// The longest description, in UTF-16 code units.
    pub max_description_length: usize,
    /// The repairs this family's malformed arguments may get.
    pub malformed_arguments: &'static [&'static str],
}

impl ModelQuirks {
    /// The row as TypeScript holds it, member for member.
    pub fn to_v(&self) -> V {
        V::obj([
            ("family", V::s(self.family)),
            ("parallel", V::Bool(self.parallel)),
            ("strict", V::Bool(self.strict)),
            (
                "supportsForcedToolChoice",
                V::Bool(self.supports_forced_tool_choice),
            ),
            ("maxTools", V::Num(self.max_tools as f64)),
            ("namePattern", V::s(self.name_pattern)),
            ("maxNameLength", V::Num(self.max_name_length as f64)),
            (
                "maxDescriptionLength",
                V::Num(self.max_description_length as f64),
            ),
            ("malformedArguments", V::strs(self.malformed_arguments)),
        ])
    }
}

const OPENAI_NAME: &str = "^[A-Za-z0-9_-]+$";
const ALL_REPAIRS: &[&str] = &["unwrap-json-string", "trailing-comma", "numeric-string"];
const NUMERIC_ONLY: &[&str] = &["numeric-string"];

/// N-F1/F3: room for the mandatory read, discovery and memory core inside an explicit local catalogue cap. A harness
/// recommendation, not a measured accuracy of local models and not a limit of a server.
const LOCAL_CORE_MAX_TOOLS: usize = 16;

const LOCAL_SMALL: ModelQuirks = ModelQuirks {
    family: "openai-chat",
    parallel: false,
    strict: false,
    supports_forced_tool_choice: false,
    max_tools: LOCAL_CORE_MAX_TOOLS,
    name_pattern: OPENAI_NAME,
    max_name_length: 64,
    max_description_length: 1024,
    malformed_arguments: ALL_REPAIRS,
};

const ANTHROPIC: ModelQuirks = ModelQuirks {
    family: "anthropic",
    parallel: true,
    strict: false,
    supports_forced_tool_choice: true,
    max_tools: 64,
    name_pattern: OPENAI_NAME,
    max_name_length: 64,
    max_description_length: 4096,
    malformed_arguments: NUMERIC_ONLY,
};

/// Conservative defaults per family, in the order of the TypeScript table.
pub const QUIRKS: &[(&str, ModelQuirks)] = &[
    (
        "openai-chat",
        ModelQuirks {
            family: "openai-chat",
            parallel: true,
            strict: true,
            supports_forced_tool_choice: true,
            max_tools: 128,
            name_pattern: OPENAI_NAME,
            max_name_length: 64,
            max_description_length: 1024,
            malformed_arguments: ALL_REPAIRS,
        },
    ),
    (
        "openai-responses",
        ModelQuirks {
            family: "openai-responses",
            parallel: true,
            strict: true,
            supports_forced_tool_choice: true,
            max_tools: 128,
            name_pattern: OPENAI_NAME,
            max_name_length: 64,
            max_description_length: 1024,
            malformed_arguments: NUMERIC_ONLY,
        },
    ),
    ("anthropic", ANTHROPIC),
    (
        "gemini",
        ModelQuirks {
            family: "gemini",
            parallel: true,
            strict: false,
            supports_forced_tool_choice: true,
            max_tools: 64,
            name_pattern: "^[A-Za-z_][A-Za-z0-9_-]*$",
            max_name_length: 64,
            max_description_length: 1024,
            malformed_arguments: NUMERIC_ONLY,
        },
    ),
    ("local-small", LOCAL_SMALL),
];

/// The API of Anthropic's Sonnet 5.5 rejects both forced-choice variants, also with thinking disabled.
const SONNET_55: ModelQuirks = ModelQuirks {
    supports_forced_tool_choice: false,
    ..ANTHROPIC
};

/// `lookupQuirks`: the row whose name is exactly `model_family`, else the local-small profile. Only an own table key
/// counts, so no name can reach anything but a row.
pub fn lookup_quirks(model_family: &str, model: Option<&str>) -> &'static ModelQuirks {
    if model_family == "anthropic" && model == Some("claude-sonnet-5-5") {
        return &SONNET_55;
    }
    QUIRKS
        .iter()
        .find(|(name, _)| *name == model_family)
        .map_or(&LOCAL_SMALL, |(_, q)| q)
}
