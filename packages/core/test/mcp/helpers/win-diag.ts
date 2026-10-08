import { spawn } from "node:child_process";
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/sdk/client/stdio.js";
import { windowsJobCommand } from "../../../src/mcp/windows-job.ts";
import { McpConnection } from "../../../src/mcp/connection.ts";
import { createRedactor } from "../../../src/mcp/redact.ts";
import { systemClock } from "../../../src/mcp/clock.ts";
import { FIXTURE_STDIO, NODE, stdioDef, capturingLogger } from "./util.ts";
const t0 = Date.now(); const ts = () => `[${Date.now() - t0}ms]`;
const restricted: Record<string, string> = {};
for (const k of DEFAULT_INHERITED_ENV_VARS) if (process.env[k] !== undefined) restricted[k] = process.env[k]!;
console.log("restricted env keys", Object.keys(restricted).join(","));
for (const [label, env] of [["restricted", restricted], ["restricted+WEDGE", { ...restricted, FIXTURE_WEDGE: "1" }]] as Array<[string, Record<string, string>]>) {
  const args = ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", FIXTURE_STDIO];
  const l = windowsJobCommand(NODE, args, process.env);
  console.log(ts(), label, "spawn");
  const c = spawn(l.command, l.args, { env, windowsHide: true, stdio: "pipe" });
  c.stdout.on("data", (b) => console.log(ts(), label, "stdout", JSON.stringify(String(b).slice(0, 120))));
  c.stderr.on("data", (b) => console.log(ts(), label, "stderr", JSON.stringify(String(b).slice(0, 1500))));
  c.on("exit", (code, sig) => console.log(ts(), label, "exit", code, sig));
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d", version: "1" } } }) + "\n");
  await new Promise((r) => setTimeout(r, 12000));
  c.stdin.end(); await new Promise((r) => setTimeout(r, 3000));
  if (c.exitCode === null) { console.log(ts(), label, "still alive"); spawn("taskkill.exe", ["/PID", String(c.pid), "/T", "/F"]); await new Promise((r) => setTimeout(r, 2000)); }
}
for (const wedge of [false, true]) {
  const logger = capturingLogger();
  const s = Date.now();
  try {
    const conn = await McpConnection.open({ def: stdioDef({}, wedge ? { FIXTURE_WEDGE: "1" } : {}), clock: systemClock, logger, redactor: createRedactor(), hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {} });
    console.log(ts(), "conn wedge=", wedge, "opened in", Date.now() - s); await conn.close("graceful"); console.log(ts(), "closed in", Date.now() - s);
  } catch (e) { console.log(ts(), "conn wedge=", wedge, "FAILED after", Date.now() - s, String(e)); }
  console.log(JSON.stringify(logger.lines).slice(0, 3000));
}
