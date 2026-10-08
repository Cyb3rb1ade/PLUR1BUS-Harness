import { spawn } from "node:child_process";
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/sdk/client/stdio.js";
import { windowsJobCommand } from "../../../src/mcp/windows-job.ts";
import { FIXTURE_STDIO, NODE } from "./util.ts";
const t0 = Date.now(); const ts = () => `[${Date.now() - t0}ms]`;
const restricted: Record<string, string> = {};
for (const k of DEFAULT_INHERITED_ENV_VARS) if (process.env[k] !== undefined) restricted[k] = process.env[k]!;
const real = process.env.PSModulePath!;
const parts = real.split(";");
const noPs = { ...process.env } as Record<string, string>; delete noPs.PSModulePath;
const variants: Array<[string, Record<string, string>]> = [
  ["restricted", restricted],
  ["real", { ...restricted, PSModulePath: real }],
  ["empty", { ...restricted, PSModulePath: "" }],
  ["first3(pwsh7)", { ...restricted, PSModulePath: parts.slice(0, 3).join(";") }],
  ["last4(winps)", { ...restricted, PSModulePath: parts.slice(4).join(";") }],
  ["nonexistent", { ...restricted, PSModulePath: "C:\\nonexistent" }],
  ["sys32only", { ...restricted, PSModulePath: `${restricted.SYSTEMROOT}\\system32\\WindowsPowerShell\\v1.0\\Modules` }],
  ["fullEnvNoPSModulePath", noPs],
  ["full", { ...process.env } as Record<string, string>],
  ["restricted+SystemRoot-lower+Path", { ...restricted, PSModulePath: real, PATH: restricted.PATH ?? "" }],
];
for (const [label, env] of variants) {
  const args = ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", FIXTURE_STDIO];
  const l = windowsJobCommand(NODE, args, process.env);
  const s = Date.now();
  const c = spawn(l.command, l.args, { env, windowsHide: true, stdio: "pipe" });
  let got = ""; let err = "";
  c.stdout.on("data", (b) => { if (!got) console.log(ts(), label, "FIRST STDOUT after", Date.now() - s); got += b; });
  c.stderr.on("data", (b) => { err += b; });
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d", version: "1" } } }) + "\n");
  for (let i = 0; i < 100 && !got; i++) await new Promise((r) => setTimeout(r, 100));
  console.log(ts(), label, got ? "OK" : "NO ANSWER", "stderr:", JSON.stringify(err.slice(0, 200)));
  c.stdin.end(); await new Promise((r) => setTimeout(r, 1500));
  if (c.exitCode === null) { spawn("taskkill.exe", ["/PID", String(c.pid), "/T", "/F"]); await new Promise((r) => setTimeout(r, 1000)); }
}
