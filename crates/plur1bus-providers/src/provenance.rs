//! Origin information attached locally to names and results from a wire peer.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Trust {
    #[default]
    Untrusted,
    OperatorVetted,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Origin {
    pub system: String,
    pub agent: Option<String>,
    pub principal: String,
    pub trust: Trust,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Transformation {
    Truncate,
    Redact,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub origin: Origin,
    pub hops: u32,
    pub transformed_by: Vec<Transformation>,
}
