use plur1bus_rpc::types;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::{fs, path::PathBuf};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/rpc-schema/fixtures/methods")
}

fn schema() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/rpc-schema/schema/rpc.schema.json");
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn round_trip<T: DeserializeOwned + Serialize>(value: &Value, what: &str) {
    let typed: T = serde_json::from_value(value.clone()).unwrap_or_else(|e| panic!("{what}: {e}"));
    assert_eq!(
        serde_json::to_value(typed).unwrap(),
        *value,
        "{what}: serde roundtrip changed the fixture"
    );
}

fn assert_missing_required<T: DeserializeOwned>(value: &Value, schema: &Value, what: &str) {
    let Some(required) = schema["required"].as_array() else {
        return;
    };
    for field in required {
        let field = field.as_str().unwrap();
        let mut missing = value.clone();
        assert!(
            missing
                .as_object_mut()
                .expect("required-field fixtures are objects")
                .remove(field)
                .is_some(),
            "{what}: fixture is missing required field {field}"
        );
        assert!(
            serde_json::from_value::<T>(missing).is_err(),
            "{what}: accepted input without required field {field}"
        );
    }
}

fn check_pair<P, R>(name: &str, fixture: &Value, root_schema: &Value)
where
    P: DeserializeOwned + Serialize,
    R: DeserializeOwned + Serialize,
{
    let method = name
        .strip_suffix(".system")
        .or_else(|| name.strip_suffix(".user"))
        .unwrap_or(name);
    let method_schema = &root_schema["$defs"]["methods"][method];
    let params_schema = &method_schema["params"];
    let result_schema = &method_schema["result"];
    let params = &fixture["params"];
    let result = &fixture["result"];

    round_trip::<P>(params, &format!("{name} params"));
    assert_missing_required::<P>(params, params_schema, &format!("{name} params"));
    let mut params_with_unknown = params.clone();
    params_with_unknown
        .as_object_mut()
        .expect("RPC params are objects")
        .insert("unknownRoundtripField".into(), Value::Bool(true));
    assert!(
        serde_json::from_value::<P>(params_with_unknown).is_err(),
        "{name} params: accepted an unknown field"
    );

    round_trip::<R>(result, &format!("{name} result"));
    assert_missing_required::<R>(result, result_schema, &format!("{name} result"));
    let mut result_with_unknown = result.clone();
    result_with_unknown
        .as_object_mut()
        .expect("RPC results are objects")
        .insert("unknownRoundtripField".into(), Value::Bool(true));
    serde_json::from_value::<R>(result_with_unknown)
        .unwrap_or_else(|e| panic!("{name} result: rejected an unknown field: {e}"));
}

#[test]
fn every_method_fixture_round_trips_and_checks_serde_contracts() {
    let root_schema = schema();
    let mut fixtures: Vec<_> = fs::read_dir(fixtures())
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            let fixture = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
            (name, fixture)
        })
        .collect();
    fixtures.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        fixtures.len(),
        root_schema["$defs"]["methods"].as_object().unwrap().len() + 2,
        "update type dispatch for new RPC methods"
    );

    for (name, fixture) in &fixtures {
        match name.as_str() {
            "chat.create" => check_pair::<types::ChatCreateParams, types::ChatCreateResult>(
                name,
                fixture,
                &root_schema,
            ),
            "chat.list" => check_pair::<types::ChatListParams, types::ChatListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "chat.get" => check_pair::<types::ChatGetParams, types::ChatGetResult>(
                name,
                fixture,
                &root_schema,
            ),
            "chat.events" => check_pair::<types::ChatEventsParams, types::ChatEventsResult>(
                name,
                fixture,
                &root_schema,
            ),
            "chat.submit" => check_pair::<types::ChatSubmitParams, types::ChatSubmitResult>(
                name,
                fixture,
                &root_schema,
            ),
            "chat.update" => check_pair::<types::ChatUpdateParams, types::ChatUpdateResult>(
                name,
                fixture,
                &root_schema,
            ),
            "chat.archive" => check_pair::<types::ChatArchiveParams, types::ChatArchiveResult>(
                name,
                fixture,
                &root_schema,
            ),
            "chat.restore" => check_pair::<types::ChatRestoreParams, types::ChatRestoreResult>(
                name,
                fixture,
                &root_schema,
            ),
            "chat.cancel" => check_pair::<types::ChatCancelParams, types::ChatCancelResult>(
                name,
                fixture,
                &root_schema,
            ),
            "chat.fork" => check_pair::<types::ChatForkParams, types::ChatForkResult>(
                name,
                fixture,
                &root_schema,
            ),
            "chat.delete" => check_pair::<types::ChatDeleteParams, types::ChatDeleteResult>(
                name,
                fixture,
                &root_schema,
            ),
            "chat.export" => check_pair::<types::ChatExportParams, types::ChatExportResult>(
                name,
                fixture,
                &root_schema,
            ),
            "admin.api.device.pair" => check_pair::<
                types::AdminApiDevicePairParams,
                types::AdminApiDevicePairResult,
            >(name, fixture, &root_schema),
            "admin.api.device.challenge" => check_pair::<
                types::AdminApiDeviceChallengeParams,
                types::AdminApiDeviceChallengeResult,
            >(name, fixture, &root_schema),
            "admin.api.device.prove" => check_pair::<
                types::AdminApiDeviceProveParams,
                types::AdminApiDeviceProveResult,
            >(name, fixture, &root_schema),
            "admin.api.device.announce" => check_pair::<
                types::AdminApiDeviceAnnounceParams,
                types::AdminApiDeviceAnnounceResult,
            >(name, fixture, &root_schema),
            "model.embedding.select" => check_pair::<
                types::ModelEmbeddingSelectParams,
                types::ModelEmbeddingSelectResult,
            >(name, fixture, &root_schema),
            "model.licence.confirm" => check_pair::<
                types::ModelLicenceConfirmParams,
                types::ModelLicenceConfirmResult,
            >(name, fixture, &root_schema),
            "model.licence.list" => check_pair::<
                types::ModelLicenceListParams,
                types::ModelLicenceListResult,
            >(name, fixture, &root_schema),
            "model.licence.check" => check_pair::<
                types::ModelLicenceCheckParams,
                types::ModelLicenceCheckResult,
            >(name, fixture, &root_schema),
            "device.list" => check_pair::<types::DeviceListParams, types::DeviceListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "device.revoke" => {
                check_pair::<types::DeviceRevokeParams, types::Device>(name, fixture, &root_schema)
            }
            "device.rename" => {
                check_pair::<types::DeviceRenameParams, types::Device>(name, fixture, &root_schema)
            }
            "agent.pause" => check_pair::<types::AgentPauseParams, types::AgentPauseResult>(
                name,
                fixture,
                &root_schema,
            ),
            "agent.resume" => check_pair::<types::AgentResumeParams, types::AgentResumeResult>(
                name,
                fixture,
                &root_schema,
            ),
            "agent.archive" => check_pair::<types::AgentArchiveParams, types::AgentArchiveResult>(
                name,
                fixture,
                &root_schema,
            ),
            "agent.unarchive" => check_pair::<
                types::AgentUnarchiveParams,
                types::AgentUnarchiveResult,
            >(name, fixture, &root_schema),
            "agent.create" => check_pair::<types::AgentCreateParams, types::AgentCreateResult>(
                name,
                fixture,
                &root_schema,
            ),
            "agent.validate" => {
                check_pair::<types::AgentValidateParams, types::AgentValidateResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "agent.import" => check_pair::<types::AgentImportParams, types::AgentImportResult>(
                name,
                fixture,
                &root_schema,
            ),
            "agent.export" => check_pair::<types::AgentExportParams, types::AgentExportResult>(
                name,
                fixture,
                &root_schema,
            ),
            "agent.delete" => check_pair::<types::AgentDeleteParams, types::AgentDeleteResult>(
                name,
                fixture,
                &root_schema,
            ),
            "agent.rights.get" => check_pair::<
                types::AgentRightsGetParams,
                types::AgentRightsGetResult,
            >(name, fixture, &root_schema),
            "agent.rights.set" => check_pair::<
                types::AgentRightsSetParams,
                types::AgentRightsSetResult,
            >(name, fixture, &root_schema),
            "user.disable" => check_pair::<types::UserDisableParams, types::UserDisableResult>(
                name,
                fixture,
                &root_schema,
            ),
            "user.enable" => check_pair::<types::UserEnableParams, types::UserEnableResult>(
                name,
                fixture,
                &root_schema,
            ),
            "admin.api.person.resolve" => check_pair::<
                types::AdminApiPersonResolveParams,
                types::AdminApiPersonResolveResult,
            >(name, fixture, &root_schema),
            "admin.api.invite.validate" => check_pair::<
                types::AdminApiInviteValidateParams,
                types::AdminApiInviteValidateResult,
            >(name, fixture, &root_schema),
            "user.list" => check_pair::<types::UserListParams, types::UserListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "user.role.set" => check_pair::<types::UserRoleSetParams, types::UserRoleSetResult>(
                name,
                fixture,
                &root_schema,
            ),
            "user.invite.create" => check_pair::<
                types::UserInviteCreateParams,
                types::UserInviteCreateResult,
            >(name, fixture, &root_schema),
            "user.invite.list" => check_pair::<
                types::UserInviteListParams,
                types::UserInviteListResult,
            >(name, fixture, &root_schema),
            "user.invite.revoke" => check_pair::<
                types::UserInviteRevokeParams,
                types::UserInviteRevokeResult,
            >(name, fixture, &root_schema),
            "user.invite.redeem" => check_pair::<
                types::UserInviteRedeemParams,
                types::UserInviteRedeemResult,
            >(name, fixture, &root_schema),
            "breakglass.request" => check_pair::<
                types::BreakglassRequestParams,
                types::BreakglassRequestResult,
            >(name, fixture, &root_schema),
            "breakglass.list" => check_pair::<
                types::BreakglassListParams,
                types::BreakglassListResult,
            >(name, fixture, &root_schema),
            "breakglass.revoke" => check_pair::<
                types::BreakglassRevokeParams,
                types::BreakglassRevokeResult,
            >(name, fixture, &root_schema),
            "breakglass.notices" => check_pair::<
                types::BreakglassNoticesParams,
                types::BreakglassNoticesResult,
            >(name, fixture, &root_schema),
            "pairing.qr" => check_pair::<types::PairingQrParams, types::PairingQrResult>(
                name,
                fixture,
                &root_schema,
            ),

            "auth.login.start" => check_pair::<
                types::AuthLoginStartParams,
                types::AuthLoginStartResult,
            >(name, fixture, &root_schema),
            "auth.login.await" => check_pair::<
                types::AuthLoginAwaitParams,
                types::AuthLoginAwaitResult,
            >(name, fixture, &root_schema),
            "auth.login.cancel" => check_pair::<
                types::AuthLoginCancelParams,
                types::AuthLoginCancelResult,
            >(name, fixture, &root_schema),
            "auth.credentials.list" => check_pair::<
                types::AuthCredentialsListParams,
                types::AuthCredentialsListResult,
            >(name, fixture, &root_schema),
            "auth.logout" => check_pair::<types::AuthLogoutParams, types::AuthLogoutResult>(
                name,
                fixture,
                &root_schema,
            ),
            "auth.status" => check_pair::<types::AuthStatusParams, types::AuthStatusResult>(
                name,
                fixture,
                &root_schema,
            ),
            "channel.list" => check_pair::<types::ChannelListParams, types::ChannelListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "channel.crypto" => {
                check_pair::<types::ChannelCryptoParams, types::ChannelCryptoResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "channel.get" => check_pair::<types::ChannelGetParams, types::ChannelGetResult>(
                name,
                fixture,
                &root_schema,
            ),
            "channel.enable" => {
                check_pair::<types::ChannelEnableParams, types::ChannelEnableResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "channel.disable" => check_pair::<
                types::ChannelDisableParams,
                types::ChannelDisableResult,
            >(name, fixture, &root_schema),
            "channel.set" => check_pair::<types::ChannelSetParams, types::ChannelSetResult>(
                name,
                fixture,
                &root_schema,
            ),
            "channel.test" => check_pair::<types::ChannelTestParams, types::ChannelTestResult>(
                name,
                fixture,
                &root_schema,
            ),
            "channel.status" => {
                check_pair::<types::ChannelStatusParams, types::ChannelStatusResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "media.generate" => {
                check_pair::<types::MediaGenerateParams, types::MediaGenerateResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "media.edit" => check_pair::<types::MediaEditParams, types::MediaEditResult>(
                name,
                fixture,
                &root_schema,
            ),
            "media.job.get" => check_pair::<types::MediaJobGetParams, types::MediaJobGetResult>(
                name,
                fixture,
                &root_schema,
            ),
            "media.job.cancel" => check_pair::<
                types::MediaJobCancelParams,
                types::MediaJobCancelResult,
            >(name, fixture, &root_schema),
            "media.job.list" => check_pair::<types::MediaJobListParams, types::MediaJobListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "media.output.get" => check_pair::<
                types::MediaOutputGetParams,
                types::MediaOutputGetResult,
            >(name, fixture, &root_schema),
            "media.output.list" => check_pair::<
                types::MediaOutputListParams,
                types::MediaOutputListResult,
            >(name, fixture, &root_schema),
            "media.output.delete" => check_pair::<
                types::MediaOutputDeleteParams,
                types::MediaOutputDeleteResult,
            >(name, fixture, &root_schema),
            "media.adapters.list" => check_pair::<
                types::MediaAdaptersListParams,
                types::MediaAdaptersListResult,
            >(name, fixture, &root_schema),
            "project.create" => {
                check_pair::<types::ProjectCreateParams, types::ProjectCreateResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "project.get" => check_pair::<types::ProjectGetParams, types::ProjectGetResult>(
                name,
                fixture,
                &root_schema,
            ),
            "project.list" => check_pair::<types::ProjectListParams, types::ProjectListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "project.update" => {
                check_pair::<types::ProjectUpdateParams, types::ProjectUpdateResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "project.archive" => check_pair::<
                types::ProjectArchiveParams,
                types::ProjectArchiveResult,
            >(name, fixture, &root_schema),
            "project.member.add" => check_pair::<
                types::ProjectMemberAddParams,
                types::ProjectMemberAddResult,
            >(name, fixture, &root_schema),
            "project.member.remove" => check_pair::<
                types::ProjectMemberRemoveParams,
                types::ProjectMemberRemoveResult,
            >(name, fixture, &root_schema),
            "project.member.role" => check_pair::<
                types::ProjectMemberRoleParams,
                types::ProjectMemberRoleResult,
            >(name, fixture, &root_schema),
            "project.agent.add" => check_pair::<
                types::ProjectAgentAddParams,
                types::ProjectAgentAddResult,
            >(name, fixture, &root_schema),
            "project.agent.remove" => check_pair::<
                types::ProjectAgentRemoveParams,
                types::ProjectAgentRemoveResult,
            >(name, fixture, &root_schema),
            "task.complete" => check_pair::<types::TaskCompleteParams, types::TaskCompleteResult>(
                name,
                fixture,
                &root_schema,
            ),
            "chat.promote.preview" => check_pair::<
                types::ChatPromotePreviewParams,
                types::ChatPromotePreviewResult,
            >(name, fixture, &root_schema),
            "chat.promote.commit" => check_pair::<
                types::ChatPromoteCommitParams,
                types::ChatPromoteCommitResult,
            >(name, fixture, &root_schema),
            "chat.promote.links" => check_pair::<
                types::ChatPromoteLinksParams,
                types::ChatPromoteLinksResult,
            >(name, fixture, &root_schema),
            "collab.session.replay" => check_pair::<
                types::CollabSessionReplayParams,
                types::CollabSessionReplayResult,
            >(name, fixture, &root_schema),
            "collab.trace.get" => check_pair::<
                types::CollabTraceGetParams,
                types::CollabTraceGetResult,
            >(name, fixture, &root_schema),
            "collab.trace.list" => check_pair::<
                types::CollabTraceListParams,
                types::CollabTraceListResult,
            >(name, fixture, &root_schema),
            "collab.chain.cancel" => check_pair::<
                types::CollabChainCancelParams,
                types::CollabChainCancelResult,
            >(name, fixture, &root_schema),
            "identity.link.request" => check_pair::<
                types::IdentityLinkRequestParams,
                types::IdentityLinkRequestResult,
            >(name, fixture, &root_schema),
            "identity.link.list" => check_pair::<
                types::IdentityLinkListParams,
                types::IdentityLinkListResult,
            >(name, fixture, &root_schema),
            "identity.link.approve" => check_pair::<
                types::IdentityLinkApproveParams,
                types::IdentityLinkApproveResult,
            >(name, fixture, &root_schema),
            "identity.link.decline" => check_pair::<
                types::IdentityLinkDeclineParams,
                types::IdentityLinkDeclineResult,
            >(name, fixture, &root_schema),
            "identity.link.remove" => check_pair::<
                types::IdentityLinkRemoveParams,
                types::IdentityLinkRemoveResult,
            >(name, fixture, &root_schema),
            "identity.principals" => check_pair::<
                types::IdentityPrincipalsParams,
                types::IdentityPrincipalsResult,
            >(name, fixture, &root_schema),
            "media.search" => check_pair::<types::MediaSearchParams, types::MediaSearchResult>(
                name,
                fixture,
                &root_schema,
            ),
            "media.index.status" => check_pair::<
                types::MediaIndexStatusParams,
                types::MediaIndexStatusResult,
            >(name, fixture, &root_schema),
            "media.index.pause" => check_pair::<
                types::MediaIndexPauseParams,
                types::MediaIndexPauseResult,
            >(name, fixture, &root_schema),
            "media.index.resume" => check_pair::<
                types::MediaIndexResumeParams,
                types::MediaIndexResumeResult,
            >(name, fixture, &root_schema),
            "media.index.reindex" => check_pair::<
                types::MediaIndexReindexParams,
                types::MediaIndexReindexResult,
            >(name, fixture, &root_schema),
            "media.caption.set" => check_pair::<
                types::MediaCaptionSetParams,
                types::MediaCaptionSetResult,
            >(name, fixture, &root_schema),
            "media.preferences.get" => check_pair::<
                types::MediaPreferencesGetParams,
                types::MediaPreferencesGetResult,
            >(name, fixture, &root_schema),
            "media.preferences.set" => check_pair::<
                types::MediaPreferencesSetParams,
                types::MediaPreferencesSetResult,
            >(name, fixture, &root_schema),
            "core.auth" => check_pair::<types::CoreAuthParams, types::CoreAuthResult>(
                name,
                fixture,
                &root_schema,
            ),
            "core.status" => check_pair::<types::CoreStatusParams, types::CoreStatusResult>(
                name,
                fixture,
                &root_schema,
            ),
            "core.shutdown" => check_pair::<types::CoreShutdownParams, types::CoreShutdownResult>(
                name,
                fixture,
                &root_schema,
            ),
            "core.adopt" => check_pair::<types::CoreAdoptParams, types::CoreAdoptResult>(
                name,
                fixture,
                &root_schema,
            ),
            "supervisor.auth" => check_pair::<
                types::SupervisorAuthParams,
                types::SupervisorAuthResult,
            >(name, fixture, &root_schema),
            "daemon.status" => check_pair::<types::DaemonStatusParams, types::DaemonStatusResult>(
                name,
                fixture,
                &root_schema,
            ),
            "daemon.start" => check_pair::<types::DaemonStartParams, types::DaemonStartResult>(
                name,
                fixture,
                &root_schema,
            ),
            "daemon.stop" => check_pair::<types::DaemonStopParams, types::DaemonStopResult>(
                name,
                fixture,
                &root_schema,
            ),
            "config.get" => check_pair::<types::ConfigGetParams, types::ConfigGetResult>(
                name,
                fixture,
                &root_schema,
            ),
            "config.set" => check_pair::<types::ConfigSetParams, types::ConfigSetResult>(
                name,
                fixture,
                &root_schema,
            ),
            "config.watch" => check_pair::<types::ConfigWatchParams, types::ConfigWatchResult>(
                name,
                fixture,
                &root_schema,
            ),
            "module.watch" => check_pair::<types::ModuleWatchParams, types::ModuleWatchResult>(
                name,
                fixture,
                &root_schema,
            ),
            "module.list" => check_pair::<types::ModuleListParams, types::ModuleListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "module.start" => check_pair::<types::ModuleStartParams, types::ModuleStartResult>(
                name,
                fixture,
                &root_schema,
            ),
            "module.stop" => check_pair::<types::ModuleStopParams, types::ModuleStopResult>(
                name,
                fixture,
                &root_schema,
            ),
            "module.restart" => {
                check_pair::<types::ModuleRestartParams, types::ModuleRestartResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "module.graph" => check_pair::<types::ModuleGraphParams, types::ModuleGraphResult>(
                name,
                fixture,
                &root_schema,
            ),
            "module.install" => {
                check_pair::<types::ModuleInstallParams, types::ModuleInstallResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "module.uninstall" => check_pair::<
                types::ModuleUninstallParams,
                types::ModuleUninstallResult,
            >(name, fixture, &root_schema),
            "module.auth" => check_pair::<types::ModuleAuthParams, types::ModuleAuthResult>(
                name,
                fixture,
                &root_schema,
            ),
            "module.status" => check_pair::<types::ModuleStatusParams, types::ModuleStatusResult>(
                name,
                fixture,
                &root_schema,
            ),
            "module.adopt" => check_pair::<types::ModuleAdoptParams, types::ModuleAdoptResult>(
                name,
                fixture,
                &root_schema,
            ),
            "module.shutdown" => check_pair::<
                types::ModuleShutdownParams,
                types::ModuleShutdownResult,
            >(name, fixture, &root_schema),
            "ext.list" => check_pair::<types::ExtListParams, types::ExtListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "ext.show" => check_pair::<types::ExtShowParams, types::ExtShowResult>(
                name,
                fixture,
                &root_schema,
            ),
            "ext.inspect" => check_pair::<types::ExtInspectParams, types::ExtInspectResult>(
                name,
                fixture,
                &root_schema,
            ),
            "ext.install" => check_pair::<types::ExtInstallParams, types::ExtInstallResult>(
                name,
                fixture,
                &root_schema,
            ),
            "ext.uninstall" => check_pair::<types::ExtUninstallParams, types::ExtUninstallResult>(
                name,
                fixture,
                &root_schema,
            ),
            "ext.restore" => check_pair::<types::ExtRestoreParams, types::ExtRestoreResult>(
                name,
                fixture,
                &root_schema,
            ),
            "ext.enable" => check_pair::<types::ExtEnableParams, types::ExtEnableResult>(
                name,
                fixture,
                &root_schema,
            ),
            "ext.disable" => check_pair::<types::ExtDisableParams, types::ExtDisableResult>(
                name,
                fixture,
                &root_schema,
            ),
            "ext.watch" => check_pair::<types::ExtWatchParams, types::ExtWatchResult>(
                name,
                fixture,
                &root_schema,
            ),
            "memory.recall" => check_pair::<types::MemoryRecallParams, types::MemoryRecallResult>(
                name,
                fixture,
                &root_schema,
            ),
            "memory.capture" => {
                check_pair::<types::MemoryCaptureParams, types::MemoryCaptureResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "memory.checkpoint" => check_pair::<
                types::MemoryCheckpointParams,
                types::MemoryCheckpointResult,
            >(name, fixture, &root_schema),
            "memory.list" => check_pair::<types::MemoryListParams, types::MemoryListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "memory.show" => check_pair::<types::MemoryShowParams, types::MemoryShowResult>(
                name,
                fixture,
                &root_schema,
            ),
            "memory.forget" => check_pair::<types::MemoryForgetParams, types::MemoryForgetResult>(
                name,
                fixture,
                &root_schema,
            ),
            "memory.correct" => {
                check_pair::<types::MemoryCorrectParams, types::MemoryCorrectResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "memory.share" => check_pair::<types::MemoryShareParams, types::MemoryShareResult>(
                name,
                fixture,
                &root_schema,
            ),
            "memory.state" => check_pair::<types::MemoryStateParams, types::MemoryStateResult>(
                name,
                fixture,
                &root_schema,
            ),
            "memory.propose" => {
                check_pair::<types::MemoryProposeParams, types::MemoryProposeResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "memory.proposals.list" => check_pair::<
                types::MemoryProposalsListParams,
                types::MemoryProposalsListResult,
            >(name, fixture, &root_schema),
            "memory.proposals.accept" => check_pair::<
                types::MemoryProposalsAcceptParams,
                types::MemoryProposalsAcceptResult,
            >(name, fixture, &root_schema),
            "memory.proposals.reject" => check_pair::<
                types::MemoryProposalsRejectParams,
                types::MemoryProposalsRejectResult,
            >(name, fixture, &root_schema),
            "agent.list" => check_pair::<types::AgentListParams, types::AgentListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "agent.open" => check_pair::<types::AgentOpenParams, types::AgentOpenResult>(
                name,
                fixture,
                &root_schema,
            ),
            "agent.close" => check_pair::<types::AgentCloseParams, types::AgentCloseResult>(
                name,
                fixture,
                &root_schema,
            ),
            "doctor.report" => check_pair::<types::DoctorReportParams, types::DoctorReportResult>(
                name,
                fixture,
                &root_schema,
            ),
            "agent.activity.list" => check_pair::<
                types::AgentActivityListParams,
                types::AgentActivityListResult,
            >(name, fixture, &root_schema),
            "agent.status" => check_pair::<types::AgentStatusParams, types::AgentStatusResult>(
                name,
                fixture,
                &root_schema,
            ),
            "jobs.create" => check_pair::<types::JobsCreateParams, types::JobsCreateResult>(
                name,
                fixture,
                &root_schema,
            ),
            "jobs.update" => check_pair::<types::JobsUpdateParams, types::JobsUpdateResult>(
                name,
                fixture,
                &root_schema,
            ),
            "jobs.delete" => check_pair::<types::JobsDeleteParams, types::JobsDeleteResult>(
                name,
                fixture,
                &root_schema,
            ),
            "jobs.list" => check_pair::<types::JobsListParams, types::JobsListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "jobs.run" | "jobs.run.system" | "jobs.run.user" => check_pair::<
                types::JobsRunParams,
                types::JobsRunResult,
            >(
                name, fixture, &root_schema
            ),
            "jobs.history" => check_pair::<types::JobsHistoryParams, types::JobsHistoryResult>(
                name,
                fixture,
                &root_schema,
            ),
            "events.subscribe" => check_pair::<
                types::EventsSubscribeParams,
                types::EventsSubscribeResult,
            >(name, fixture, &root_schema),
            "events.unsubscribe" => check_pair::<
                types::EventsUnsubscribeParams,
                types::EventsUnsubscribeResult,
            >(name, fixture, &root_schema),
            "admin.obsidian.detect" => check_pair::<
                types::AdminObsidianDetectParams,
                types::AdminObsidianDetectResult,
            >(name, fixture, &root_schema),
            "admin.obsidian.prepare" => check_pair::<
                types::AdminObsidianPrepareParams,
                types::AdminObsidianPrepareResult,
            >(name, fixture, &root_schema),
            "admin.obsidian.confirm" => check_pair::<
                types::AdminObsidianConfirmParams,
                types::AdminObsidianConfirmResult,
            >(name, fixture, &root_schema),
            "admin.migrate" => check_pair::<types::AdminMigrateParams, types::AdminMigrateResult>(
                name,
                fixture,
                &root_schema,
            ),
            "admin.backup.snapshot" => check_pair::<
                types::AdminBackupSnapshotParams,
                types::AdminBackupSnapshotResult,
            >(name, fixture, &root_schema),
            "audit.verify" => check_pair::<types::AuditVerifyParams, types::AuditVerifyResult>(
                name,
                fixture,
                &root_schema,
            ),
            "admin.embedding.probe" => check_pair::<
                types::AdminEmbeddingProbeParams,
                types::AdminEmbeddingProbeResult,
            >(name, fixture, &root_schema),
            "admin.embedding.serve" => check_pair::<
                types::AdminEmbeddingServeParams,
                types::AdminEmbeddingServeResult,
            >(name, fixture, &root_schema),
            "dreams.status" => check_pair::<types::DreamsStatusParams, types::DreamsStatusResult>(
                name,
                fixture,
                &root_schema,
            ),
            "dreams.log" => check_pair::<types::DreamsLogParams, types::DreamsLogResult>(
                name,
                fixture,
                &root_schema,
            ),
            "dreams.run" => check_pair::<types::DreamsRunParams, types::DreamsRunResult>(
                name,
                fixture,
                &root_schema,
            ),
            "dreams.schedule.get" => check_pair::<
                types::DreamsScheduleGetParams,
                types::DreamsScheduleGetResult,
            >(name, fixture, &root_schema),
            "dreams.schedule.set" => check_pair::<
                types::DreamsScheduleSetParams,
                types::DreamsScheduleSetResult,
            >(name, fixture, &root_schema),
            "dreams.enable" => check_pair::<types::DreamsEnableParams, types::DreamsEnableResult>(
                name,
                fixture,
                &root_schema,
            ),
            "dreams.disable" => {
                check_pair::<types::DreamsDisableParams, types::DreamsDisableResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "dreams.diary" => check_pair::<types::DreamsDiaryParams, types::DreamsDiaryResult>(
                name,
                fixture,
                &root_schema,
            ),
            "admin.reembed.plan" => check_pair::<
                types::AdminReembedPlanParams,
                types::AdminReembedPlanResult,
            >(name, fixture, &root_schema),
            "admin.reembed.run" => check_pair::<
                types::AdminReembedRunParams,
                types::AdminReembedRunResult,
            >(name, fixture, &root_schema),
            "admin.reembed.status" => check_pair::<
                types::AdminReembedStatusParams,
                types::AdminReembedStatusResult,
            >(name, fixture, &root_schema),
            "admin.reembed.abort" => check_pair::<
                types::AdminReembedAbortParams,
                types::AdminReembedAbortResult,
            >(name, fixture, &root_schema),
            "models.list" => check_pair::<types::ModelsListParams, types::ModelsListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "models.scan" => check_pair::<types::ModelsScanParams, types::ModelsScanResult>(
                name,
                fixture,
                &root_schema,
            ),
            "models.setOverride" => check_pair::<
                types::ModelsSetOverrideParams,
                types::ModelsSetOverrideResult,
            >(name, fixture, &root_schema),
            "models.removeManual" => check_pair::<
                types::ModelsRemoveManualParams,
                types::ModelsRemoveManualResult,
            >(name, fixture, &root_schema),
            "models.acknowledge" => check_pair::<
                types::ModelsAcknowledgeParams,
                types::ModelsAcknowledgeResult,
            >(name, fixture, &root_schema),
            "session.create" => {
                check_pair::<types::SessionCreateParams, types::SessionCreateResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "session.list" => check_pair::<types::SessionListParams, types::SessionListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "session.get" => check_pair::<types::SessionGetParams, types::SessionGetResult>(
                name,
                fixture,
                &root_schema,
            ),
            "session.resume" => {
                check_pair::<types::SessionResumeParams, types::SessionResumeResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "session.archive" => check_pair::<
                types::SessionArchiveParams,
                types::SessionArchiveResult,
            >(name, fixture, &root_schema),
            "session.submit" => {
                check_pair::<types::SessionSubmitParams, types::SessionSubmitResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "session.events" => {
                check_pair::<types::SessionEventsParams, types::SessionEventsResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "session.model.set" => check_pair::<
                types::SessionModelSetParams,
                types::SessionModelSetResult,
            >(name, fixture, &root_schema),
            "session.cancel" => {
                check_pair::<types::SessionCancelParams, types::SessionCancelResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "identity.list" => check_pair::<types::IdentityListParams, types::IdentityListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "identity.human.create" => check_pair::<
                types::IdentityHumanCreateParams,
                types::IdentityHumanCreateResult,
            >(name, fixture, &root_schema),
            "identity.link" => check_pair::<types::IdentityLinkParams, types::IdentityLinkResult>(
                name,
                fixture,
                &root_schema,
            ),
            "identity.pair.start" => check_pair::<
                types::IdentityPairStartParams,
                types::IdentityPairStartResult,
            >(name, fixture, &root_schema),
            "identity.pair.claim" => check_pair::<
                types::IdentityPairClaimParams,
                types::IdentityPairClaimResult,
            >(name, fixture, &root_schema),
            "identity.pair.confirm" => check_pair::<
                types::IdentityPairConfirmParams,
                types::IdentityPairConfirmResult,
            >(name, fixture, &root_schema),
            "identity.unlink" => check_pair::<
                types::IdentityUnlinkParams,
                types::IdentityUnlinkResult,
            >(name, fixture, &root_schema),
            "logs.levels" => check_pair::<types::LogsLevelsParams, types::LogsLevelsResult>(
                name,
                fixture,
                &root_schema,
            ),
            "logs.query" => check_pair::<types::LogsQueryParams, types::LogsQueryResult>(
                name,
                fixture,
                &root_schema,
            ),
            "logs.tail" => check_pair::<types::LogsTailParams, types::LogsTailResult>(
                name,
                fixture,
                &root_schema,
            ),
            "budget.status" => check_pair::<types::BudgetStatusParams, types::BudgetStatusResult>(
                name,
                fixture,
                &root_schema,
            ),
            "egress.status" => check_pair::<types::EgressStatusParams, types::EgressStatusResult>(
                name,
                fixture,
                &root_schema,
            ),
            "budget.set" => check_pair::<types::BudgetSetParams, types::BudgetSetResult>(
                name,
                fixture,
                &root_schema,
            ),
            "secret.status" => check_pair::<types::SecretStatusParams, types::SecretStatus>(
                name,
                fixture,
                &root_schema,
            ),
            "secret.list" => check_pair::<types::SecretListParams, types::SecretListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "secret.set" => {
                check_pair::<types::SecretSetParams, types::SecretMeta>(name, fixture, &root_schema)
            }
            "secret.get" => check_pair::<types::SecretGetParams, types::SecretGetResult>(
                name,
                fixture,
                &root_schema,
            ),
            "secret.delete" => check_pair::<types::SecretDeleteParams, types::SecretDeleteResult>(
                name,
                fixture,
                &root_schema,
            ),
            "grant.list" => check_pair::<types::GrantListParams, types::GrantListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "grant.get" => {
                check_pair::<types::GrantGetParams, types::GrantRecord>(name, fixture, &root_schema)
            }
            "grant.create" => check_pair::<types::GrantCreateParams, types::GrantRecord>(
                name,
                fixture,
                &root_schema,
            ),
            "grant.revoke" => check_pair::<types::GrantRevokeParams, types::GrantRecord>(
                name,
                fixture,
                &root_schema,
            ),
            "approval.list" => check_pair::<types::ApprovalListParams, types::ApprovalListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "approval.get" => check_pair::<types::ApprovalGetParams, types::ApprovalRecord>(
                name,
                fixture,
                &root_schema,
            ),
            "approval.decide" => check_pair::<
                types::ApprovalDecideParams,
                types::ApprovalDecideResult,
            >(name, fixture, &root_schema),
            "approval.cancel" => check_pair::<types::ApprovalCancelParams, types::ApprovalRecord>(
                name,
                fixture,
                &root_schema,
            ),
            "approval.verify" => check_pair::<
                types::ApprovalVerifyParams,
                types::ApprovalVerifyResult,
            >(name, fixture, &root_schema),
            "approval.audit" => {
                check_pair::<types::ApprovalAuditParams, types::ApprovalAuditResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "project.column.list" => check_pair::<
                types::ProjectColumnListParams,
                types::ProjectColumnListResult,
            >(name, fixture, &root_schema),
            "project.column.create" => check_pair::<
                types::ProjectColumnCreateParams,
                types::BoardColumn,
            >(name, fixture, &root_schema),
            "project.column.update" => check_pair::<
                types::ProjectColumnUpdateParams,
                types::BoardColumn,
            >(name, fixture, &root_schema),
            "project.column.move" => {
                check_pair::<types::ProjectColumnMoveParams, types::BoardColumn>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "project.column.delete" => check_pair::<
                types::ProjectColumnDeleteParams,
                types::ProjectColumnDeleteResult,
            >(name, fixture, &root_schema),
            "inbox.list" => check_pair::<types::InboxListParams, types::InboxListResult>(
                name,
                fixture,
                &root_schema,
            ),
            "inbox.count" => check_pair::<types::InboxCountParams, types::InboxCountResult>(
                name,
                fixture,
                &root_schema,
            ),
            "inbox.markRead" => {
                check_pair::<types::InboxMarkReadParams, types::InboxMarkReadResult>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "inbox.dismiss" => check_pair::<types::InboxDismissParams, types::InboxDismissResult>(
                name,
                fixture,
                &root_schema,
            ),
            "project.card.list" => check_pair::<
                types::ProjectCardListParams,
                types::ProjectCardListResult,
            >(name, fixture, &root_schema),
            "project.card.get" => check_pair::<types::ProjectCardGetParams, types::BoardCard>(
                name,
                fixture,
                &root_schema,
            ),
            "project.card.create" => {
                check_pair::<types::ProjectCardCreateParams, types::BoardCard>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "project.card.update" => {
                check_pair::<types::ProjectCardUpdateParams, types::BoardCard>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "project.card.move" => check_pair::<types::ProjectCardMoveParams, types::BoardCard>(
                name,
                fixture,
                &root_schema,
            ),
            "project.card.assign" => {
                check_pair::<types::ProjectCardAssignParams, types::BoardCard>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "project.card.unassign" => check_pair::<
                types::ProjectCardUnassignParams,
                types::BoardCard,
            >(name, fixture, &root_schema),
            "project.card.archive" => {
                check_pair::<types::ProjectCardArchiveParams, types::BoardCard>(
                    name,
                    fixture,
                    &root_schema,
                )
            }
            "project.card.unarchive" => check_pair::<
                types::ProjectCardUnarchiveParams,
                types::BoardCard,
            >(name, fixture, &root_schema),
            "project.card.comment.add" => check_pair::<
                types::ProjectCardCommentAddParams,
                types::BoardComment,
            >(name, fixture, &root_schema),
            "project.card.comment.list" => check_pair::<
                types::ProjectCardCommentListParams,
                types::ProjectCardCommentListResult,
            >(name, fixture, &root_schema),
            "project.card.activity.list" => check_pair::<
                types::ProjectCardActivityListParams,
                types::ProjectCardActivityListResult,
            >(name, fixture, &root_schema),
            "voice.status" => check_pair::<types::VoiceStatusParams, types::VoiceStatusResult>(
                name,
                fixture,
                &root_schema,
            ),
            "voice.agent.override.clear" => check_pair::<
                types::VoiceAgentOverrideClearParams,
                types::VoiceAgentOverrideClearResult,
            >(name, fixture, &root_schema),
            "voice.agent.override.get" => check_pair::<
                types::VoiceAgentOverrideGetParams,
                types::VoiceAgentOverrideGetResult,
            >(name, fixture, &root_schema),
            "voice.agent.override.set" => check_pair::<
                types::VoiceAgentOverrideSetParams,
                types::VoiceAgentOverrideSetResult,
            >(name, fixture, &root_schema),
            "voice.language.get" => check_pair::<
                types::VoiceLanguageGetParams,
                types::VoiceLanguageGetResult,
            >(name, fixture, &root_schema),
            "voice.language.list" => check_pair::<
                types::VoiceLanguageListParams,
                types::VoiceLanguageListResult,
            >(name, fixture, &root_schema),
            "voice.language.set" => check_pair::<
                types::VoiceLanguageSetParams,
                types::VoiceLanguageSetResult,
            >(name, fixture, &root_schema),
            "voice.metrics.get" => check_pair::<
                types::VoiceMetricsGetParams,
                types::VoiceMetricsGetResult,
            >(name, fixture, &root_schema),
            "voice.models.install" => check_pair::<
                types::VoiceModelsInstallParams,
                types::VoiceModelsInstallResult,
            >(name, fixture, &root_schema),
            "voice.models.list" => check_pair::<
                types::VoiceModelsListParams,
                types::VoiceModelsListResult,
            >(name, fixture, &root_schema),
            "voice.realtime.profile.get" => check_pair::<
                types::VoiceRealtimeProfileGetParams,
                types::VoiceRealtimeProfileGetResult,
            >(name, fixture, &root_schema),
            "voice.realtime.profile.set" => check_pair::<
                types::VoiceRealtimeProfileSetParams,
                types::VoiceRealtimeProfileSetResult,
            >(name, fixture, &root_schema),
            "voice.realtime.start" => check_pair::<
                types::VoiceRealtimeStartParams,
                types::VoiceRealtimeStartResult,
            >(name, fixture, &root_schema),
            "voice.realtime.stop" => check_pair::<
                types::VoiceRealtimeStopParams,
                types::VoiceRealtimeStopResult,
            >(name, fixture, &root_schema),
            "voice.session.create" => check_pair::<
                types::VoiceSessionCreateParams,
                types::VoiceSessionCreateResult,
            >(name, fixture, &root_schema),
            other => panic!("method fixture {other} has no Rust type mapping"),
        }
    }
}

#[test]
fn discovery_new_flag_roundtrips_and_remains_optional() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/rpc-schema/fixtures/methods/models.list.json"
    ))
    .unwrap();
    let mut model = fixture["result"]["models"][0].clone();
    for flag in [true, false] {
        model["new"] = serde_json::json!(flag);
        let typed: types::ModelEntry = serde_json::from_value(model.clone()).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap()["new"], flag);
    }
    model.as_object_mut().unwrap().remove("new");
    let typed: types::ModelEntry = serde_json::from_value(model).unwrap();
    assert!(serde_json::to_value(typed).unwrap().get("new").is_none());
}
