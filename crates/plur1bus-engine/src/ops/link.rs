//! Idempotent source links: caller-visible cards, per-agent receipts, no card writes.
use super::{
    archive,
    context::error,
    import_lock,
    ledgers::read_lines,
    memory::{valid_id, MemoryReader},
};
use crate::{
    contract::{
        AgentContext, Cancel, EngineError, MemoryLinkOutcome, MemoryLinkRequest, MemoryLinkResult,
        MemoryOpErrorCode, Principal, TurnOrigin,
    },
    store::ledger::JsonlLedger,
    text::js::{js_trim, utf16_len},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, time::Duration};

/// A stable link identifier; this real hash retains Node UTF-8 semantics.
#[must_use]
pub fn link_id(agent: &str, card: &str, source: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("plur1bus.memory.link.v1\0{agent}\0{card}\0{source}").as_bytes())
    )[..32]
        .to_owned()
}
/// Valid import run identifiers are bounded ASCII, not arbitrary source text.
#[must_use]
pub fn valid_run_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
/// A capped or ambiguous source reference cannot prove an import run.
#[must_use]
pub fn source_ref_run_id(source: &str) -> String {
    if utf16_len(source) >= 500 {
        return String::new();
    }
    let mut found = "";
    for segment in source.split(';').skip(1) {
        if let Some(id) = segment.strip_prefix("run=") {
            if !valid_run_id(id) || (!found.is_empty() && found != id) {
                return String::new();
            }
            found = id;
        }
    }
    found.to_owned()
}
struct Plan {
    source: String,
    run: String,
    key: Option<String>,
    dry: bool,
}
impl Plan {
    fn new(id: &str, request: &MemoryLinkRequest) -> Result<Self, EngineError> {
        let source = js_trim(&request.source_ref);
        if !valid_id(id)
            || source.is_empty()
            || utf16_len(source) > 500
            || request
                .import_run_id
                .as_ref()
                .is_some_and(|run| !valid_run_id(run))
        {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let key = request
            .idempotency_key
            .as_deref()
            .map(js_trim)
            .map(str::to_owned);
        if key
            .as_ref()
            .is_some_and(|key| key.is_empty() || utf16_len(key) > 256)
        {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        Ok(Self {
            source: source.to_owned(),
            run: request
                .import_run_id
                .clone()
                .unwrap_or_else(|| source_ref_run_id(source)),
            key,
            dry: request.dry_run == Some(true),
        })
    }
}
struct Classification {
    outcome: MemoryLinkOutcome,
    run: Option<String>,
}
fn classify(
    base: &Path,
    agent: &str,
    id: &str,
    link: &str,
    plan: &Plan,
) -> Result<Classification, EngineError> {
    let read = |folder| {
        read_lines(&base.join(folder).join(format!("{agent}.jsonl")))
            .map_err(|_| error(MemoryOpErrorCode::Storage))
    };
    let mut own_source = None;
    for row in read("_imports")? {
        if row["v"].as_f64() != Some(1.)
            || row["cardId"] != id
            || !row["idempotencyKey"].is_string()
        {
            continue;
        }
        if row["kind"] == "unimported" {
            own_source = None;
        } else if row["kind"].is_null() {
            own_source = row["sourceRef"].as_str().map(str::to_owned);
        }
    }
    if own_source.as_deref() == Some(plan.source.as_str()) {
        return Ok(Classification {
            outcome: MemoryLinkOutcome::AlreadySource,
            run: None,
        });
    }
    let mut latest = BTreeMap::new();
    for row in read("_links")? {
        if row["v"].as_f64() != Some(1.)
            || !row["cardId"].is_string()
            || !matches!(row["kind"].as_str(), Some("linked" | "unlinked"))
            || (row["kind"] == "linked" && !row["sourceRef"].is_string())
        {
            continue;
        }
        if let Some(link) = row["linkId"].as_str() {
            latest.insert(link.to_owned(), row);
        }
    }
    if let Some(existing) = latest.get(link).filter(|row| row["kind"] == "linked") {
        return Ok(Classification {
            outcome: MemoryLinkOutcome::AlreadyLinked,
            run: existing["importRunId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
        });
    }
    if latest
        .values()
        .filter(|row| row["kind"] == "linked" && row["cardId"] == id)
        .count()
        >= 100
    {
        return Err(error(MemoryOpErrorCode::Conflict));
    }
    Ok(Classification {
        outcome: MemoryLinkOutcome::Linked,
        run: (!plan.run.is_empty()).then(|| plan.run.clone()),
    })
}
impl MemoryReader {
    /// Attach import provenance to a visible card, preserving its row and vector byte-for-byte.
    pub fn link(
        &self,
        id: &str,
        request: &MemoryLinkRequest,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryLinkResult, EngineError> {
        self.link_at(id, request, principal, agent, self.context.host().now_ms())
    }
    /// Apply at one operation time; dry runs never acquire locks or create sidecars.
    pub fn link_at(
        &self,
        id: &str,
        request: &MemoryLinkRequest,
        principal: &Principal,
        agent: &AgentContext,
        now: i64,
    ) -> Result<MemoryLinkResult, EngineError> {
        // This gate precedes request resolution, matching the system-only mutation contract.
        if agent.origin != TurnOrigin::System || agent.background {
            return Err(error(MemoryOpErrorCode::Denied));
        }
        let operation = self.context.enter(principal, agent)?;
        let ctx = &operation.context;
        let plan = Plan::new(id, request)?;
        let workspace = self
            .context
            .host()
            .workspace_dir(&ctx.agent_id)
            .map_err(|_| error(MemoryOpErrorCode::Storage))?;
        let agent_id = ctx.agent_id.as_str();
        let link = link_id(agent_id, id, &plan.source);
        let lease = if plan.dry {
            None
        } else {
            Some(import_lock::acquire(
                &self.base,
                agent_id,
                &Cancel::never(),
                Duration::from_secs(120),
            )?)
        };
        let fence = || {
            if let Some(lease) = &lease {
                lease.assert_held()?;
            }
            self.context.assert_open()
        };
        fence()?;
        self.find_visible(id, ctx, now)?;
        let decision = classify(&self.base, agent_id, id, &link, &plan)?;
        if !plan.dry && decision.outcome == MemoryLinkOutcome::Linked {
            let mut receipt = json!({"v":1,"kind":"linked","linkId":link,"cardId":id,"sourceRef":plan.source,"provenance":"imported","at":now});
            if !plan.run.is_empty() {
                receipt["importRunId"] = json!(plan.run);
            }
            if let Some(key) = &plan.key {
                receipt["idempotencyKey"] = json!(key);
            }
            fence()?;
            JsonlLedger::<Value>::open(&self.base.join("_links").join(format!("{agent_id}.jsonl")))
                .and_then(|ledger| ledger.append_durable(&receipt))
                .map_err(|_| error(MemoryOpErrorCode::Storage))?;
            if let Some(workspace) = workspace
                .as_ref()
                .filter(|path| !path.as_os_str().is_empty())
            {
                fence()?;
                archive::audit(
                    workspace,
                    &json!({"event":"memory.linked","source":"memory_link","agentId":agent_id,"memoryId":id,"linkId":link,"importRunId":plan.run,"result":"committed","timestamp":archive::iso(now)?}),
                )?;
            }
        }
        Ok(MemoryLinkResult {
            id: id.to_owned(),
            link_id: link,
            outcome: decision.outcome,
            import_run_id: decision.run,
            dry_run: plan.dry,
        })
    }
}
