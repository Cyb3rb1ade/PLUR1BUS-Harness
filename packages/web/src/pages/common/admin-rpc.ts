// RPC method signatures for Admin pages (F39–F42, F44), merged into RpcMethods.
// Types are imported strictly from packages/rpc-schema/generated/types.ts without handwritten definitions.
import type {
  AgentPauseParams, AgentPauseResult,
  AgentResumeParams, AgentResumeResult,
  AgentArchiveParams, AgentArchiveResult,
  AgentUnarchiveParams, AgentUnarchiveResult,
  AgentExportParams, AgentExportResult,
  AgentDeleteParams, AgentDeleteResult,
  AgentRightsGetParams, AgentRightsGetResult,
  AgentRightsSetParams, AgentRightsSetResult,
  UserListParams, UserListResult,
  UserRoleSetParams, UserRoleSetResult,
  UserInviteCreateParams, UserInviteCreateResult,
  UserInviteListParams, UserInviteListResult,
  UserInviteRevokeParams, UserInviteRevokeResult,
  BreakglassRequestParams, BreakglassRequestResult,
  BreakglassListParams, BreakglassListResult,
  BreakglassRevokeParams, BreakglassRevokeResult,
  PairingQrParams, PairingQrResult,
  Device, DeviceListParams, DeviceListResult, DeviceRevokeParams, DeviceRevokeResult, DeviceRenameParams, DeviceRenameResult,
  SessionListParams, SessionListResult,
} from "../../../../rpc-schema/generated/types.ts";

export type {
  AgentPauseParams, AgentPauseResult,
  AgentResumeParams, AgentResumeResult,
  AgentArchiveParams, AgentArchiveResult,
  AgentUnarchiveParams, AgentUnarchiveResult,
  AgentExportParams, AgentExportResult,
  AgentDeleteParams, AgentDeleteResult,
  AgentRightsGetParams, AgentRightsGetResult,
  AgentRightsSetParams, AgentRightsSetResult,
  UserListParams, UserListResult,
  UserRoleSetParams, UserRoleSetResult,
  UserInviteCreateParams, UserInviteCreateResult,
  UserInviteListParams, UserInviteListResult,
  UserInviteRevokeParams, UserInviteRevokeResult,
  BreakglassRequestParams, BreakglassRequestResult,
  BreakglassListParams, BreakglassListResult,
  BreakglassRevokeParams, BreakglassRevokeResult,
  PairingQrParams, PairingQrResult,
  Device, DeviceListParams, DeviceListResult, DeviceRevokeParams, DeviceRevokeResult, DeviceRenameParams, DeviceRenameResult,
  SessionListParams, SessionListResult,
};

declare module "../../api/index.ts" {
  interface RpcMethods {
    "agent.pause": { params: AgentPauseParams; result: AgentPauseResult };
    "agent.resume": { params: AgentResumeParams; result: AgentResumeResult };
    "agent.archive": { params: AgentArchiveParams; result: AgentArchiveResult };
    "agent.unarchive": { params: AgentUnarchiveParams; result: AgentUnarchiveResult };
    "agent.export": { params: AgentExportParams; result: AgentExportResult };
    "agent.delete": { params: AgentDeleteParams; result: AgentDeleteResult };
    "agent.rights.get": { params: AgentRightsGetParams; result: AgentRightsGetResult };
    "agent.rights.set": { params: AgentRightsSetParams; result: AgentRightsSetResult };
    "user.list": { params: UserListParams; result: UserListResult };
    "user.role.set": { params: UserRoleSetParams; result: UserRoleSetResult };
    "user.invite.create": { params: UserInviteCreateParams; result: UserInviteCreateResult };
    "user.invite.list": { params: UserInviteListParams; result: UserInviteListResult };
    "user.invite.revoke": { params: UserInviteRevokeParams; result: UserInviteRevokeResult };
    "breakglass.request": { params: BreakglassRequestParams; result: BreakglassRequestResult };
    "breakglass.list": { params: BreakglassListParams; result: BreakglassListResult };
    "breakglass.revoke": { params: BreakglassRevokeParams; result: BreakglassRevokeResult };
    "device.list": { params: DeviceListParams; result: DeviceListResult };
    "device.revoke": { params: DeviceRevokeParams; result: DeviceRevokeResult };
    "device.rename": { params: DeviceRenameParams; result: DeviceRenameResult };
    "pairing.qr": { params: PairingQrParams; result: PairingQrResult };
  }
}
