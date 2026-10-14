import { appsListTool, appsOpenTool, appsRunningTool } from "./apps.ts";
import { clipboardReadTool, clipboardWriteTool } from "./clipboard.ts";
import { HostFailure } from "./errors.ts";
import { notifyTool } from "./notify.ts";
import { pkgDetectTool, pkgInfoTool, pkgInstallTool, pkgListTool, pkgRemoveTool, pkgSearchTool } from "./pkg.ts";
import { procInfoTool, procKillTool, procListTool, procWaitTool } from "./proc.ts";
import { sysBatteryTool, sysDisksTool, sysInfoTool, sysNetworkTool } from "./sys.ts";
import type { HostContext, HostOutcome, HostTool } from "./types.ts";

export const HOST_TOOLS: readonly HostTool[] = Object.freeze([
  procListTool, procInfoTool, procKillTool, procWaitTool,
  sysInfoTool, sysDisksTool, sysNetworkTool, sysBatteryTool,
  pkgDetectTool, pkgSearchTool, pkgListTool, pkgInfoTool, pkgInstallTool, pkgRemoveTool,
  appsListTool, appsOpenTool, appsRunningTool,
  clipboardReadTool, clipboardWriteTool,
  notifyTool,
]);

const BY_NAME = new Map(HOST_TOOLS.map((t) => [t.name, t]));

export function getHostTool(name: string): HostTool | undefined {
  return BY_NAME.get(name);
}

export async function runHostTool<T = unknown>(name: string, input: unknown, ctx: HostContext): Promise<HostOutcome<T>> {
  try {
    if (ctx.signal?.aborted) throw new HostFailure("aborted", "the call was aborted");
    const tool = BY_NAME.get(name);
    if (!tool) throw new HostFailure("invalid_input", `unknown tool ${name}`);
    const value = await tool.run(input, ctx) as T;
    return { isError: false, value };
  } catch (e) {
    if (e instanceof HostFailure) return e.toResult();
    return unexpected(e).toResult();
  }
}

/** Only errors raised by this library with a known code keep their text; anything else may carry paths or secrets. */
function unexpected(e: unknown): HostFailure {
  const c = (e as { code?: unknown } | null)?.code;
  if (c === "aborted") return new HostFailure("aborted", "the call was aborted");
  if (c === "invalid_input" && e instanceof Error) return new HostFailure("invalid_input", e.message);
  if (c === "ENOENT" || c === "ENOTDIR") return new HostFailure("not_found", "the target was not found");
  if (c === "EACCES" || c === "EPERM") return new HostFailure("permission_denied", "permission denied");
  return new HostFailure("invalid_input", "the operation failed");
}
