//! Exact original caller in private recovery plans; never reconstruct identity from an owner string.
use super::derived_fields::validate_object;
use crate::{
    contract::{AgentContext, Principal, StoreError},
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
use serde::{Deserialize, Serialize};
const MAX_BYTES: usize = 64 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Caller {
    pub principal: Principal,
    pub agent: AgentContext,
}
pub(super) fn encode(principal: &Principal, agent: &AgentContext) -> Result<Json, StoreError> {
    let caller = Caller {
        principal: principal.clone(),
        agent: agent.clone(),
    };
    let bytes = serde_json::to_string(&caller).map_err(|_| StoreError::InvalidInput)?;
    if bytes.len() > MAX_BYTES {
        return Err(StoreError::InvalidInput);
    }
    parse_json(&bytes).map_err(|_| StoreError::InvalidInput)
}
pub(super) fn decode(value: &Json) -> Result<Caller, StoreError> {
    validate_object(value)?;
    let bytes = write_json(value);
    if bytes.len() > MAX_BYTES {
        return Err(StoreError::Corrupt);
    }
    serde_json::from_str(&bytes).map_err(|_| StoreError::Corrupt)
}
