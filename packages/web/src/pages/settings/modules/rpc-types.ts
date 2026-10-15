// Settings > Modules & Updates: RPC method signatures, merged into RpcMethods. Types come from the generated rpc-schema only.
import type {
  ModuleGraph, ModuleGraphParams,
  ModuleInstallParams, ModuleInstallResult,
  ModuleListParams, ModuleListResult,
  ModuleRestartParams, ModuleRestartResult,
  ModuleStartParams, ModuleStartResult,
  ModuleStopParams, ModuleStopResult,
  ModuleUninstallParams, ModuleUninstallResult,
  ModuleWatchParams, ModuleWatchResult,
} from "../../../../../rpc-schema/generated/types.ts";

export type {
  ModuleGraph, ModuleInstallResult, ModuleListResult, ModuleRestartResult, ModuleStartResult, ModuleStopResult, ModuleUninstallResult, ModuleWatchResult,
};

declare module "../../../api/index.ts" {
  interface RpcMethods {
    "module.list": { params: ModuleListParams; result: ModuleListResult };
    "module.graph": { params: ModuleGraphParams; result: ModuleGraph };
    "module.watch": { params: ModuleWatchParams; result: ModuleWatchResult };
    "module.start": { params: ModuleStartParams; result: ModuleStartResult };
    "module.stop": { params: ModuleStopParams; result: ModuleStopResult };
    "module.restart": { params: ModuleRestartParams; result: ModuleRestartResult };
    "module.install": { params: ModuleInstallParams; result: ModuleInstallResult };
    "module.uninstall": { params: ModuleUninstallParams; result: ModuleUninstallResult };
  }
}
