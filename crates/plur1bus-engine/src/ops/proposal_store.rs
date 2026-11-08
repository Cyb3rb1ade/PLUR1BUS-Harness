//! Node-compatible proposal files with exact role and pool authorization before projection.
use super::{context::error, memory::valid_id};
use crate::{
    context::RequestContext,
    contract::{EngineError, MemoryOpErrorCode, MemoryProposal},
    store::{paths::assert_trusted_path, state_file::StateFile},
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue},
    },
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
const KEYS: &[&str] = &[
    "id",
    "sharedId",
    "sourceId",
    "target",
    "sharerAgentId",
    "proposerAgentId",
    "oldText",
    "newText",
    "note",
    "createdAt",
    "status",
    "resolvedAt",
    "resultId",
    "resolutionNote",
    "poolKey",
];
fn storage() -> EngineError {
    error(MemoryOpErrorCode::Storage)
}
pub(super) struct Proposal {
    pub data: Value,
    raw: TolerantJsonValue,
}
impl Proposal {
    pub fn new(data: &Value) -> Result<Self, EngineError> {
        let raw = parse_json(&data.to_string()).map_err(|_| storage())?;
        Self::decode(raw)
    }
    fn decode(raw: TolerantJsonValue) -> Result<Self, EngineError> {
        let data = super::json_fields::project(&raw, KEYS);
        let mut public = data.clone();
        public
            .as_object_mut()
            .ok_or_else(storage)?
            .remove("poolKey");
        serde_json::from_value::<MemoryProposal>(public).map_err(|_| storage())?;
        if !data["poolKey"].is_string() {
            return Err(storage());
        }
        Ok(Self { data, raw })
    }
    pub fn text(&self, key: &str) -> &str {
        self.data[key].as_str().unwrap_or("")
    }
    pub fn public(&self) -> Value {
        let mut value = self.data.clone();
        if let Some(fields) = value.as_object_mut() {
            fields.remove("poolKey");
        }
        value
    }
    pub fn set(&mut self, key: &str, value: Value) -> Result<(), EngineError> {
        let encoded = parse_json(&value.to_string()).map_err(|_| storage())?;
        if let TolerantJsonValue::Object(fields) = &mut self.raw {
            let name = JsString::from_utf8_str(key);
            if let Some((_, old)) = fields.iter_mut().find(|(field, _)| *field == name) {
                *old = encoded;
            } else {
                fields.push((name, encoded));
            }
        }
        self.data[key] = value;
        Ok(())
    }
    pub fn reachable(&self, ctx: &RequestContext) -> bool {
        reachable_pool(self.text("poolKey"), ctx)
    }
}
fn reachable_pool(key: &str, ctx: &RequestContext) -> bool {
    (!ctx.workspace_key.is_empty() && key == crate::context::workspace_pool_key(&ctx.workspace_key))
        || (!ctx.owner_user_id.is_empty()
            && key == crate::context::user_pool_key(&ctx.owner_user_id))
}
pub(super) struct ProposalStore {
    root: PathBuf,
}
fn agent_valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
impl ProposalStore {
    pub fn new(base: &Path) -> Result<Self, EngineError> {
        let root = base.parent().ok_or_else(storage)?.join("_proposals");
        assert_trusted_path(&root).map_err(|_| storage())?;
        Ok(Self { root })
    }
    fn directory(&self, agent: &str) -> Result<PathBuf, EngineError> {
        if !agent_valid(agent) {
            return Err(storage());
        }
        let path = self.root.join(agent);
        assert_trusted_path(&path).map_err(|_| storage())?;
        Ok(path)
    }
    fn path(&self, agent: &str, id: &str) -> Result<PathBuf, EngineError> {
        if !valid_id(id) {
            return Err(storage());
        }
        Ok(self.directory(agent)?.join(format!("{id}.json")))
    }
    pub fn save(&self, proposal: &Proposal) -> Result<(), EngineError> {
        StateFile::<TolerantJsonValue>::store(
            &self.path(proposal.text("sharerAgentId"), proposal.text("id"))?,
            &proposal.raw,
        )
        .map_err(|_| storage())
    }
    pub fn get(&self, ctx: &RequestContext, id: &str) -> Result<Option<Proposal>, EngineError> {
        let raw = match StateFile::<TolerantJsonValue>::load(&self.path(ctx.agent_id.as_str(), id)?)
        {
            Ok(Some(raw)) => raw,
            Ok(None) | Err(crate::contract::StoreError::Corrupt) => return Ok(None),
            Err(_) => return Err(storage()),
        };
        // Authorize the metadata before decoding any proposal text. Case-folded paths and
        // corrupt text in another user's file must not reveal whether that proposal exists.
        let header = super::json_fields::project(&raw, &["id", "sharerAgentId", "poolKey"]);
        if header["sharerAgentId"].as_str() != Some(ctx.agent_id.as_str())
            || !header["id"]
                .as_str()
                .is_some_and(|stored| stored.eq_ignore_ascii_case(id))
            || !reachable_pool(header["poolKey"].as_str().unwrap_or(""), ctx)
        {
            return Ok(None);
        }
        Proposal::decode(raw).map(Some)
    }
    fn records(&self, agent: &str) -> Result<Vec<Proposal>, EngineError> {
        let directory = self.directory(agent)?;
        let entries = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(_) => return Err(storage()),
        };
        let mut entries = entries
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| storage())?;
        entries.sort_by_key(std::fs::DirEntry::file_name);
        let mut records = vec![];
        for entry in entries {
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            // A corrupt record has no provable caller ACL. Do not disclose its existence in a count.
            if let Ok(Some(raw)) = StateFile::<TolerantJsonValue>::load(&entry.path()) {
                if let Ok(record) = Proposal::decode(raw) {
                    if record.text("sharerAgentId") == agent
                        && entry
                            .path()
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .is_some_and(|id| id.eq_ignore_ascii_case(record.text("id")))
                    {
                        records.push(record);
                    }
                }
            }
        }
        Ok(records)
    }
    pub fn pending(&self, agent: &str, shared: &str, proposer: &str) -> Result<bool, EngineError> {
        Ok(self.records(agent)?.iter().any(|p| {
            p.text("status") == "pending"
                && p.text("sharedId").eq_ignore_ascii_case(shared)
                && p.text("proposerAgentId") == proposer
        }))
    }
    pub fn list(
        &self,
        ctx: &RequestContext,
        status: Option<&str>,
        limit: usize,
    ) -> Result<Value, EngineError> {
        let entries = match std::fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(
                    json!({"agentId":ctx.agent_id,"items":[],"truncated":false,"unreadable":0}),
                )
            }
            Err(_) => return Err(storage()),
        };
        let mut dirs = entries
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| storage())?;
        dirs.sort_by_key(|e| (e.file_name() != ctx.agent_id.as_str(), e.file_name()));
        let mut items = vec![];
        for entry in dirs {
            if !entry.file_type().map_err(|_| storage())?.is_dir() {
                continue;
            }
            let Some(agent) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !agent_valid(&agent) {
                continue;
            }
            for p in self.records(&agent)? {
                if (p.text("sharerAgentId") == ctx.agent_id.as_str()
                    || p.text("proposerAgentId") == ctx.agent_id.as_str())
                    && p.reachable(ctx)
                    && status.is_none_or(|s| s == p.text("status"))
                {
                    items.push(p.public());
                }
            }
        }
        items.sort_by(|a, b| {
            b["createdAt"]
                .as_f64()
                .unwrap_or(0.)
                .total_cmp(&a["createdAt"].as_f64().unwrap_or(0.))
        });
        let truncated = items.len() > limit;
        items.truncate(limit);
        Ok(json!({"agentId":ctx.agent_id,"items":items,"truncated":truncated,"unreadable":0}))
    }
}
