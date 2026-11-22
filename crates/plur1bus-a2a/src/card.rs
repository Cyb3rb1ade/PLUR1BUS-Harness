//! Public Agent Card projection.
use serde::Deserialize;
use serde_json::{json, Value};
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

fn skill_card(skill: &Skill) -> Value {
    let tags: Vec<_> = skill
        .tags
        .iter()
        .take(8)
        .map(|tag| clean(tag, 32, "tag"))
        .collect();
    let mut card = json!({
        "id": clean(&skill.id, 64, "skill"),
        "name": clean(&skill.name, 80, "Skill"),
        "description": clean(skill.description.as_deref().unwrap_or_default(), 400, "No description."),
        "tags": tags,
    });
    let input = modes(&skill.input_modes);
    if !input.is_empty() {
        card["inputModes"] = json!(input);
    }
    let output = modes(&skill.output_modes);
    if !output.is_empty() {
        card["outputModes"] = json!(output);
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
    if !info.opt_in {
        return Err(Error::NotExposed);
    }
    let url = endpoint(id, base)?;
    if version.is_empty() {
        return Err(Error::InvalidVersion);
    }
    let mut skills: Vec<_> = info.skills.iter().take(32).map(skill_card).collect();
    if skills.is_empty() {
        skills.push(
            json!({"id":"chat","name":"Chat","description":"Answers a text message.","tags":[]}),
        );
    }
    Ok(json!({
        "protocolVersion": PROTOCOL_VERSION,
        "name": clean(info.display_name.as_deref().unwrap_or_default(), 80, id),
        "description": clean(info.description.as_deref().unwrap_or_default(), 400, "A PLUR1BUS agent."),
        "url": url,
        "preferredTransport": "JSONRPC",
        "version": version,
        "capabilities": {
            "streaming": features.streaming,
            "pushNotifications": features.push_notifications,
            "stateTransitionHistory": false
        },
        "defaultInputModes": default_modes(&info.default_input_modes),
        "defaultOutputModes": default_modes(&info.default_output_modes),
        "skills": skills,
        "securitySchemes": {"peerKey": {
            "type": "http", "scheme": "bearer", "description": "A per-peer API key issued by the operator."
        }},
        "security": [{"peerKey": []}]
    }))
}
