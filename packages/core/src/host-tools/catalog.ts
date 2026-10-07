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
    const msg = e instanceof Error ? e.message : "unexpected failure";
    const code = msg === "aborted" || (e instanceof Error && (e as { code?: string }).code === "aborted") ? "aborted" : "invalid_input";
    return new HostFailure(code, msg).toResult();
  }
}
