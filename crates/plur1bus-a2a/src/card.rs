//! Public Agent Card projection.
use crate::events::object;
use plur1bus_providers::Json;
use serde::Deserialize;
use serde_json::Value;
use url::Url;

pub const PROTOCOL_VERSION: &str = "0.3.0";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub opt_in: bool,
    pub display_name: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub default_input_modes: Vec<String>,
    #[serde(default)]
    pub default_output_modes: Vec<String>,
    #[serde(default)]
    pub skills: Vec<Skill>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub input_modes: Vec<String>,
    #[serde(default)]
    pub output_modes: Vec<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    pub streaming: bool,
    pub push_notifications: bool,
}

impl Default for Features {
    fn default() -> Self {
        Self {
            streaming: true,
            push_notifications: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    NotExposed,
    InvalidEndpoint,
    InvalidVersion,
}

fn clean(source: &str, max: usize, fallback: &str) -> String {
    let clean: String = source
        .chars()
        .map(|character| {
            if character.is_ascii_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let trimmed =
        clean.trim_matches(|c: char| (c.is_whitespace() && c != '\u{0085}') || c == '\u{feff}');
    let mut units = 0;
    let kept: String = trimmed
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect();
    if kept.is_empty() {
        fallback.to_owned()
    } else {
        kept
    }
}

fn modes(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|raw| clean(raw, 64, ""))
        .filter(|value| !value.is_empty())
        .take(8)
        .collect()
}

fn default_modes(values: &[String]) -> Vec<String> {
    let mut configured = modes(values);
    if configured.is_empty() {
        configured.push("text/plain".to_owned());
    }
    configured
}

fn json_strings(strings: Vec<String>) -> Json {
    Json::Array(strings.into_iter().map(Json::from).collect())
}

fn skill_card(skill: &Skill) -> Json {
    let tags: Vec<_> = skill
        .tags
        .iter()
        .take(8)
        .map(|tag| clean(tag, 32, "tag"))
        .collect();
    let mut card = object([
        ("id", clean(&skill.id, 64, "skill").into()),
        ("name", clean(&skill.name, 80, "Skill").into()),
        (
            "description",
            clean(
                skill.description.as_deref().unwrap_or_default(),
                400,
                "No description.",
            )
            .into(),
        ),
        ("tags", json_strings(tags)),
    ]);
    let input = modes(&skill.input_modes);
    if !input.is_empty() {
        card.set("inputModes", json_strings(input));
    }
    let output = modes(&skill.output_modes);
    if !output.is_empty() {
        card.set("outputModes", json_strings(output));
    }
    card
}

fn endpoint(id: &str, base: &str) -> Result<String, Error> {
    if id.is_empty()
        || matches!(id, "." | "..")
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(Error::InvalidEndpoint);
    }
    let url = Url::parse(base).map_err(|_| Error::InvalidEndpoint)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err(Error::InvalidEndpoint);
    }
    Ok(format!("{}/a2a/{id}/", url.as_str().trim_end_matches('/')))
}

/// Produce the content-free advertisement from host-approved public fields.
pub fn build_card(
    id: &str,
    info: &AgentInfo,
    base: &str,
    version: &str,
    features: Features,
) -> Result<Value, Error> {
    let card = wire_card(id, info, base, version, features)?;
    serde_json::from_str(&card.encode()).map_err(|_| Error::InvalidEndpoint)
}

pub(crate) fn wire_card(
    id: &str,
    info: &AgentInfo,
    base: &str,
    version: &str,
    features: Features,
) -> Result<Json, Error> {
    if !info.opt_in {
        return Err(Error::NotExposed);
    }
    let url = endpoint(id, base)?;
    if version.is_empty() {
        return Err(Error::InvalidVersion);
    }
    let mut skills: Vec<_> = info.skills.iter().take(32).map(skill_card).collect();
    if skills.is_empty() {
        skills.push(object([
            ("id", "chat".into()),
            ("name", "Chat".into()),
            ("description", "Answers a text message.".into()),
            ("tags", Vec::new().into()),
        ]));
    }
    let capabilities = object([
        ("streaming", features.streaming.into()),
        ("pushNotifications", features.push_notifications.into()),
        ("stateTransitionHistory", false.into()),
    ]);
    let security = object([(
        "peerKey",
        object([
            ("type", "http".into()),
            ("scheme", "bearer".into()),
            (
                "description",
                "A per-peer API key issued by the operator.".into(),
            ),
        ]),
    )]);
    Ok(object([
        ("protocolVersion", PROTOCOL_VERSION.into()),
        (
            "name",
            clean(info.display_name.as_deref().unwrap_or_default(), 80, id).into(),
        ),
        (
            "description",
            clean(
                info.description.as_deref().unwrap_or_default(),
                400,
                "A PLUR1BUS agent.",
            )
            .into(),
        ),
        ("url", url.into()),
        ("preferredTransport", "JSONRPC".into()),
        ("version", version.into()),
        ("capabilities", capabilities),
        (
            "defaultInputModes",
            json_strings(default_modes(&info.default_input_modes)),
        ),
        (
            "defaultOutputModes",
            json_strings(default_modes(&info.default_output_modes)),
        ),
        ("skills", skills.into()),
        ("securitySchemes", security),
        (
            "security",
            vec![object([("peerKey", Vec::new().into())])].into(),
        ),
    ]))
}
