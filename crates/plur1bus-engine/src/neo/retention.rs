//! N2 scheduled retention. The append emergency ceiling is a separate protocol.
use super::{
    append_cap_io,
    append_source::SourceProof,
    capture_journal::CaptureJournal,
    derived_fields::validate_object,
    journal_io,
    merged_order::{field, string, truthy},
    store_policy::{record_time_ms, StorePolicy},
};
use crate::{
    capture::dynamics::number,
    context::RequestContext,
    contract::{Cancel, EngineError, HostServices, JobName, StoreError},
    jobs::{authority::JobAuthority, ledger::io},
    store::directory::TrustedDirectory,
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue as Json},
    },
};
use flate2::{Compression, GzBuilder};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::Write,
};

const DAY_MS: f64 = 86_400_000.;
const MAX_MONTH_BYTES: usize = 128 * 1024 * 1024;

const FILES: &[&str] = &[
    "turn-journal.jsonl",
    "reaction-ledger.jsonl",
    "behavior-cards.jsonl",
    "embedding-queue.jsonl",
    "pattern-analysis.jsonl",
    "retrieval-ledger.jsonl",
    "reconsolidation-events.jsonl",
];

#[derive(Eq, Hash, PartialEq)]
enum Key {
    Id(JsString),
    Edge(JsString, JsString, JsString),
    Other(usize),
}
fn key(record: &Json, index: usize) -> Key {
    let value = |name| {
        field(record, name)
            .filter(|value| !matches!(value, Json::Null))
            .map(string)
    };
    if let Some(id) = value("id") {
        return Key::Id(id);
    }
    match (value("source"), value("target")) {
        (Some(source), Some(target)) => Key::Edge(
            source,
            target,
            field(record, "type")
                .filter(|v| truthy(v))
                .map_or_else(|| JsString::from(""), string),
        ),
        _ => Key::Other(index),
    }
}
struct Group<'a> {
    rows: Vec<usize>,
    latest: &'a Json,
    time: f64,
    eligible: bool,
}
fn quality(record: &Json, key: &str, fallback: f64) -> f64 {
    let score = number(field(record, key));
    if score.is_finite() {
        score
    } else {
        fallback
    }
}
fn status(row: &Json) -> Option<&str> {
    match field(row, "status") {
        Some(Json::String(value)) if value == &JsString::from("promoted") => Some("promoted"),
        Some(Json::String(value)) if value == &JsString::from("active") => Some("active"),
        Some(Json::String(value)) if value == &JsString::from("pending") => Some("pending"),
        Some(Json::String(value))
            if ["conflict", "demoted", "pruned", "tombstoned"]
                .iter()
                .any(|name| value == &JsString::from(*name)) =>
        {
            Some("weak")
        }
        _ => None,
    }
}
fn protected(row: &Json) -> bool {
    matches!(field(row, "neverForget"), Some(Json::Bool(true)))
        || quality(row, "neverForget", 0.) == 1.
        || status(row) == Some("pending")
        || (matches!(status(row), Some("active" | "promoted"))
            && quality(row, "confidence", 0.).max(quality(row, "salience", 0.)) >= 0.6)
        || (field(row, "source").is_some()
            && field(row, "target").is_some()
            && quality(row, "strength", 0.) >= 0.6)
}
fn rank(record: &Json) -> u8 {
    match status(record) {
        Some("promoted") => 3,
        Some("active") => 2,
        Some("weak") => 0,
        _ => 1,
    }
}
fn weight(record: &Json) -> f64 {
    field(record, "salience")
        .filter(|v| !matches!(v, Json::Null))
        .map_or_else(
            || quality(record, "strength", 0.5),
            |_| quality(record, "salience", 0.5),
        )
}

fn select(
    rows: &[Json],
    soft_max: usize,
    cutoff: f64,
    cancel: &Cancel,
    owned: impl Fn(&Json) -> bool,
    pending: &HashSet<JsString>,
) -> Result<Vec<bool>, EngineError> {
    let mut keep = vec![true; rows.len()];
    if rows.len() <= soft_max {
        return Ok(keep);
    }
    let mut groups = HashMap::<Key, Group<'_>>::new();
    for (index, row) in rows.iter().enumerate() {
        cancel.check()?;
        let time = record_time_ms(row)?.unwrap_or(f64::INFINITY);
        let key = key(row, index);
        let eligible = owned(row) && !matches!(&key, Key::Id(id) if pending.contains(id));
        let group = groups.entry(key).or_insert_with(|| Group {
            rows: Vec::new(),
            latest: row,
            time,
            eligible,
        });
        group.rows.push(index);
        group.eligible &= eligible;
        if time >= group.time {
            group.latest = row;
            group.time = time;
        }
    }
    let mut eligible: Vec<_> = groups
        .into_values()
        .filter(|group| group.eligible && group.time < cutoff && !protected(group.latest))
        .collect();
    eligible.sort_by(|a, b| {
        rank(a.latest)
            .cmp(&rank(b.latest))
            .then_with(|| weight(a.latest).total_cmp(&weight(b.latest)))
            .then_with(|| {
                quality(a.latest, "confidence", 0.5).total_cmp(&quality(
                    b.latest,
                    "confidence",
                    0.5,
                ))
            })
            .then_with(|| a.time.total_cmp(&b.time))
            .then_with(|| a.rows[0].cmp(&b.rows[0]))
    });
    let mut remaining = rows.len();
    for group in eligible {
        cancel.check()?;
        if remaining <= soft_max {
            break;
        }
        for index in group.rows {
            keep[index] = false;
            remaining -= 1;
        }
    }
    Ok(keep)
}

fn private(row: &Json, ctx: &RequestContext) -> bool {
    journal_io::owned(row, ctx)
        && field(row, "scope") == Some(&super::derived_fields::text("agent_private"))
}

fn pending_targets(
    dir: &TrustedDirectory,
    cancel: &Cancel,
) -> Result<HashSet<JsString>, EngineError> {
    let mut queue = HashMap::new();
    for row in journal_io::rows(dir, "embedding-queue.jsonl", cancel)? {
        cancel.check()?;
        let binding = ["ownerUserId", "agentId", "workspaceKey", "scope"]
            .map(|key| field(&row, key).map(string));
        queue.insert((journal_io::id(&row)?, binding), row);
    }
    Ok(queue
        .values()
        .filter(|row| status(row) == Some("pending"))
        .filter_map(|row| field(row, "targetId").map(string))
        .collect())
}

/// Apply retention in the capture writer's canonical workspace, through its existing
/// owner, policy, lock and pending-publication checks.
pub fn run_for_job(
    journal: &CaptureJournal,
    authority: &JobAuthority,
    host: std::sync::Arc<dyn HostServices>,
    cancel: &Cancel,
) -> Result<usize, EngineError> {
    if authority.job() != JobName::ConsolidateDaily {
        return Err(crate::jobs::authority::unbound());
    }
    let limits = StorePolicy::from_config(&host.config())?;
    let ctx = authority.request();
    let (principal, agent) = authority.caller();
    let now = host.now_ms();
    let sessions = super::session_store::SessionStore::open(journal.root_path(), host.clone())?;
    let expected = limits.clone();
    let check = move || {
        cancel.check()?;
        if StorePolicy::from_config(&host.config())? != expected {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(())
    };
    journal.with_operation_cleanup(principal, agent, ctx, cancel, &check, |dir, check| {
        let protected = sessions.protected_episode_turns(principal, agent, cancel)?;
        run(dir, ctx, &limits, now, cancel, check, protected)
    })
}

fn run(
    dir: &TrustedDirectory,
    ctx: &RequestContext,
    limits: &StorePolicy,
    now: i64,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
    mut pending: HashSet<JsString>,
) -> Result<usize, EngineError> {
    pending.extend(pending_targets(dir, cancel)?);
    let month = chrono::DateTime::from_timestamp_millis(now)
        .ok_or(StoreError::InvalidInput)?
        .format("%Y-%m")
        .to_string();
    let cutoff = now as f64 - limits.retention_days as f64 * DAY_MS;
    let mut archived = 0;
    for &name in FILES {
        check()?;
        let Some((proof, before)) = SourceProof::read(dir, name, cancel)? else {
            continue;
        };
        let mut rows = Vec::new();
        if !before.is_empty() && !before.ends_with(b"\n") {
            return Err(StoreError::Corrupt.into());
        }
        for line in before.split_inclusive(|byte| *byte == b'\n') {
            cancel.check()?;
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            if rows.len() == journal_io::MAX_ROWS {
                return Err(StoreError::Unavailable.into());
            }
            let row = parse_json(std::str::from_utf8(line).map_err(|_| StoreError::Corrupt)?)
                .map_err(|_| StoreError::Corrupt)?;
            validate_object(&row)?;
            rows.push(row);
        }
        // The correction path searches the latest 1,000 own receipts to
        // recognise an already applied action. Keep that lookup window intact.
        let recent_receipts: HashSet<_> = if name == "reconsolidation-events.jsonl" {
            rows.iter()
                .rev()
                .filter(|row| private(row, ctx))
                .take(1000)
                .filter_map(|row| field(row, "idempotencyKey").map(string))
                .collect()
        } else {
            HashSet::new()
        };
        let keep = select(
            &rows,
            limits.retention_soft_max_records,
            cutoff,
            cancel,
            |row| {
                private(row, ctx)
                    && field(row, "idempotencyKey")
                        .is_none_or(|key| !recent_receipts.contains(&string(key)))
            },
            &pending,
        )?;
        let removed = keep.iter().filter(|keep| !**keep).count();
        if removed == 0 {
            continue;
        }
        let mut after = Vec::new();
        // Include the live occurrence in the gzip metadata. Two independently
        // published generations may carry the same row bytes.
        let mut occurrence = Sha256::new();
        occurrence.update(proof.identity.0.to_le_bytes());
        occurrence.update(proof.identity.1.to_le_bytes());
        let modified = proof
            .modified
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| StoreError::Corrupt)?;
        occurrence.update(modified.as_secs().to_le_bytes());
        occurrence.update(modified.subsec_nanos().to_le_bytes());
        occurrence.update(&before);
        let mut gzip = GzBuilder::new()
            .comment(format!("plur1bus-retention-{:x}", occurrence.finalize()))
            .write(Vec::new(), Compression::default());
        let mut index = 0;
        for line in before.split_inclusive(|byte| *byte == b'\n') {
            cancel.check()?;
            if line.iter().all(u8::is_ascii_whitespace) {
                after.extend_from_slice(line);
                continue;
            }
            if keep[index] {
                after.extend_from_slice(line);
            } else {
                gzip.write_all(line).map_err(StoreError::from)?;
            }
            index += 1;
        }
        let suffix = gzip.finish().map_err(StoreError::from)?;
        if let Some(bucket) = journal_io::FILES.iter().position(|file| *file == name) {
            super::append_history::preserve_removed(
                dir,
                bucket,
                rows.iter()
                    .zip(&keep)
                    .filter_map(|(row, keep)| (!*keep).then_some(row)),
                cancel,
                check,
            )?;
        }
        let archive = dir.create_child("archive")?;
        archive.restrict_private()?;
        let stem = name
            .strip_suffix(".jsonl")
            .ok_or(StoreError::InvalidInput)?;
        let monthly = format!("{stem}.{month}.jsonl.gz");
        // This cooperative lease also holds the live journal. An atomic replacement
        // makes a complete gzip member visible at once. Matching suffix bytes make
        // retry safe when a prior process stopped before publishing the shorter journal.
        let published = publish_month(&archive, &monthly, &suffix, cancel, check)?;
        let verify = || {
            check()?;
            published.verify(&archive, &monthly, cancel)?;
            check()
        };
        proof.verify(dir, name, &before)?;
        append_cap_io::replace_live(dir, name, proof.identity, &before, &after, cancel, &verify)?;
        archived += removed;
    }
    Ok(archived)
}

struct PublishedMonth {
    identity: (u64, u64),
    digest: [u8; 32],
}

impl PublishedMonth {
    fn verify(
        &self,
        dir: &TrustedDirectory,
        name: &str,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        let current =
            io::read(dir, name, MAX_MONTH_BYTES, cancel)?.ok_or(StoreError::UntrustedPath)?;
        if io::identity(dir, name)? != Some(self.identity)
            || <[u8; 32]>::from(Sha256::digest(&current)) != self.digest
        {
            return Err(StoreError::UntrustedPath.into());
        }
        Ok(())
    }
}

fn publish_month(
    dir: &TrustedDirectory,
    name: &str,
    member: &[u8],
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<PublishedMonth, EngineError> {
    let identity = io::identity(dir, name)?;
    let old = io::read(dir, name, MAX_MONTH_BYTES, cancel)?;
    if identity.is_some() != old.is_some() {
        return Err(StoreError::Unavailable.into());
    }
    let before = old.as_deref().unwrap_or_default();
    if before.ends_with(member) {
        check()?;
        dir.sync_file_durable(name)?;
        if io::identity(dir, name)? != identity
            || io::read(dir, name, MAX_MONTH_BYTES, cancel)?.as_deref() != old.as_deref()
        {
            return Err(StoreError::Unavailable.into());
        }
        let identity = identity.ok_or(StoreError::UntrustedPath)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if dir
                .open_file(name)?
                .metadata()
                .map_err(StoreError::from)?
                .permissions()
                .mode()
                & 0o777
                != 0o600
            {
                return Err(StoreError::UntrustedPath.into());
            }
        }
        return Ok(PublishedMonth {
            identity,
            digest: Sha256::digest(before).into(),
        });
    }
    if before.len().saturating_add(member.len()) > MAX_MONTH_BYTES {
        return Err(StoreError::Unavailable.into());
    }
    let mut next = Vec::with_capacity(before.len() + member.len());
    next.extend_from_slice(before);
    next.extend_from_slice(member);
    let content = Sha256::digest(&next);
    let staged = format!(".native-retention-{:x}.tmp", content);
    let mut file = match dir.create_file(&staged) {
        Ok(file) => file,
        Err(StoreError::Io {
            kind: std::io::ErrorKind::AlreadyExists,
        }) => {
            // A crashed writer left this content-addressed sibling under the same lease.
            dir.remove_file(&staged)?;
            dir.create_file(&staged)?
        }
        Err(error) => return Err(error.into()),
    };
    let staged_id = crate::store::directory::regular_file_identity(&file)?;
    let result = (|| {
        for chunk in next.chunks(65_536) {
            cancel.check()?;
            file.write_all(chunk).map_err(StoreError::from)?;
        }
        file.sync_all().map_err(StoreError::from)?;
        drop(file);
        check()?;
        if io::identity(dir, name)? != identity
            || io::read(dir, name, MAX_MONTH_BYTES, cancel)?.as_deref() != old.as_deref()
        {
            return Err(StoreError::Unavailable.into());
        }
        dir.replace_staged(&staged, name, staged_id, identity)?;
        Ok(PublishedMonth {
            identity: staged_id,
            digest: content.into(),
        })
    })();
    if result.is_err() && io::identity(dir, &staged).ok().flatten() == Some(staged_id) {
        let _ = dir.remove_file(&staged);
    }
    result
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "isolated fixture assertions")]
mod tests {
    use super::*;
    use crate::{
        context::harness_user_principal,
        contract::{testing::FakeHost, AgentContext, AgentId, TurnOrigin},
    };
    use flate2::read::MultiGzDecoder;
    use serde_json::{json, Value};
    use std::{fs, io::Read};

    const NOW: i64 = 1_793_880_000_000;

    #[test]
    fn age_selection_matches_release_reference() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/jobs/neo-retention.json"))
                .unwrap();
        let cutoff = fixture["now"].as_f64().unwrap() - 90. * DAY_MS;
        for case in fixture["cases"].as_array().unwrap() {
            let rows: Vec<_> = case["rows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| parse_json(&row.to_string()).unwrap())
                .collect();
            let keep = select(
                &rows,
                case["softMax"].as_u64().unwrap() as usize,
                cutoff,
                &Cancel::never(),
                |_| true,
                &HashSet::new(),
            )
            .unwrap();
            assert_eq!(json!(keep), case["result"]["keep"], "{}", case["name"]);
        }
    }

    #[test]
    fn monthly_archive_commits_before_live_replacement_and_protects_pending_and_foreign() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let workspace = temp.path();
        let neo = workspace.join("neo");
        fs::create_dir(&neo).unwrap();
        let config =
            serde_json::from_value(json!({"neo":{"retention":{"days":90,"softMaxRecords":500}}}))
                .unwrap();
        let host = std::sync::Arc::new(FakeHost::new(workspace.join("state"), config));
        host.set_now_ms(NOW);
        let id: AgentId = "fixture".parse().unwrap();
        host.set_workspace(&id, workspace.to_owned());
        let owner = harness_user_principal("retention-owner");
        let workspace_key = format!("workspace-dir:v1:{}", workspace.display());
        let principal = serde_json::from_value(json!({
            "agentId":id,"workspace":workspace_key,"user":owner,"channel":"telegram",
            "accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"proved"
        }))
        .unwrap();
        let job = JobAuthority::from_host(
            host.as_ref(),
            JobName::ConsolidateDaily,
            &id,
            principal,
            AgentContext {
                origin: TurnOrigin::Cron,
                background: true,
                job_id: None,
                parent_run_id: None,
            },
            crate::context::RouteVocabulary::shared(),
        )
        .unwrap();
        struct Policy;
        impl crate::capture::shared_scope::CapturePolicy for Policy {
            fn allowed(&self, _: &RequestContext) -> Result<bool, EngineError> {
                Ok(true)
            }
        }
        let journal =
            CaptureJournal::open(&neo, host.clone(), std::sync::Arc::new(Policy)).unwrap();
        let dir = neo
            .join("workspaces")
            .join(super::super::merged::Layout::for_key(&workspace_key).canonical);
        fs::create_dir_all(&dir).unwrap();
        let row = |id: &str, owner: &str, created: &str| {
            json!({
                "id":id, "agentId":"fixture","ownerUserId":owner,"workspaceKey":workspace_key,
                "scope":"agent_private","status":"candidate","createdAt":created
            })
        };
        let older = row("old", &owner, "2026-01-01T00:00:00Z");
        let mut rev = older.clone();
        rev["updatedAt"] = json!("2026-02-01T00:00:00Z");
        let protected = row("queued", &owner, "2025-01-01T00:00:00Z");
        let foreign = row(
            "foreign",
            &harness_user_principal("another-owner"),
            "2026-01-01T00:00:00Z",
        );
        let new = row("recent", &owner, "2026-11-01T00:00:00Z");
        let lines = |rows: &[Value]| {
            rows.iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>()
        };
        let open_turn = row("open-turn", &owner, "2024-01-01T00:00:00Z");
        let mut expected = vec![open_turn, protected, foreign, new];
        expected.extend(
            (0..496).map(|index| row(&format!("new-{index}"), &owner, "2026-11-01T00:00:00Z")),
        );
        let before = lines(&[vec![older.clone(), rev.clone()], expected.clone()].concat());
        let live = dir.join("turn-journal.jsonl");
        fs::write(&live, &before).unwrap();
        let mut pending = row("queue-entry", &owner, "2026-01-01T00:00:00Z");
        pending["targetId"] = json!("queued");
        pending["targetType"] = json!("turn");
        pending["status"] = json!("pending");
        let mut foreign_queue = pending.clone();
        foreign_queue["ownerUserId"] = json!(harness_user_principal("another-owner"));
        foreign_queue["status"] = json!("completed");
        fs::write(
            dir.join("embedding-queue.jsonl"),
            lines(&[pending, foreign_queue]),
        )
        .unwrap();
        let episodes = dir.join("episodes.jsonl");
        fs::write(&episodes, lines(&[older.clone(), rev.clone()])).unwrap();

        let cancel = Cancel::never();
        let sessions = super::super::session_store::SessionStore::open(&neo, host.clone()).unwrap();
        let (principal, agent) = job.caller();
        sessions.transaction(principal, agent, &JsString::from("session"), &cancel, &|| Ok(()), |state| {
            let value = parse_json(r#"{"episodeSessions":{"session":{"openEpisode":{"turns":[{"id":"open-turn"}]}}}}"#).unwrap();
            state.commit(value)
        }).unwrap();
        let archive = dir.join("archive");
        fs::write(&archive, "block archive").unwrap();
        assert!(run_for_job(&journal, &job, host.clone(), &cancel).is_err());
        assert_eq!(fs::read_to_string(&live).unwrap(), before);
        fs::remove_file(&archive).unwrap();
        let count = run_for_job(&journal, &job, host.clone(), &cancel).unwrap();
        assert_eq!(count, 2);
        assert_eq!(fs::read_to_string(&live).unwrap(), lines(&expected));
        assert_eq!(
            fs::read_to_string(episodes).unwrap(),
            lines(&[older.clone(), rev.clone()])
        );
        let physical = TrustedDirectory::open(&dir).unwrap();
        let dedupe = super::super::append_history::read(&physical, &cancel).unwrap();
        assert!(dedupe[0]
            .iter()
            .any(|row| journal_io::id(row).unwrap() == JsString::from("old")));
        let month = archive.join("turn-journal.2026-11.jsonl.gz");
        let mut decoded = String::new();
        MultiGzDecoder::new(fs::File::open(&month).unwrap())
            .read_to_string(&mut decoded)
            .unwrap();
        assert_eq!(decoded, lines(&[older, rev]));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&month).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let before = fs::read(&month).unwrap();
        assert_eq!(
            run_for_job(&journal, &job, host.clone(), &cancel).unwrap(),
            0
        );
        assert_eq!(fs::read(&month).unwrap(), before);
    }
}
