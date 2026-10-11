import type {
  BreakglassRequestParams,
  BreakglassRequestResult,
  BreakglassListParams,
  BreakglassListResult,
  BreakglassRevokeParams,
  BreakglassRevokeResult,
  BreakglassNoticesParams,
  BreakglassNoticesResult,
  BreakglassNoticeNotification,
} from "../../../../rpc-schema/generated/types.ts";

export type {
  BreakglassRequestParams,
  BreakglassRequestResult,
  BreakglassListParams,
  BreakglassListResult,
  BreakglassRevokeParams,
  BreakglassRevokeResult,
  BreakglassNoticesParams,
  BreakglassNoticesResult,
  BreakglassNoticeNotification,
};

declare module "../../api/index.ts" {
  interface RpcMethods {
    "breakglass.notices": { params: BreakglassNoticesParams; result: BreakglassNoticesResult };
  }
}
