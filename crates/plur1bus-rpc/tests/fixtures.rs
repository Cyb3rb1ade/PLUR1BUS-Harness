//! Every fixture in packages/rpc-schema/fixtures must deserialize into the generated Rust types
//! and serialize back to the same JSON. This is the Rust half of spec criterion 7.
use plur1bus_rpc::types::{self, ErrorCode};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::{fs, path::PathBuf};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/rpc-schema/fixtures")
}
/// Every `*.json` file in a fixture directory as (stem, parsed value), sorted by stem.
fn load_dir(dir: &str) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = fs::read_dir(fixtures().join(dir))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| {
            let stem = p.file_stem().unwrap().to_string_lossy().to_string();
            let v = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
            (stem, v)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn round_trip<T: DeserializeOwned + Serialize>(v: &Value, what: &str) {
    let typed: T = serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{what}: {e}"));
    let back = serde_json::to_value(&typed).unwrap();
    assert_eq!(&back, v, "{what}: serialize(deserialize(x)) != x");
}

fn pair<P: DeserializeOwned + Serialize, R: DeserializeOwned + Serialize>(name: &str, f: &Value) {
    round_trip::<P>(&f["params"], &format!("{name} params"));
    round_trip::<R>(&f["result"], &format!("{name} result"));
}

/// Dispatch by fixture file name; a fixture without an arm fails the test.
fn method_fixture(name: &str, f: &Value) {
    use types::*;
    match name {
        "auth.login.start" => pair::<AuthLoginStartParams, AuthLoginStartResult>(name, f),
        "auth.login.await" => pair::<AuthLoginAwaitParams, AuthLoginAwaitResult>(name, f),
        "auth.login.cancel" => pair::<AuthLoginCancelParams, AuthLoginCancelResult>(name, f),
        "auth.credentials.list" => {
            pair::<AuthCredentialsListParams, AuthCredentialsListResult>(name, f)
        }
        "auth.logout" => pair::<AuthLogoutParams, AuthLogoutResult>(name, f),
        "auth.status" => pair::<AuthStatusParams, AuthStatusResult>(name, f),
        "media.generate" => pair::<MediaGenerateParams, MediaGenerateResult>(name, f),
        "media.edit" => pair::<MediaEditParams, MediaEditResult>(name, f),
        "media.job.get" => pair::<MediaJobGetParams, MediaJobGetResult>(name, f),
        "media.job.cancel" => pair::<MediaJobCancelParams, MediaJobCancelResult>(name, f),
        "media.job.list" => pair::<MediaJobListParams, MediaJobListResult>(name, f),
        "media.output.get" => pair::<MediaOutputGetParams, MediaOutputGetResult>(name, f),
        "media.output.list" => pair::<MediaOutputListParams, MediaOutputListResult>(name, f),
        "media.output.delete" => pair::<MediaOutputDeleteParams, MediaOutputDeleteResult>(name, f),
        "media.adapters.list" => pair::<MediaAdaptersListParams, MediaAdaptersListResult>(name, f),
        "project.create" => pair::<ProjectCreateParams, ProjectCreateResult>(name, f),
        "project.get" => pair::<ProjectGetParams, ProjectGetResult>(name, f),
        "project.list" => pair::<ProjectListParams, ProjectListResult>(name, f),
        "project.update" => pair::<ProjectUpdateParams, ProjectUpdateResult>(name, f),
        "project.archive" => pair::<ProjectArchiveParams, ProjectArchiveResult>(name, f),
        "project.member.add" => pair::<ProjectMemberAddParams, ProjectMemberAddResult>(name, f),
        "project.member.remove" => {
            pair::<ProjectMemberRemoveParams, ProjectMemberRemoveResult>(name, f)
        }
        "project.member.role" => pair::<ProjectMemberRoleParams, ProjectMemberRoleResult>(name, f),
        "project.agent.add" => pair::<ProjectAgentAddParams, ProjectAgentAddResult>(name, f),
        "project.agent.remove" => {
            pair::<ProjectAgentRemoveParams, ProjectAgentRemoveResult>(name, f)
        }
        "collab.trace.get" => pair::<CollabTraceGetParams, CollabTraceGetResult>(name, f),
        "collab.trace.list" => pair::<CollabTraceListParams, CollabTraceListResult>(name, f),
        "collab.chain.cancel" => pair::<CollabChainCancelParams, CollabChainCancelResult>(name, f),
        "identity.link.request" => {
            pair::<IdentityLinkRequestParams, IdentityLinkRequestResult>(name, f)
        }
        "identity.link.list" => pair::<IdentityLinkListParams, IdentityLinkListResult>(name, f),
        "identity.link.approve" => {
            pair::<IdentityLinkApproveParams, IdentityLinkApproveResult>(name, f)
        }
        "identity.link.decline" => {
            pair::<IdentityLinkDeclineParams, IdentityLinkDeclineResult>(name, f)
        }
        "identity.link.remove" => {
            pair::<IdentityLinkRemoveParams, IdentityLinkRemoveResult>(name, f)
        }
        "identity.principals" => {
            pair::<IdentityPrincipalsParams, IdentityPrincipalsResult>(name, f)
        }
        "media.preferences.get" => {
            pair::<MediaPreferencesGetParams, MediaPreferencesGetResult>(name, f)
        }
        "media.preferences.set" => {
            pair::<MediaPreferencesSetParams, MediaPreferencesSetResult>(name, f)
        }
        "core.auth" => pair::<CoreAuthParams, CoreAuthResult>(name, f),
        "core.status" => pair::<CoreStatusParams, CoreStatusResult>(name, f),
        "core.shutdown" => pair::<CoreShutdownParams, CoreShutdownResult>(name, f),
        "core.adopt" => pair::<CoreAdoptParams, CoreAdoptResult>(name, f),
        "supervisor.auth" => pair::<SupervisorAuthParams, SupervisorAuthResult>(name, f),
        "daemon.status" => pair::<DaemonStatusParams, DaemonStatusResult>(name, f),
        "daemon.start" => pair::<DaemonStartParams, DaemonStartResult>(name, f),
        "daemon.stop" => pair::<DaemonStopParams, DaemonStopResult>(name, f),
        "config.get" => pair::<ConfigGetParams, ConfigGetResult>(name, f),
        "config.set" => pair::<ConfigSetParams, ConfigSetResult>(name, f),
        "config.watch" => pair::<ConfigWatchParams, ConfigWatchResult>(name, f),
        "module.watch" => pair::<ModuleWatchParams, ModuleWatchResult>(name, f),
        "module.list" => pair::<ModuleListParams, ModuleListResult>(name, f),
        "module.start" => pair::<ModuleStartParams, ModuleStartResult>(name, f),
        "module.stop" => pair::<ModuleStopParams, ModuleStopResult>(name, f),
        "module.restart" => pair::<ModuleRestartParams, ModuleRestartResult>(name, f),
        "module.graph" => pair::<ModuleGraphParams, ModuleGraphResult>(name, f),
        "module.install" => pair::<ModuleInstallParams, ModuleInstallResult>(name, f),
        "module.uninstall" => pair::<ModuleUninstallParams, ModuleUninstallResult>(name, f),
        "module.auth" => pair::<ModuleAuthParams, ModuleAuthResult>(name, f),
        "module.status" => pair::<ModuleStatusParams, ModuleStatusResult>(name, f),
        "module.adopt" => pair::<ModuleAdoptParams, ModuleAdoptResult>(name, f),
        "module.shutdown" => pair::<ModuleShutdownParams, ModuleShutdownResult>(name, f),
        "ext.list" => pair::<ExtListParams, ExtListResult>(name, f),
        "ext.show" => pair::<ExtShowParams, ExtShowResult>(name, f),
        "ext.inspect" => pair::<ExtInspectParams, ExtInspectResult>(name, f),
        "ext.install" => pair::<ExtInstallParams, ExtInstallResult>(name, f),
        "ext.uninstall" => pair::<ExtUninstallParams, ExtUninstallResult>(name, f),
        "ext.restore" => pair::<ExtRestoreParams, ExtRestoreResult>(name, f),
        "ext.enable" => pair::<ExtEnableParams, ExtEnableResult>(name, f),
        "ext.disable" => pair::<ExtDisableParams, ExtDisableResult>(name, f),
        "ext.watch" => pair::<ExtWatchParams, ExtWatchResult>(name, f),
        "memory.recall" => pair::<MemoryRecallParams, MemoryRecallResult>(name, f),
        "memory.capture" => pair::<MemoryCaptureParams, MemoryCaptureResult>(name, f),
        "memory.checkpoint" => pair::<MemoryCheckpointParams, MemoryCheckpointResult>(name, f),
        "memory.list" => pair::<MemoryListParams, MemoryListResult>(name, f),
        "memory.show" => pair::<MemoryShowParams, MemoryShowResult>(name, f),
        "memory.forget" => pair::<MemoryForgetParams, MemoryForgetResult>(name, f),
        "memory.correct" => pair::<MemoryCorrectParams, MemoryCorrectResult>(name, f),
        "memory.share" => pair::<MemoryShareParams, MemoryShareResult>(name, f),
        "memory.state" => pair::<MemoryStateParams, MemoryStateResult>(name, f),
        "memory.propose" => pair::<MemoryProposeParams, MemoryProposeResult>(name, f),
        "memory.proposals.list" => {
            pair::<MemoryProposalsListParams, MemoryProposalsListResult>(name, f)
        }
        "memory.proposals.accept" => {
            pair::<MemoryProposalsAcceptParams, MemoryProposalsAcceptResult>(name, f)
        }
        "memory.proposals.reject" => {
            pair::<MemoryProposalsRejectParams, MemoryProposalsRejectResult>(name, f)
        }
        "agent.list" => pair::<AgentListParams, AgentListResult>(name, f),
        "agent.open" => pair::<AgentOpenParams, AgentOpenResult>(name, f),
        "agent.close" => pair::<AgentCloseParams, AgentCloseResult>(name, f),
        "agent.status" => pair::<AgentStatusParams, AgentStatusResult>(name, f),
        "jobs.list" => pair::<JobsListParams, JobsListResult>(name, f),
        "jobs.run" | "jobs.run.system" => pair::<JobsRunParams, JobsRunResult>(name, f),
        "jobs.history" => pair::<JobsHistoryParams, JobsHistoryResult>(name, f),
        "events.subscribe" => pair::<EventsSubscribeParams, EventsSubscribeResult>(name, f),
        "events.unsubscribe" => pair::<EventsUnsubscribeParams, EventsUnsubscribeResult>(name, f),
        "admin.obsidian.detect" => {
            pair::<AdminObsidianDetectParams, AdminObsidianDetectResult>(name, f)
        }
        "admin.obsidian.prepare" => {
            pair::<AdminObsidianPrepareParams, AdminObsidianPrepareResult>(name, f)
        }
        "admin.obsidian.confirm" => {
            pair::<AdminObsidianConfirmParams, AdminObsidianConfirmResult>(name, f)
        }
        "admin.migrate" => pair::<AdminMigrateParams, AdminMigrateResult>(name, f),
        "admin.backup.snapshot" => {
            pair::<AdminBackupSnapshotParams, AdminBackupSnapshotResult>(name, f)
        }
        "audit.verify" => pair::<AuditVerifyParams, AuditVerifyResult>(name, f),
        "admin.embedding.probe" => {
            pair::<AdminEmbeddingProbeParams, AdminEmbeddingProbeResult>(name, f)
        }
        "admin.embedding.serve" => {
            pair::<AdminEmbeddingServeParams, AdminEmbeddingServeResult>(name, f)
        }
        "dreams.status" => pair::<DreamsStatusParams, DreamsStatusResult>(name, f),
        "dreams.log" => pair::<DreamsLogParams, DreamsLogResult>(name, f),
        "dreams.run" => pair::<DreamsRunParams, DreamsRunResult>(name, f),
        "dreams.schedule.get" => pair::<DreamsScheduleGetParams, DreamsScheduleGetResult>(name, f),
        "dreams.schedule.set" => pair::<DreamsScheduleSetParams, DreamsScheduleSetResult>(name, f),
        "dreams.enable" => pair::<DreamsEnableParams, DreamsEnableResult>(name, f),
        "dreams.disable" => pair::<DreamsDisableParams, DreamsDisableResult>(name, f),
        "admin.reembed.plan" => pair::<AdminReembedPlanParams, AdminReembedPlanResult>(name, f),
        "admin.reembed.run" => pair::<AdminReembedRunParams, AdminReembedRunResult>(name, f),
        "admin.reembed.status" => {
            pair::<AdminReembedStatusParams, AdminReembedStatusResult>(name, f)
        }
        "admin.reembed.abort" => pair::<AdminReembedAbortParams, AdminReembedAbortResult>(name, f),
        "models.list" => pair::<ModelsListParams, ModelsListResult>(name, f),
        "models.scan" => pair::<ModelsScanParams, ModelsScanResult>(name, f),
        "models.setOverride" => pair::<ModelsSetOverrideParams, ModelsSetOverrideResult>(name, f),
        "models.removeManual" => {
            pair::<ModelsRemoveManualParams, ModelsRemoveManualResult>(name, f)
        }
        "models.acknowledge" => pair::<ModelsAcknowledgeParams, ModelsAcknowledgeResult>(name, f),
        "session.create" => pair::<SessionCreateParams, SessionCreateResult>(name, f),
        "session.list" => pair::<SessionListParams, SessionListResult>(name, f),
        "session.get" => pair::<SessionGetParams, SessionGetResult>(name, f),
        "session.resume" => pair::<SessionResumeParams, SessionResumeResult>(name, f),
        "session.archive" => pair::<SessionArchiveParams, SessionArchiveResult>(name, f),
        "session.submit" => pair::<SessionSubmitParams, SessionSubmitResult>(name, f),
        "session.events" => pair::<SessionEventsParams, SessionEventsResult>(name, f),
        "session.cancel" => pair::<SessionCancelParams, SessionCancelResult>(name, f),
        "identity.list" => pair::<IdentityListParams, IdentityListResult>(name, f),
        "identity.human.create" => {
            pair::<IdentityHumanCreateParams, IdentityHumanCreateResult>(name, f)
        }
        "identity.link" => pair::<IdentityLinkParams, IdentityLinkResult>(name, f),
        "identity.pair.start" => pair::<IdentityPairStartParams, IdentityPairStartResult>(name, f),
        "identity.pair.claim" => pair::<IdentityPairClaimParams, IdentityPairClaimResult>(name, f),
        "identity.pair.confirm" => {
            pair::<IdentityPairConfirmParams, IdentityPairConfirmResult>(name, f)
        }
        "identity.unlink" => pair::<IdentityUnlinkParams, IdentityUnlinkResult>(name, f),
        "logs.query" => pair::<LogsQueryParams, LogsQueryResult>(name, f),
        "logs.tail" => pair::<LogsTailParams, LogsTailResult>(name, f),
        "budget.status" => pair::<BudgetStatusParams, BudgetStatusResult>(name, f),
        "egress.status" => pair::<EgressStatusParams, EgressStatusResult>(name, f),
        "budget.set" => pair::<BudgetSetParams, BudgetSetResult>(name, f),
        "secret.status" => pair::<SecretStatusParams, SecretStatus>(name, f),
        "secret.list" => pair::<SecretListParams, SecretListResult>(name, f),
        "secret.set" => pair::<SecretSetParams, SecretMeta>(name, f),
        "secret.get" => pair::<SecretGetParams, SecretGetResult>(name, f),
        "secret.delete" => pair::<SecretDeleteParams, SecretDeleteResult>(name, f),
        "grant.list" => pair::<GrantListParams, GrantListResult>(name, f),
        "grant.create" => pair::<GrantCreateParams, GrantRecord>(name, f),
        "grant.revoke" => pair::<GrantRevokeParams, GrantRecord>(name, f),
        "approval.list" => pair::<ApprovalListParams, ApprovalListResult>(name, f),
        "approval.get" => pair::<ApprovalGetParams, ApprovalRecord>(name, f),
        "approval.decide" => pair::<ApprovalDecideParams, ApprovalDecideResult>(name, f),
        "approval.cancel" => pair::<ApprovalCancelParams, ApprovalRecord>(name, f),
        "approval.verify" => pair::<ApprovalVerifyParams, ApprovalVerifyResult>(name, f),
        other => panic!("fixtures/methods/{other}.json has no Rust type mapping in this test"),
    }
}

/// Every ErrorCode variant. The exhaustive match makes a new schema code a compile error here.
fn all_error_codes() -> BTreeSet<ErrorCode> {
    let all = [
        ErrorCode::EUnauthorized,
        ErrorCode::ERpcVersion,
        ErrorCode::ENotAvailable,
        ErrorCode::ECoreUnavailable,
        ErrorCode::EInvalidParams,
        ErrorCode::EAgentUnknown,
        ErrorCode::EConfigInvalid,
        ErrorCode::EModuleUnknown,
        ErrorCode::EInternal,
        ErrorCode::ELocked,
        ErrorCode::ENotFound,
        ErrorCode::EDenied,
        ErrorCode::EApprovalRequired,
        ErrorCode::EConflict,
        ErrorCode::EStorage,
    ];
    for c in all {
        match c {
            ErrorCode::EUnauthorized
            | ErrorCode::ERpcVersion
            | ErrorCode::ENotAvailable
            | ErrorCode::ECoreUnavailable
            | ErrorCode::EInvalidParams
            | ErrorCode::EAgentUnknown
            | ErrorCode::EConfigInvalid
            | ErrorCode::EModuleUnknown
            | ErrorCode::EInternal
            | ErrorCode::ELocked
            | ErrorCode::ENotFound
            | ErrorCode::EDenied
            | ErrorCode::EApprovalRequired
            | ErrorCode::EConflict
            | ErrorCode::EStorage => {}
        }
    }
    all.into_iter().collect()
}

#[test]
fn every_method_fixture_round_trips() {
    let files = load_dir("methods");
    assert!(!files.is_empty());
    let names: BTreeSet<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
    for m in [
        "supervisor.auth",
        "daemon.status",
        "daemon.start",
        "daemon.stop",
        "core.adopt",
        "config.get",
        "config.set",
        "config.watch",
        "module.watch",
        "module.list",
        "module.start",
        "module.stop",
        "module.restart",
        "module.graph",
        "module.install",
        "module.uninstall",
        "admin.obsidian.detect",
        "admin.obsidian.prepare",
        "admin.obsidian.confirm",
        "admin.migrate",
        "admin.backup.snapshot",
        "admin.embedding.probe",
        "admin.embedding.serve",
        "admin.reembed.plan",
        "admin.reembed.run",
        "admin.reembed.status",
        "admin.reembed.abort",
        "ext.list",
        "ext.show",
        "ext.inspect",
        "ext.install",
        "ext.uninstall",
        "ext.restore",
        "ext.enable",
        "ext.disable",
        "ext.watch",
    ] {
        assert!(names.contains(m), "fixtures/methods/{m}.json is missing");
    }
    for (name, f) in &files {
        method_fixture(name, f);
    }
}

#[test]
fn every_error_fixture_round_trips_and_covers_every_error_code() {
    let mut seen = BTreeSet::new();
    for (name, v) in load_dir("errors") {
        round_trip::<types::Response>(&v, &format!("errors/{name} response"));
        round_trip::<types::ErrorObject>(&v["error"], &format!("errors/{name} error object"));
        let resp: types::Response = serde_json::from_value(v.clone()).unwrap();
        let code = resp
            .error
            .expect("error fixture carries an error")
            .data
            .expect("error data")
            .error;
        assert_eq!(
            code.to_string(),
            name,
            "errors/{name}.json carries code {code}"
        );
        seen.insert(code);
    }
    assert_eq!(
        seen,
        all_error_codes(),
        "error fixtures must cover every ErrorCode exactly"
    );
}

#[test]
fn every_notification_fixture_round_trips() {
    let files = load_dir("notifications");
    assert!(!files.is_empty());
    for (name, v) in &files {
        match name.as_str() {
            "media.job.progress" => round_trip::<types::MediaJobProgressNotification>(v, name),
            "media.job.finished" => round_trip::<types::MediaJobFinishedNotification>(v, name),
            "engine.event" => round_trip::<types::EngineEventNotification>(v, name),
            "agent.activity" => round_trip::<types::AgentActivityNotification>(v, name),
            "core.state" => round_trip::<types::CoreStateNotification>(v, name),
            "recall.completed" => round_trip::<types::RecallCompletedNotification>(v, name),
            "recall.degraded" => round_trip::<types::RecallDegradedNotification>(v, name),
            "recall.block-clipped" => round_trip::<types::RecallBlockClippedNotification>(v, name),
            "recall.block-dropped" => round_trip::<types::RecallBlockDroppedNotification>(v, name),
            "job.run" => round_trip::<types::JobRunNotification>(v, name),
            "memory.proposal" => round_trip::<types::MemoryProposalNotification>(v, name),
            "dream.completed" => round_trip::<types::DreamCompletedNotification>(v, name),
            "acl.denied" => round_trip::<types::AclDeniedNotification>(v, name),
            "embedding.identity.changed" => {
                round_trip::<types::EmbeddingIdentityChangedNotification>(v, name)
            }
            "config.changed" => round_trip::<types::ConfigChangedNotification>(v, name),
            "module.state" => round_trip::<types::ModuleStateNotification>(v, name),
            "ext.changed" => round_trip::<types::ExtChangedNotification>(v, name),
            "models.changed" => round_trip::<types::ModelsChangedNotification>(v, name),
            "session.event" => round_trip::<types::SessionEventNotification>(v, name),
            "approval.requested" => round_trip::<types::ApprovalRequestedNotification>(v, name),
            "approval.resolved" => round_trip::<types::ApprovalResolvedNotification>(v, name),
            "grant.changed" => round_trip::<types::GrantChangedNotification>(v, name),
            other => panic!("fixtures/notifications/{other}.json has no Rust type mapping"),
        }
    }
}

#[test]
fn journal_line_type_matches_schema_fixture_shape() {
    let v = serde_json::json!({ "v": 1, "id": "11111111-1111-4111-8111-111111111111", "at": 1, "agentId": "bernd", "sessionKey": "s1",
        "caller": { "channel": "cli", "accountId": "h", "userId": "u" }, "messages": [{ "role": "user", "content": "x" }] });
    round_trip::<types::JournalLine>(&v, "journal line");
}

#[test]
fn rpc_version_const_matches_the_schema() {
    let schema: Value = serde_json::from_str(
        &fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/rpc-schema/schema/rpc.schema.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        plur1bus_rpc::RPC_VERSION,
        schema["x-rpc-version"].as_str().unwrap()
    );
    assert_eq!(plur1bus_rpc::RPC_VERSION, "1.5.0");
    assert!(schema["$id"]
        .as_str()
        .unwrap()
        .contains(&format!("/{}/", plur1bus_rpc::RPC_VERSION)));
}
