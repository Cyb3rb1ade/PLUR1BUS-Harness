import { fileURLToPath } from "node:url";
import { validateDefinition } from "../../../src/mcp/config.ts";
import type { McpCaller, McpLogger, McpServerDefinition } from "../../../src/mcp/types.ts";

export const FIXTURE_STDIO = fileURLToPath(new URL("./fixture-stdio.ts", import.meta.url));
export const NODE = process.execPath;
export const policy = { allowedCommands: [NODE] };
export const caller: McpCaller = { agentId: "bernd", principal: "user:v1:test" };

export const stdioDef = (over: Record<string, unknown> = {}, env: Record<string, string> = {}): McpServerDefinition =>
  validateDefinition({
    name: "fixture",
    transport: { type: "stdio", command: NODE, args: ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", FIXTURE_STDIO], env },
    timeouts: { connectMs: 20_000, listMs: 10_000, callMs: 10_000, closeGraceMs: 300 },
    ...over,
  }, policy);

export const httpDef = (url: string, over: Record<string, unknown> = {}, headers: Record<string, string> = {}): McpServerDefinition =>
  validateDefinition({ name: "remote", transport: { type: "http", url, headers }, timeouts: { connectMs: 10_000, listMs: 10_000, callMs: 10_000, closeGraceMs: 300 }, ...over }, policy);

export interface LogLine { level: string; msg: string; fields: Record<string, unknown> | undefined }
export function capturingLogger(): McpLogger & { lines: LogLine[]; text(): string } {
  const lines: LogLine[] = [];
  const mk = (level: string) => (msg: string, fields?: Record<string, unknown>) => { lines.push({ level, msg, fields }); };
  return { debug: mk("debug"), info: mk("info"), warn: mk("warn"), error: mk("error"), lines, text: () => JSON.stringify(lines) };
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
export async function waitDead(pid: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!pidAlive(pid)) return true; await new Promise((r) => setTimeout(r, 20)); }
  return !pidAlive(pid);
}
