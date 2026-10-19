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
        "model.embedding.select" => {
            pair::<ModelEmbeddingSelectParams, ModelEmbeddingSelectResult>(name, f)
        }
        "model.licence.confirm" => {
            pair::<ModelLicenceConfirmParams, ModelLicenceConfirmResult>(name, f)
        }
        "model.licence.list" => pair::<ModelLicenceListParams, ModelLicenceListResult>(name, f),
        "model.licence.check" => pair::<ModelLicenceCheckParams, ModelLicenceCheckResult>(name, f),
        "admin.api.device.announce" => {
            pair::<AdminApiDeviceAnnounceParams, AdminApiDeviceAnnounceResult>(name, f)
        }
        "admin.api.device.challenge" => {
            pair::<AdminApiDeviceChallengeParams, AdminApiDeviceChallengeResult>(name, f)
        }
        "admin.api.device.pair" => {
            pair::<AdminApiDevicePairParams, AdminApiDevicePairResult>(name, f)
        }
        "admin.api.device.prove" => {
            pair::<AdminApiDeviceProveParams, AdminApiDeviceProveResult>(name, f)
        }
        "chat.archive" => pair::<ChatArchiveParams, ChatArchiveResult>(name, f),
        "chat.cancel" => pair::<ChatCancelParams, ChatCancelResult>(name, f),
        "chat.create" => pair::<ChatCreateParams, ChatCreateResult>(name, f),
        "chat.delete" => pair::<ChatDeleteParams, ChatDeleteResult>(name, f),
        "chat.events" => pair::<ChatEventsParams, ChatEventsResult>(name, f),
        "chat.export" => pair::<ChatExportParams, ChatExportResult>(name, f),
        "chat.model.get" => pair::<ChatModelGetParams, ChatModelGetResult>(name, f),
        "chat.model.set" => pair::<ChatModelSetParams, ChatModelSetResult>(name, f),
        "chat.fork" => pair::<ChatForkParams, ChatForkResult>(name, f),
        "chat.get" => pair::<ChatGetParams, ChatGetResult>(name, f),
        "chat.list" => pair::<ChatListParams, ChatListResult>(name, f),
        "chat.restore" => pair::<ChatRestoreParams, ChatRestoreResult>(name, f),
        "chat.submit" => pair::<ChatSubmitParams, ChatSubmitResult>(name, f),
        "chat.update" => pair::<ChatUpdateParams, ChatUpdateResult>(name, f),
        "project.column.list" => pair::<ProjectColumnListParams, ProjectColumnListResult>(name, f),
        "project.column.create" => pair::<ProjectColumnCreateParams, BoardColumn>(name, f),
        "project.column.update" => pair::<ProjectColumnUpdateParams, BoardColumn>(name, f),
        "project.column.move" => pair::<ProjectColumnMoveParams, BoardColumn>(name, f),
        "project.column.delete" => {
            pair::<ProjectColumnDeleteParams, ProjectColumnDeleteResult>(name, f)
        }
        "inbox.list" => pair::<InboxListParams, InboxListResult>(name, f),
        "inbox.count" => pair::<InboxCountParams, InboxCountResult>(name, f),
        "inbox.markRead" => pair::<InboxMarkReadParams, InboxMarkReadResult>(name, f),
        "inbox.dismiss" => pair::<InboxDismissParams, InboxDismissResult>(name, f),
        "project.card.list" => pair::<ProjectCardListParams, ProjectCardListResult>(name, f),
        "project.card.get" => pair::<ProjectCardGetParams, BoardCard>(name, f),
        "project.card.create" => pair::<ProjectCardCreateParams, BoardCard>(name, f),
        "project.card.update" => pair::<ProjectCardUpdateParams, BoardCard>(name, f),
        "project.card.move" => pair::<ProjectCardMoveParams, BoardCard>(name, f),
        "project.card.assign" => pair::<ProjectCardAssignParams, BoardCard>(name, f),
        "project.card.unassign" => pair::<ProjectCardUnassignParams, BoardCard>(name, f),
        "project.card.archive" => pair::<ProjectCardArchiveParams, BoardCard>(name, f),
        "project.card.unarchive" => pair::<ProjectCardUnarchiveParams, BoardCard>(name, f),
        "project.card.comment.add" => pair::<ProjectCardCommentAddParams, BoardComment>(name, f),
        "project.card.comment.list" => {
            pair::<ProjectCardCommentListParams, ProjectCardCommentListResult>(name, f)
        }
        "project.card.activity.list" => {
            pair::<ProjectCardActivityListParams, ProjectCardActivityListResult>(name, f)
        }
        "device.pair" => pair::<DevicePairParams, DevicePairResult>(name, f),
        "admin.api.desktop.redeem" => {
            pair::<AdminApiDesktopRedeemParams, AdminApiDesktopRedeemResult>(name, f)
        }
        "admin.api.desktop.token" => {
            pair::<AdminApiDesktopTokenParams, AdminApiDesktopTokenResult>(name, f)
        }
        "admin.api.desktop.resolve" => {
            pair::<AdminApiDesktopResolveParams, AdminApiDesktopResolveResult>(name, f)
        }
        "device.list" => pair::<DeviceListParams, DeviceListResult>(name, f),
        "device.revoke" => pair::<DeviceRevokeParams, Device>(name, f),
        "device.rename" => pair::<DeviceRenameParams, Device>(name, f),
        "auth.login.start" => pair::<AuthLoginStartParams, AuthLoginStartResult>(name, f),
        "auth.login.await" => pair::<AuthLoginAwaitParams, AuthLoginAwaitResult>(name, f),
        "auth.login.cancel" => pair::<AuthLoginCancelParams, AuthLoginCancelResult>(name, f),
        "auth.credentials.list" => {
            pair::<AuthCredentialsListParams, AuthCredentialsListResult>(name, f)
        }
        "auth.logout" => pair::<AuthLogoutParams, AuthLogoutResult>(name, f),
        "agent.pause" => pair::<AgentPauseParams, AgentPauseResult>(name, f),
        "agent.resume" => pair::<AgentResumeParams, AgentResumeResult>(name, f),
        "agent.archive" => pair::<AgentArchiveParams, AgentArchiveResult>(name, f),
        "agent.unarchive" => pair::<AgentUnarchiveParams, AgentUnarchiveResult>(name, f),
        "agent.export" => pair::<AgentExportParams, AgentExportResult>(name, f),
        "agent.delete" => pair::<AgentDeleteParams, AgentDeleteResult>(name, f),
        "user.disable" => pair::<UserDisableParams, UserDisableResult>(name, f),
        "user.enable" => pair::<UserEnableParams, UserEnableResult>(name, f),
        "admin.api.person.resolve" => {
            pair::<AdminApiPersonResolveParams, AdminApiPersonResolveResult>(name, f)
        }
        "admin.api.invite.validate" => {
            pair::<AdminApiInviteValidateParams, AdminApiInviteValidateResult>(name, f)
        }
        "user.list" => pair::<UserListParams, UserListResult>(name, f),
        "user.role.set" => pair::<UserRoleSetParams, UserRoleSetResult>(name, f),
        "user.invite.create" => pair::<UserInviteCreateParams, UserInviteCreateResult>(name, f),
        "user.invite.list" => pair::<UserInviteListParams, UserInviteListResult>(name, f),
        "user.invite.revoke" => pair::<UserInviteRevokeParams, UserInviteRevokeResult>(name, f),
        "user.invite.redeem" => pair::<UserInviteRedeemParams, UserInviteRedeemResult>(name, f),
        "agent.rights.get" => pair::<AgentRightsGetParams, AgentRightsGetResult>(name, f),
        "agent.rights.set" => pair::<AgentRightsSetParams, AgentRightsSetResult>(name, f),
        "breakglass.request" => pair::<BreakglassRequestParams, BreakglassRequestResult>(name, f),
        "breakglass.notices" => pair::<BreakglassNoticesParams, BreakglassNoticesResult>(name, f),
        "breakglass.list" => pair::<BreakglassListParams, BreakglassListResult>(name, f),
        "breakglass.revoke" => pair::<BreakglassRevokeParams, BreakglassRevokeResult>(name, f),
        "pairing.qr" => pair::<PairingQrParams, PairingQrResult>(name, f),
        "auth.status" => pair::<AuthStatusParams, AuthStatusResult>(name, f),
        "channel.list" => pair::<ChannelListParams, ChannelListResult>(name, f),
        "channel.crypto" => pair::<ChannelCryptoParams, ChannelCryptoResult>(name, f),
        "channel.get" => pair::<ChannelGetParams, ChannelGetResult>(name, f),
        "channel.enable" => pair::<ChannelEnableParams, ChannelEnableResult>(name, f),
        "channel.disable" => pair::<ChannelDisableParams, ChannelDisableResult>(name, f),
        "channel.set" => pair::<ChannelSetParams, ChannelSetResult>(name, f),
        "channel.test" => pair::<ChannelTestParams, ChannelTestResult>(name, f),
        "channel.status" => pair::<ChannelStatusParams, ChannelStatusResult>(name, f),
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
        "task.complete" => pair::<TaskCompleteParams, TaskCompleteResult>(name, f),
        "chat.promote.preview" => {
            pair::<ChatPromotePreviewParams, ChatPromotePreviewResult>(name, f)
        }
        "chat.promote.commit" => pair::<ChatPromoteCommitParams, ChatPromoteCommitResult>(name, f),
        "chat.promote.links" => pair::<ChatPromoteLinksParams, ChatPromoteLinksResult>(name, f),
        "collab.session.replay" => {
            pair::<CollabSessionReplayParams, CollabSessionReplayResult>(name, f)
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
        "media.search" => pair::<MediaSearchParams, MediaSearchResult>(name, f),
        "media.index.status" => pair::<MediaIndexStatusParams, MediaIndexStatusResult>(name, f),
        "media.index.pause" => pair::<MediaIndexPauseParams, MediaIndexPauseResult>(name, f),
        "media.index.resume" => pair::<MediaIndexResumeParams, MediaIndexResumeResult>(name, f),
        "media.index.reindex" => pair::<MediaIndexReindexParams, MediaIndexReindexResult>(name, f),
        "media.caption.set" => pair::<MediaCaptionSetParams, MediaCaptionSetResult>(name, f),
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
        "agent.create" => pair::<AgentCreateParams, AgentCreateResult>(name, f),
        "agent.validate" => pair::<AgentValidateParams, AgentValidateResult>(name, f),
        "agent.import" => pair::<AgentImportParams, AgentImportResult>(name, f),
        "agent.list" => pair::<AgentListParams, AgentListResult>(name, f),
        "agent.open" => pair::<AgentOpenParams, AgentOpenResult>(name, f),
        "agent.close" => pair::<AgentCloseParams, AgentCloseResult>(name, f),
        "doctor.report" => pair::<DoctorReportParams, DoctorReportResult>(name, f),
        "agent.activity.list" => pair::<AgentActivityListParams, AgentActivityListResult>(name, f),
        "agent.status" => pair::<AgentStatusParams, AgentStatusResult>(name, f),
        "jobs.create" => pair::<JobsCreateParams, JobsCreateResult>(name, f),
        "jobs.update" => pair::<JobsUpdateParams, JobsUpdateResult>(name, f),
        "jobs.delete" => pair::<JobsDeleteParams, JobsDeleteResult>(name, f),
        "jobs.list" => pair::<JobsListParams, JobsListResult>(name, f),
        "jobs.run" | "jobs.run.system" | "jobs.run.user" => {
            pair::<JobsRunParams, JobsRunResult>(name, f)
        }
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
        "dreams.diary" => pair::<DreamsDiaryParams, DreamsDiaryResult>(name, f),
        "admin.reembed.plan" => pair::<AdminReembedPlanParams, AdminReembedPlanResult>(name, f),
        "admin.reembed.run" => pair::<AdminReembedRunParams, AdminReembedRunResult>(name, f),
        "admin.reembed.status" => {
            pair::<AdminReembedStatusParams, AdminReembedStatusResult>(name, f)
        }
        "admin.reembed.abort" => pair::<AdminReembedAbortParams, AdminReembedAbortResult>(name, f),
        "models.test" => pair::<ModelsTestParams, ModelsTestResult>(name, f),
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
        "session.model.set" => pair::<SessionModelSetParams, SessionModelSetResult>(name, f),
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
        "logs.levels" => pair::<LogsLevelsParams, LogsLevelsResult>(name, f),
        "logs.query" => pair::<LogsQueryParams, LogsQueryResult>(name, f),
        "logs.tail" => pair::<LogsTailParams, LogsTailResult>(name, f),
        "budget.status" => pair::<BudgetStatusParams, BudgetStatusResult>(name, f),
        "egress.status" => pair::<EgressStatusParams, EgressStatusResult>(name, f),
        "budget.set" => pair::<BudgetSetParams, BudgetSetResult>(name, f),
        "secret.status" => pair::<SecretStatusParams, SecretStatus>(name, f),
        "secret.list" => pair::<SecretListParams, SecretListResult>(name, f),
        "secret.describe" => pair::<SecretDescribeParams, SecretDescribeResult>(name, f),
        "secret.grants.list" => pair::<SecretGrantsListParams, SecretGrantsListResult>(name, f),
        "secret.set" => pair::<SecretSetParams, SecretMeta>(name, f),
        "secret.get" => pair::<SecretGetParams, SecretGetResult>(name, f),
        "secret.delete" => pair::<SecretDeleteParams, SecretDeleteResult>(name, f),
        "grant.list" => pair::<GrantListParams, GrantListResult>(name, f),
        "grant.get" => pair::<GrantGetParams, GrantRecord>(name, f),
        "grant.create" => pair::<GrantCreateParams, GrantRecord>(name, f),
        "grant.revoke" => pair::<GrantRevokeParams, GrantRecord>(name, f),
        "approval.list" => pair::<ApprovalListParams, ApprovalListResult>(name, f),
        "approval.get" => pair::<ApprovalGetParams, ApprovalRecord>(name, f),
        "approval.decide" => pair::<ApprovalDecideParams, ApprovalDecideResult>(name, f),
        "approval.cancel" => pair::<ApprovalCancelParams, ApprovalRecord>(name, f),
        "approval.verify" => pair::<ApprovalVerifyParams, ApprovalVerifyResult>(name, f),
        "approval.audit" => pair::<ApprovalAuditParams, ApprovalAuditResult>(name, f),
        "voice.status" => pair::<VoiceStatusParams, VoiceStatusResult>(name, f),
        "voice.agent.override.clear" => {
            pair::<VoiceAgentOverrideClearParams, VoiceAgentOverrideClearResult>(name, f)
        }
        "voice.agent.override.get" => {
            pair::<VoiceAgentOverrideGetParams, VoiceAgentOverrideGetResult>(name, f)
        }
        "voice.agent.override.set" => {
            pair::<VoiceAgentOverrideSetParams, VoiceAgentOverrideSetResult>(name, f)
        }
        "voice.language.get" => pair::<VoiceLanguageGetParams, VoiceLanguageGetResult>(name, f),
        "voice.language.list" => pair::<VoiceLanguageListParams, VoiceLanguageListResult>(name, f),
        "voice.language.set" => pair::<VoiceLanguageSetParams, VoiceLanguageSetResult>(name, f),
        "voice.metrics.get" => pair::<VoiceMetricsGetParams, VoiceMetricsGetResult>(name, f),
        "voice.models.install" => {
            pair::<VoiceModelsInstallParams, VoiceModelsInstallResult>(name, f)
        }
        "voice.models.list" => pair::<VoiceModelsListParams, VoiceModelsListResult>(name, f),
        "voice.realtime.profile.get" => {
            pair::<VoiceRealtimeProfileGetParams, VoiceRealtimeProfileGetResult>(name, f)
        }
        "voice.realtime.profile.set" => {
            pair::<VoiceRealtimeProfileSetParams, VoiceRealtimeProfileSetResult>(name, f)
        }
        "voice.realtime.start" => {
            pair::<VoiceRealtimeStartParams, VoiceRealtimeStartResult>(name, f)
        }
        "voice.realtime.stop" => pair::<VoiceRealtimeStopParams, VoiceRealtimeStopResult>(name, f),
        "voice.session.create" => {
            pair::<VoiceSessionCreateParams, VoiceSessionCreateResult>(name, f)
        }
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
        ErrorCode::EAgentExists,
        ErrorCode::EAgentRights,
        ErrorCode::EAgentSecretsMissing,
        ErrorCode::EConfigInvalid,
        ErrorCode::EModuleUnknown,
        ErrorCode::EInternal,
        ErrorCode::ELocked,
        ErrorCode::ENotFound,
        ErrorCode::EDenied,
        ErrorCode::EApprovalRequired,
        ErrorCode::EConflict,
        ErrorCode::EStorage,
        ErrorCode::EProjectWipLimit,
        ErrorCode::EInboxCursor,
        ErrorCode::EInviteInvalid,
        ErrorCode::EMediaCapability,
        ErrorCode::EMediaLicense,
        ErrorCode::EMediaPrivacy,
        ErrorCode::EMediaUnavailable,
        ErrorCode::EMediaDimension,
        ErrorCode::EMediaUnsupportedKind,
        ErrorCode::EVoiceBudget,
        ErrorCode::EVoiceLicense,
        ErrorCode::EVoiceUnavailable,
        ErrorCode::EVoiceLicence,
    ];
    for c in all {
        match c {
            ErrorCode::EUnauthorized
            | ErrorCode::ERpcVersion
            | ErrorCode::ENotAvailable
            | ErrorCode::ECoreUnavailable
            | ErrorCode::EInvalidParams
            | ErrorCode::EAgentUnknown
            | ErrorCode::EAgentExists
            | ErrorCode::EAgentRights
            | ErrorCode::EAgentSecretsMissing
            | ErrorCode::EConfigInvalid
            | ErrorCode::EModuleUnknown
            | ErrorCode::EInternal
            | ErrorCode::ELocked
            | ErrorCode::ENotFound
            | ErrorCode::EDenied
            | ErrorCode::EApprovalRequired
            | ErrorCode::EConflict
            | ErrorCode::EStorage
            | ErrorCode::EProjectWipLimit
            | ErrorCode::EInboxCursor
            | ErrorCode::EInviteInvalid
            | ErrorCode::EMediaCapability
            | ErrorCode::EMediaLicense
            | ErrorCode::EMediaPrivacy
            | ErrorCode::EMediaUnavailable
            | ErrorCode::EMediaDimension
            | ErrorCode::EMediaUnsupportedKind
            | ErrorCode::EVoiceBudget
            | ErrorCode::EVoiceLicense
            | ErrorCode::EVoiceUnavailable
            | ErrorCode::EVoiceLicence => {}
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
        "chat.create",
        "chat.list",
        "chat.get",
        "chat.events",
        "chat.submit",
        "chat.update",
        "chat.archive",
        "chat.restore",
        "chat.cancel",
        "chat.fork",
        "chat.delete",
        "chat.export",
        "chat.model.get",
        "chat.model.set",
        "device.pair",
        "admin.api.desktop.redeem",
        "admin.api.desktop.token",
        "admin.api.desktop.resolve",
        "admin.api.device.pair",
        "admin.api.device.challenge",
        "admin.api.device.prove",
        "admin.api.device.announce",
        "model.embedding.select",
        "model.licence.confirm",
        "model.licence.list",
        "model.licence.check",
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
            "devices.trust.next" => round_trip::<types::DevicesTrustNextNotification>(v, name),
            "inbox.changed" => round_trip::<types::InboxChangedNotification>(v, name),
            "project.card.changed" => round_trip::<types::ProjectCardChangedNotification>(v, name),
            "project.column.changed" => {
                round_trip::<types::ProjectColumnChangedNotification>(v, name)
            }
            "breakglass.notice" => round_trip::<types::BreakglassNoticeNotification>(v, name),
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
            "approval.parked" => round_trip::<types::ApprovalParkedNotification>(v, name),
            "api.account.changed" => round_trip::<types::ApiAccountChangedNotification>(v, name),
            "grant.changed" => round_trip::<types::GrantChangedNotification>(v, name),
            "voice.download.progress" => {
                round_trip::<types::VoiceDownloadProgressNotification>(v, name)
            }
            "voice.realtime.state" => round_trip::<types::VoiceRealtimeStateNotification>(v, name),
            "voice.realtime.transcript" => {
                round_trip::<types::VoiceRealtimeTranscriptNotification>(v, name)
            }
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
    assert_eq!(plur1bus_rpc::RPC_VERSION, "1.6.0");
    assert!(schema["$id"]
        .as_str()
        .unwrap()
        .contains(&format!("/{}/", plur1bus_rpc::RPC_VERSION)));
}

#[test]
fn core_auth_preserves_owner_tokens_and_supports_scoped_client_tokens() {
    for token in [
        "0".repeat(64),
        format!("plb_123456789abc_{}", "x".repeat(43)),
    ] {
        let value = serde_json::json!({ "token": token });
        round_trip::<types::CoreAuthParams>(&value, "core.auth token variants");
    }
}
