//! Owner-bound skill extraction. Produces proposals for review and retains terminal decisions.
pub(crate) mod benefit;
mod evidence;

use super::{
    lance_scope::LanceScope,
    llm::{has_direct_transport, CompleteFor, JobCompletion},
    rate_limit::{Key, RateLimitStore},
    registry::{JobBody, JobContext, JobReport},
    skill_decisions::{Decision, Evidence, Fingerprint, Memo, Policy},
};
use crate::{
    context::RequestContext,
    contract::{
        Cancel, EngineError, JobName, JobOutcome, LlmParams, MemoryRow, Message, MessageRole,
        StoreError,
    },
    recall::{acl, lifecycle::is_recall_entry_live, tombstone_mask::TombstoneMask},
    store::{directory::TrustedDirectory, kernel_lease},
    text::{
        js::{js_trim, utf16_slice},
        json::{write_json, TolerantJsonValue as Json},
    },
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

const SYSTEM: &str = include_str!("prompts/templates/skill-extraction-plugin.v3.txt");
const PROPOSALS: &str = "skill-proposals.jsonl";
const REJECTIONS: &str = "skill-rejected.jsonl";
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_ROWS: usize = 5000;
const INTERVAL_MS: f64 = 20. * 3_600_000.;
const LOOKBACK_MS: i64 = 30 * 86_400_000;

pub(crate) struct SkillMiner {
    pub scope: Arc<LanceScope>,
    pub base: PathBuf,
    pub completion: Option<Arc<CompleteFor>>,
}

impl JobBody for SkillMiner {
    fn name(&self) -> JobName {
        JobName::SkillMiner
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let cancel = &cancel.limited_to(Instant::now() + Duration::from_secs(240));
        let authority = context.authority()?;
        let (principal, agent) = authority.caller();
        let _operation = self.scope.operations.enter(principal, agent)?;
        let host = self.scope.operations.host_handle();
        let raw = serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?;
        let config = crate::config::effective_config(&raw).map_err(|_| StoreError::InvalidInput)?;
        let settings = &config["skillMiner"];
        if settings["enabled"] == false {
            return Ok(report(JobOutcome::Skipped, "skillMiner_disabled"));
        }
        if let Some(skip) = self.scope.check(authority, cancel)? {
            return Ok(skip);
        }
        let request = authority.request();
        let Some(store) = self.scope.stores.existing_private(request)? else {
            return Ok(JobReport::completed());
        };
        let Some(route) = JobCompletion::resolve(
            authority,
            self.completion.as_deref(),
            host.clone(),
            &config,
            "skill-extraction",
            settings,
        ) else {
            return Ok(report(JobOutcome::Skipped, "no_llm_config"));
        };
        let binding =
            crate::recall::knowledge::private_key(request).ok_or(StoreError::InvalidInput)?;
        let dir = TrustedDirectory::open(&self.base)?
            .create_child("_skills")?
            .create_child(&binding)?;
        let lease = kernel_lease::acquire(&dir, "skill-miner", cancel, &mut || {})?;
        let check = || -> Result<(), EngineError> {
            lease.check(&dir)?;
            if self.scope.check(authority, cancel)?.is_some()
                || serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)? != raw
            {
                return Err(StoreError::Unavailable.into());
            }
            Ok(())
        };
        let clock = host.clone();
        let state = RateLimitStore::open(dir.path(), Arc::new(move || clock.now_ms() as f64))?;
        let key = Key::new("skill-miner", Some(context.agent.as_str()), Some(&binding))?;
        let limit = state.check(&key, INTERVAL_MS, cancel)?;
        if super::metadata::get(&limit, "allowed")
            != Some(&crate::text::json::TolerantJsonValue::Bool(true))
        {
            return Ok(report(JobOutcome::Skipped, "rate_limited"));
        }
        let memo = Memo::new(&state, &binding[..32])?;
        let (mut catalogue, mut committed, mut physical) = read_catalogue(&dir, request, cancel)?;
        let blocked_names = rejected_names(&dir, cancel)?;
        let mut filter = LanceScope::filter(authority);
        filter.status = Some("active".into());
        filter.since = Some(context.now_ms.saturating_sub(LOOKBACK_MS));
        filter.until = Some(context.now_ms);
        let tombstones = TombstoneMask::new(&self.base);
        let mut memories = BTreeMap::new();
        for row in store.skill_evidence(&filter, MAX_ROWS)? {
            cancel.check()?;
            if owned(&row, request, context.now_ms)
                && !tombstones.masks(&row)?
                && memories.insert(row.id.clone(), row).is_some()
            {
                return Err(StoreError::Corrupt.into());
            }
        }
        let rows: Vec<_> = memories.into_values().collect();
        let groups = evidence::groups(&rows, cancel)?;
        let max = settings["maxPerRun"].as_u64().unwrap_or(5).min(8) as usize;
        let minimum = settings["minConfidence"].as_f64().unwrap_or(0.6);
        let score = settings["minEvidenceScore"].as_f64().unwrap_or(3.);
        let direct = has_direct_transport(settings);
        let catalog_id = catalogue_hash(&catalogue, &blocked_names)?;
        let policy = Policy {
            model: route.route_model().unwrap_or("host-default"),
            kind: if direct {
                "direct-override"
            } else {
                "host-routed"
            },
            base_url: settings["baseUrl"].as_str().unwrap_or_default(),
            prompt_version: "3",
            min_confidence: Some(minimum),
            min_evidence_score: Some(score),
            catalogue: &catalog_id,
        };
        let mut decisions = vec![];
        let mut proposals = 0;
        let mut cached = 0;
        let mut failures = 0;
        let mut calls = 0;
        for group in &groups {
            if calls >= max || proposals >= max {
                break;
            }
            if (group.score as f64) < score {
                continue;
            }
            let sources: Vec<_> = group
                .rows
                .iter()
                .map(|&i| Evidence {
                    row: &rows[i],
                    contradictory: false,
                })
                .collect();
            let fingerprint = Fingerprint::for_cluster(&sources, &policy);
            if route.route_model().is_some()
                && memo
                    .get(&fingerprint, context.now_ms as f64, cancel)?
                    .is_some()
            {
                cached += 1;
                continue;
            }
            let (params, evidence_ids, related) = prompt(group, &rows, &catalogue);
            let recheck = || -> Result<(), EngineError> {
                check()?;
                let mask = TombstoneMask::new(&self.base);
                for &i in &group.rows {
                    cancel.check()?;
                    let old = &rows[i];
                    let fresh = store.get(&old.id)?.ok_or(StoreError::Unavailable)?;
                    if !owned(&fresh, request, context.now_ms)
                        || mask.masks(&fresh)?
                        || !evidence_same(&fresh, old)
                    {
                        return Err(StoreError::Unavailable.into());
                    }
                }
                Ok(())
            };
            {
                let _mutation = self.scope.operations.mutation()?;
                recheck()?;
            }
            calls += 1;
            let answer = route.complete_json(
                params,
                &cancel.limited_to(Instant::now() + Duration::from_secs(30)),
            );
            cancel.check()?;
            let Some(candidate) = answer
                .ok()
                .and_then(|answer| parse_candidate(&answer.text, &related))
            else {
                failures += 1;
                continue;
            };
            let Some(mut candidate) = candidate.filter(|item| {
                item["confidence"]
                    .as_f64()
                    .is_some_and(|confidence| confidence >= minimum)
            }) else {
                decisions.push((fingerprint, Decision::LowConfidence));
                continue;
            };
            if let Err(decision) =
                bind_proposal(&mut candidate, &catalogue, &blocked_names, &evidence_ids)?
            {
                decisions.push((fingerprint, decision));
                continue;
            }
            let name = candidate["skillName"].as_str().ok_or(StoreError::Corrupt)?;
            let id = format!(
                "skill-{:x}",
                Sha256::digest(
                    format!("{}\0{}\0{}", binding, fingerprint.as_str(), name).as_bytes()
                )
            );
            let timestamp = chrono::DateTime::from_timestamp_millis(context.now_ms)
                .ok_or(StoreError::InvalidInput)?
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let grade = sources
                .iter()
                .filter(|source| evidence_ids.contains(&source.row.id))
                .map(|source| match source.row.epistemic_status.as_str() {
                    "trusted" => 2,
                    "corroborated" => 1,
                    _ => 0,
                })
                .min()
                .unwrap_or(0);
            candidate["id"] = id.clone().into();
            candidate["proposedAt"] = timestamp.into();
            candidate["status"] = "pending_review".into();
            candidate["agentId"] = json!(request.agent_id);
            candidate["workspaceKey"] = request.workspace_key.clone().into();
            candidate["aclBindings"] = json!({
                "scope":"agent-private","agentId":request.agent_id,
                "workspaceIdentity":request.workspace_key,"ownerUserId":request.owner_user_id,
            });
            candidate["evidence"] = json!({"memoryIds":evidence_ids,"score":group.score,
                "llmConfidence":candidate["confidence"],"grade":(["observed","corroborated","trusted"][grade])});
            candidate
                .as_object_mut()
                .ok_or(StoreError::Corrupt)?
                .remove("targetSkillName");
            let _mutation = self.scope.operations.mutation()?;
            recheck()?;
            if !catalogue.iter().any(|item| item["id"] == id) {
                append_proposal(&dir, &candidate, &mut committed, &mut physical)?;
                catalogue.push(candidate);
                proposals += 1;
            }
        }
        check()?;
        if route.route_model().is_some() {
            memo.record(&decisions, cancel)?;
        }
        if failures == 0 {
            state.record(&key, cancel)?;
        }
        for (name, value) in [
            ("scanned", rows.len()),
            ("groups", groups.len()),
            ("llmCalls", calls),
            ("proposalsCreated", proposals),
            ("skippedKnownCluster", cached),
            ("extractionFailures", failures),
        ] {
            context.note_count(name, value)?;
        }
        if failures > 0 {
            return Ok(report(JobOutcome::Incomplete, "skill_extraction_retry"));
        }
        Ok(JobReport::completed())
    }
}

fn owned(row: &MemoryRow, ctx: &RequestContext, now: i64) -> bool {
    row.agent_id == ctx.agent_id.as_str()
        && row.stored_by == ctx.agent_id.as_str()
        && row.owner_user_id == ctx.owner_user_id
        && row.workspace_key == ctx.workspace_key
        && row.workspace_id == ctx.workspace_key
        && row.scope == "agent-private"
        && matches!(
            row.epistemic_status.as_str(),
            "observed" | "corroborated" | "trusted"
        )
        && is_recall_entry_live(row, now, None)
        && acl::allowed(row, ctx).is_ok()
}

fn evidence_same(current: &MemoryRow, old: &MemoryRow) -> bool {
    current.text == old.text
        && current.updated_at == old.updated_at
        && current.version_number == old.version_number
        && current.category == old.category
        && current.epistemic_status == old.epistemic_status
        && current.source_message_role == old.source_message_role
}

fn read_catalogue(
    dir: &TrustedDirectory,
    ctx: &RequestContext,
    cancel: &Cancel,
) -> Result<(Vec<Value>, usize, usize), EngineError> {
    let Some(bytes) = super::ledger::io::read(dir, PROPOSALS, MAX_BYTES, cancel)? else {
        return Ok((vec![], 0, 0));
    };
    let committed = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    let mut catalogue = BTreeMap::new();
    for line in bytes[..committed]
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        cancel.check()?;
        let item: Value = serde_json::from_slice(line).map_err(|_| StoreError::Corrupt)?;
        let bindings = &item["aclBindings"];
        if bindings["scope"] != "agent-private"
            || bindings["agentId"] != ctx.agent_id.as_str()
            || bindings["ownerUserId"] != ctx.owner_user_id
            || bindings["workspaceIdentity"] != ctx.workspace_key
        {
            return Err(StoreError::Corrupt.into());
        }
        let id = item["id"].as_str().ok_or(StoreError::Corrupt)?.to_owned();
        catalogue.insert(id, item);
    }
    let visible = catalogue
        .into_values()
        .filter(|item| {
            matches!(
                item["status"].as_str(),
                Some("active" | "pending_review" | "activation_partial" | "rejected")
            )
        })
        .collect();
    Ok((visible, committed, bytes.len()))
}

fn append_proposal(
    dir: &TrustedDirectory,
    proposal: &Value,
    committed: &mut usize,
    physical: &mut usize,
) -> Result<(), EngineError> {
    let record =
        crate::text::json::parse_json(&proposal.to_string()).map_err(|_| StoreError::Corrupt)?;
    let next = committed
        .checked_add(write_json(&record).len() + 1)
        .filter(|&size| size <= MAX_BYTES)
        .ok_or(StoreError::Unavailable)?;
    if *committed < *physical {
        dir.truncate_jsonl_tail(PROPOSALS, *physical as u64, *committed as u64)?;
    }
    dir.append_jsonl_durable(PROPOSALS, &record, 128 * 1024)?;
    *committed = next;
    *physical = next;
    Ok(())
}

fn catalogue_hash(catalogue: &[Value], blocked: &BTreeSet<String>) -> Result<String, StoreError> {
    let values: Vec<_> = catalogue
        .iter()
        .map(|p| {
            json!([
                p["id"],
                p["skillName"],
                p["status"],
                p["instructions"],
                p["updatedAt"].as_str().unwrap_or_default(),
            ])
        })
        .collect();
    let bytes = serde_json::to_vec(&(values, blocked)).map_err(|_| StoreError::Corrupt)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn rejected_names(
    dir: &TrustedDirectory,
    cancel: &Cancel,
) -> Result<BTreeSet<String>, EngineError> {
    let mut names = BTreeSet::new();
    if let Some(bytes) = super::ledger::io::read(dir, REJECTIONS, MAX_BYTES, cancel)? {
        if !bytes.is_empty() && !bytes.ends_with(b"\n") {
            return Err(StoreError::Corrupt.into());
        }
        for line in bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
        {
            cancel.check()?;
            let item: Value = serde_json::from_slice(line).map_err(|_| StoreError::Corrupt)?;
            let name = item["skillName"]
                .as_str()
                .filter(|name| valid_name(name))
                .ok_or(StoreError::Corrupt)?;
            names.insert(name.to_owned());
        }
    }
    Ok(names)
}

fn bind_proposal(
    candidate: &mut Value,
    catalogue: &[Value],
    blocked: &BTreeSet<String>,
    evidence_ids: &[String],
) -> Result<Result<(), Decision>, EngineError> {
    let prior = matched(candidate, catalogue, evidence_ids);
    let name = prior.unwrap_or(candidate)["skillName"]
        .as_str()
        .ok_or(StoreError::Corrupt)?;
    if blocked.contains(name)
        || candidate["skillName"]
            .as_str()
            .is_some_and(|name| blocked.contains(name))
        || prior.is_some_and(|prior| prior["status"] == "rejected")
    {
        return Ok(Err(Decision::BlockedName));
    }
    let Some(prior) = prior else {
        return Ok(Ok(()));
    };
    if prior["status"] != "active"
        || duplicate(candidate, prior, evidence_ids)
        || catalogue.iter().any(|item| {
            item["skillName"] == name
                && matches!(
                    item["status"].as_str(),
                    Some("pending_review" | "activation_partial")
                )
        })
    {
        return Ok(Err(Decision::Duplicate));
    }
    let base = prior["instructions"].as_str().ok_or(StoreError::Corrupt)?;
    let extension = candidate["instructions"]
        .as_str()
        .ok_or(StoreError::Corrupt)?;
    let instructions = format!("{base}\n\n{extension}");
    if instructions.encode_utf16().count() > 24_000 {
        return Err(StoreError::Unavailable.into());
    }
    let base_hash = format!("{:x}", Sha256::digest(base.as_bytes()));
    let extension = extension.to_owned();
    candidate["updateOf"] = prior["id"].clone();
    candidate["skillName"] = prior["skillName"].clone();
    candidate["skillTitle"] = prior["skillTitle"].clone();
    candidate["baseInstructionsHash"] = base_hash.into();
    candidate["extensionInstructions"] = extension.into();
    candidate["instructions"] = instructions.into();
    Ok(Ok(()))
}

fn prompt(
    group: &evidence::Group,
    rows: &[MemoryRow],
    catalogue: &[Value],
) -> (LlmParams, Vec<String>, BTreeSet<String>) {
    let mut indices = group.rows.clone();
    indices.sort_by_key(|&index| std::cmp::Reverse(evidence::time(&rows[index])));
    let memories: Vec<_> = indices
        .iter()
        .take(12)
        .filter_map(|&i| {
            let row = &rows[i];
            let text = utf16_slice(&row.text, 0, 1800);
            (!text.is_empty()).then_some((&row.id, text))
        })
        .collect();
    let words = evidence::terms(
        &group
            .rows
            .iter()
            .take(24)
            .map(|&i| rows[i].text.as_str())
            .collect::<Vec<_>>()
            .join(" "),
    );
    let mut related: Vec<_> = catalogue
        .iter()
        .map(|item| (item, evidence::overlap(&words, &proposal_terms(item))))
        .collect();
    related.sort_by(|a, b| b.1.total_cmp(&a.1));
    related.truncate(8);
    let related_names = related
        .iter()
        .filter_map(|(item, _)| item["skillName"].as_str().map(str::to_owned))
        .collect();
    let entries = related
        .into_iter()
        .map(|(item, _)| {
            Json::Object(vec![
                (
                    "skillName".into(),
                    json_string(&item["skillName"], usize::MAX),
                ),
                (
                    "skillTitle".into(),
                    json_string(&item["skillTitle"], usize::MAX),
                ),
                ("status".into(), json_string(&item["status"], usize::MAX)),
                ("description".into(), json_string(&item["description"], 300)),
                (
                    "instructions".into(),
                    json_string(&item["instructions"], 1200),
                ),
            ])
        })
        .collect();
    let evidence = memories
        .iter()
        .map(|(id, text)| {
            Json::Object(vec![
                ("id".into(), Json::String(id.as_str().into())),
                ("text".into(), Json::String(text.clone())),
            ])
        })
        .collect();
    let user = write_json(&Json::Object(vec![
        ("memories".into(), Json::Array(evidence)),
        ("existingSkills".into(), Json::Array(entries)),
    ]));
    let params = LlmParams {
        messages: vec![
            Message {
                role: MessageRole::System,
                content: SYSTEM.trim_end_matches('\n').into(),
            },
            Message {
                role: MessageRole::User,
                content: user,
            },
        ],
        model: None,
        max_tokens: Some(1200.into()),
        temperature: Some(0.into()),
    };
    (
        params,
        memories.into_iter().map(|(id, _)| id.clone()).collect(),
        related_names,
    )
}

fn json_string(value: &Value, max: usize) -> Json {
    Json::String(utf16_slice(value.as_str().unwrap_or_default(), 0, max))
}

fn cut(value: &Value, max: usize) -> String {
    utf16_slice(value.as_str().unwrap_or_default(), 0, max).to_utf8_lossy()
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn parse_candidate(response: &str, related: &BTreeSet<String>) -> Option<Option<Value>> {
    let parsed: Value = serde_json::from_str(response).ok()?;
    if parsed["skip"] == true {
        return Some(None);
    }
    let confidence = parsed["confidence"]
        .as_f64()
        .or_else(|| parsed["confidence"].as_str()?.trim().parse().ok())?;
    if !(0. ..=1.).contains(&confidence) {
        return None;
    }
    if confidence < 0.6 {
        return Some(None);
    }
    let name = js_trim(parsed["skillName"].as_str()?);
    let instructions = js_trim(parsed["instructions"].as_str()?);
    if !valid_name(name) || instructions.is_empty() || instructions.encode_utf16().count() > 12_000
    {
        return None;
    }
    if !parsed["targetSkillName"].is_null()
        && !parsed["targetSkillName"]
            .as_str()
            .is_some_and(|name| related.contains(name))
    {
        return None;
    }
    let title = parsed["skillTitle"]
        .as_str()
        .filter(|value| !value.is_empty())
        .unwrap_or(name);
    let examples: Vec<_> = parsed["examples"]
        .as_array()
        .into_iter()
        .flatten()
        .take(12)
        .map(|value| cut(value, 1000))
        .collect();
    Some(Some(json!({
        "skillName":name,"skillTitle":utf16_slice(title,0,200).to_utf8_lossy(),
        "description":cut(&parsed["description"], 1200),"instructions":instructions,
        "examples":examples,"benefit":utf16_slice(js_trim(parsed["benefit"].as_str().unwrap_or_default()), 0, 400).to_utf8_lossy(),"confidence":confidence,
        "category":parsed["category"].as_str().unwrap_or("workflow"),
        "targetSkillName":parsed["targetSkillName"],
    })))
}

fn proposal_terms(value: &Value) -> BTreeSet<String> {
    evidence::terms(
        &["skillName", "skillTitle", "description", "instructions"]
            .into_iter()
            .filter_map(|field| value[field].as_str())
            .collect::<Vec<_>>()
            .join(" "),
    )
}
fn ids(item: &Value) -> BTreeSet<&str> {
    item["evidence"]["memoryIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}
fn matched<'a>(candidate: &Value, catalogue: &'a [Value], source: &[String]) -> Option<&'a Value> {
    let terms = proposal_terms(candidate);
    let source: BTreeSet<_> = source.iter().map(String::as_str).collect();
    let mut options: Vec<_> = catalogue
        .iter()
        .filter_map(|item| {
            let score = evidence::overlap(&terms, &proposal_terms(item));
            let weight = if !candidate["targetSkillName"].is_null()
                && candidate["targetSkillName"] == item["skillName"]
            {
                3.
            } else if candidate["skillName"] == item["skillName"] {
                2.
            } else if score >= 0.72
                || (score >= 0.35 && evidence::overlap(&source, &ids(item)) >= 0.8)
            {
                score
            } else {
                return None;
            };
            Some((item, weight))
        })
        .collect();
    options.sort_by(|a, b| b.1.total_cmp(&a.1));
    options
        .iter()
        .find(|(item, _)| item["status"] == "rejected")
        .or_else(|| options.first())
        .map(|(item, _)| *item)
}

fn duplicate(candidate: &Value, prior: &Value, source: &[String]) -> bool {
    let normalize = |name: &Value| {
        crate::text::js::nfkc(name.as_str().unwrap_or_default())
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let new = normalize(&candidate["instructions"]);
    let same = !new.is_empty()
        && (normalize(&prior["instructions"]).contains(&new)
            || normalize(&prior["extensionInstructions"]) == new);
    let old = ids(prior);
    same || (source.iter().all(|id| old.contains(id.as_str()))
        && evidence::overlap(&proposal_terms(candidate), &proposal_terms(prior)) >= 0.85)
}

fn report(outcome: JobOutcome, reason: &str) -> JobReport {
    JobReport {
        outcome,
        reason: Some(reason.into()),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "fixed Node recording")]
mod tests {
    use super::*;

    #[test]
    fn blocked_names_and_version_extensions_use_the_private_catalogue() {
        let mut candidate = json!({"skillName":"release-checksums","instructions":"Verify the detached signature."});
        let base = json!({"id":"active-v1","skillName":"release-checksums","skillTitle":"Release checksums",
            "status":"active","instructions":"Generate a checksum."});
        let blocked = BTreeSet::from(["release-checksums".to_owned()]);
        assert_eq!(
            bind_proposal(&mut candidate, &[], &blocked, &[]).unwrap(),
            Err(Decision::BlockedName)
        );
        let clear = BTreeSet::new();
        assert!(bind_proposal(
            &mut candidate,
            std::slice::from_ref(&base),
            &clear,
            &["new".into()]
        )
        .unwrap()
        .is_ok());
        assert_eq!(candidate["updateOf"], "active-v1");
        assert_eq!(
            candidate["extensionInstructions"],
            "Verify the detached signature."
        );
        assert_eq!(
            candidate["instructions"],
            "Generate a checksum.\n\nVerify the detached signature."
        );
        assert_eq!(
            candidate["baseInstructionsHash"],
            format!("{:x}", Sha256::digest(b"Generate a checksum."))
        );
        assert_ne!(
            catalogue_hash(&[], &blocked).unwrap(),
            catalogue_hash(&[], &clear).unwrap()
        );
    }

    #[test]
    fn extraction_prompt_matches_plugin_version_three_even_at_a_split_surrogate() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/jobs/skill-prompt.json"))
                .unwrap();
        let rows: Vec<_> = fixture["memories"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| {
                let mut row = crate::capture::row_defaults::schema_defaults(vec![]);
                row.id = value["id"].as_str().unwrap().into();
                row.text = value["text"].as_str().unwrap().into();
                row.created_at = value["createdAt"].as_number().unwrap().clone();
                row
            })
            .collect();
        let (params, ids, names) = prompt(
            &evidence::Group {
                rows: vec![0, 1],
                score: 4,
            },
            &rows,
            fixture["existingSkills"].as_array().unwrap(),
        );
        assert_eq!(json!(params.messages), fixture["expected"]["messages"]);
        assert_eq!(json!(params.max_tokens), fixture["expected"]["maxTokens"]);
        assert_eq!(
            json!(params.temperature),
            fixture["expected"]["temperature"]
        );
        assert_eq!(ids, ["newer", "older"]);
        assert!(names.contains("release-checksums"));
    }
}
