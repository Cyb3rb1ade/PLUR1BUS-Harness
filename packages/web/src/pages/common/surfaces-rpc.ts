// RPC method signatures for Extensions, Approvals, Grants, and Jobs, merged into RpcMethods.
// Types are imported strictly from packages/rpc-schema/generated/types.ts without handwritten definitions.
import type {
  ExtListParams, ExtListResult,
  ExtShowParams, ExtShowResult,
  ExtInspectParams, ExtInspectResult,
  ExtInstallParams, ExtInstallResult,
  ExtUninstallParams, ExtUninstallResult,
  ExtRestoreParams, ExtRestoreResult,
  ExtEnableParams, ExtEnableResult,
  ExtDisableParams, ExtDisableResult,
  ExtWatchParams, ExtWatchResult,
  ApprovalListParams, ApprovalListResult,
  ApprovalGetParams, ApprovalGetResult,
  ApprovalDecideParams, ApprovalDecideResult,
  ApprovalCancelParams, ApprovalCancelResult,
  ApprovalVerifyParams, ApprovalVerifyResult,
  GrantListParams, GrantListResult,
  GrantCreateParams, GrantCreateResult,
  GrantRevokeParams, GrantRevokeResult,
  JobsListParams, JobsListResult,
  JobsRunParams, JobsRunResult,
  JobsHistoryParams, JobsHistoryResult,
  ExtItem, ExtDetail, ExtInspection,
  ApprovalRecord, GrantRecord,
  JobRun, SystemJobRun,
  ExtKind, ExtOverlay, ExtTrustTier,
  ApprovalRisk, GrantScopeName,
} from "../../../../rpc-schema/generated/types.ts";

export type {
  ExtListParams, ExtListResult,
  ExtShowParams, ExtShowResult,
  ExtInspectParams, ExtInspectResult,
  ExtInstallParams, ExtInstallResult,
  ExtUninstallParams, ExtUninstallResult,
  ExtRestoreParams, ExtRestoreResult,
  ExtEnableParams, ExtEnableResult,
  ExtDisableParams, ExtDisableResult,
  ExtWatchParams, ExtWatchResult,
  ApprovalListParams, ApprovalListResult,
  ApprovalGetParams, ApprovalGetResult,
  ApprovalDecideParams, ApprovalDecideResult,
  ApprovalCancelParams, ApprovalCancelResult,
  ApprovalVerifyParams, ApprovalVerifyResult,
  GrantListParams, GrantListResult,
  GrantCreateParams, GrantCreateResult,
  GrantRevokeParams, GrantRevokeResult,
  JobsListParams, JobsListResult,
  JobsRunParams, JobsRunResult,
  JobsHistoryParams, JobsHistoryResult,
  ExtItem, ExtDetail, ExtInspection,
  ApprovalRecord, GrantRecord,
  JobRun, SystemJobRun,
  ExtKind, ExtOverlay, ExtTrustTier,
  ApprovalRisk, GrantScopeName,
};

declare module "../../api/index.ts" {
  interface RpcMethods {
    "ext.list": { params: ExtListParams; result: ExtListResult };
    "ext.show": { params: ExtShowParams; result: ExtShowResult };
    "ext.inspect": { params: ExtInspectParams; result: ExtInspectResult };
    "ext.install": { params: ExtInstallParams; result: ExtInstallResult };
    "ext.uninstall": { params: ExtUninstallParams; result: ExtUninstallResult };
    "ext.restore": { params: ExtRestoreParams; result: ExtRestoreResult };
    "ext.enable": { params: ExtEnableParams; result: ExtEnableResult };
    "ext.disable": { params: ExtDisableParams; result: ExtDisableResult };
    "ext.watch": { params: ExtWatchParams; result: ExtWatchResult };

    "approval.list": { params: ApprovalListParams; result: ApprovalListResult };
    "approval.get": { params: ApprovalGetParams; result: ApprovalGetResult };
    "approval.decide": { params: ApprovalDecideParams; result: ApprovalDecideResult };
    "approval.cancel": { params: ApprovalCancelParams; result: ApprovalCancelResult };
    "approval.verify": { params: ApprovalVerifyParams; result: ApprovalVerifyResult };

    "grant.list": { params: GrantListParams; result: GrantListResult };
    "grant.create": { params: GrantCreateParams; result: GrantCreateResult };
    "grant.revoke": { params: GrantRevokeParams; result: GrantRevokeResult };

    "jobs.list": { params: JobsListParams; result: JobsListResult };
    "jobs.run": { params: JobsRunParams; result: JobsRunResult };
    "jobs.history": { params: JobsHistoryParams; result: JobsHistoryResult };
  }
}
