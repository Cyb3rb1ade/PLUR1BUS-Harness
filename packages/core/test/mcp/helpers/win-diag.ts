import { spawn } from "node:child_process";
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/sdk/client/stdio.js";
import { windowsJobCommand, windowsLauncherEnv } from "../../../src/mcp/windows-job.ts";
import { McpConnection } from "../../../src/mcp/connection.ts";
import { createRedactor } from "../../../src/mcp/redact.ts";
import { systemClock } from "../../../src/mcp/clock.ts";
import { FIXTURE_STDIO, NODE, stdioDef, capturingLogger } from "./util.ts";
const t0 = Date.now(); const ts = () => `[${Date.now() - t0}ms]`;
const restricted: Record<string, string> = {};
for (const k of DEFAULT_INHERITED_ENV_VARS) if (process.env[k] !== undefined) restricted[k] = process.env[k]!;
console.log("REAL PSModulePath", process.env.PSModulePath);
const computed = windowsLauncherEnv({}, restricted);
console.log("COMPUTED", computed.PSModulePath);
const variants: Array<[string, Record<string, string>]> = [
  ["real", { ...restricted, PSModulePath: process.env.PSModulePath! }],
  ["computed", computed],
  ["sys32only", { ...restricted, PSModulePath: `${restricted.SYSTEMROOT}\\system32\\WindowsPowerShell\\v1.0\\Modules` }],
  ["empty", { ...restricted, PSModulePath: "" }],
  ["restricted", restricted],
];
await Promise.all(variants.map(async ([label, env]) => {
  const args = ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", FIXTURE_STDIO];
  const l = windowsJobCommand(NODE, args, process.env);
  const s = Date.now();
  const c = spawn(l.command, l.args, { env, windowsHide: true, stdio: "pipe" });
  let got = ""; let err = "";
  c.stdout.on("data", (b) => { if (!got) console.log(ts(), label, "FIRST STDOUT after", Date.now() - s); got += b; });
  c.stderr.on("data", (b) => { err += b; });
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d", version: "1" } } }) + "\n");
  await new Promise((r) => setTimeout(r, 20000));
  console.log(ts(), label, got ? "OK" : "NO ANSWER", "stderr:", JSON.stringify(err.slice(0, 300)));
  c.stdin.end(); await new Promise((r) => setTimeout(r, 2000));
  if (c.exitCode === null) spawn("taskkill.exe", ["/PID", String(c.pid), "/T", "/F"]);
}));
const logger = capturingLogger(); const s = Date.now();
try {
  const conn = await McpConnection.open({ def: stdioDef(), clock: systemClock, logger, redactor: createRedactor(), hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {} });
  console.log(ts(), "conn opened in", Date.now() - s); await conn.close("graceful");
} catch (e) { console.log(ts(), "conn FAILED after", Date.now() - s, String(e)); }
console.log(JSON.stringify(logger.lines).slice(0, 2000));
