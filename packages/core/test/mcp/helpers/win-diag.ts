import { spawn } from "node:child_process";
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/sdk/client/stdio.js";
import { windowsJobCommand } from "../../../src/mcp/windows-job.ts";
import { FIXTURE_STDIO, NODE } from "./util.ts";
const t0 = Date.now(); const ts = () => `[${Date.now() - t0}ms]`;
const restricted: Record<string, string> = {};
for (const k of DEFAULT_INHERITED_ENV_VARS) if (process.env[k] !== undefined) restricted[k] = process.env[k]!;
const pick = (...names: string[]) => { const o: Record<string, string> = {}; for (const n of names) { const k = Object.keys(process.env).find((x) => x.toLowerCase() === n.toLowerCase()); if (k) o[k] = process.env[k]!; } return o; };
console.log("full env keys", Object.keys(process.env).join(","));
const variants: Array<[string, Record<string, string>]> = [
  ["full", { ...process.env } as Record<string, string>],
  ["restricted", restricted],
  ["+windir", { ...restricted, ...pick("windir") }],
  ["+ProgramData", { ...restricted, ...pick("ProgramData", "ALLUSERSPROFILE") }],
  ["+PSModulePath", { ...restricted, ...pick("PSModulePath") }],
  ["+TMP", { ...restricted, ...pick("TMP") }],
  ["+ComSpec/PATHEXT", { ...restricted, ...pick("ComSpec", "PATHEXT") }],
  ["+COMPUTERNAME/OS/PROC", { ...restricted, ...pick("COMPUTERNAME", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_IDENTIFIER", "USERDOMAIN", "PROGRAMFILES(X86)", "ProgramW6432", "CommonProgramFiles") }],
  ["+windir+TMP+PSModulePath+ProgramData", { ...restricted, ...pick("windir", "TMP", "PSModulePath", "ProgramData", "ALLUSERSPROFILE") }],
];
await Promise.all(variants.map(async ([label, env]) => {
  const args = ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", FIXTURE_STDIO];
  const l = windowsJobCommand(NODE, args, process.env);
  const s = Date.now();
  const c = spawn(l.command, l.args, { env, windowsHide: true, stdio: "pipe" });
  let got = ""; let err = "";
  c.stdout.on("data", (b) => { if (!got) console.log(ts(), label, "FIRST STDOUT after", Date.now() - s); got += b; });
  c.stderr.on("data", (b) => { err += b; });
  c.on("exit", (code) => console.log(ts(), label, "exit", code, "after", Date.now() - s));
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d", version: "1" } } }) + "\n");
  await new Promise((r) => setTimeout(r, 25000));
  console.log(ts(), label, got ? "OK" : "NO ANSWER", "stderr:", JSON.stringify(err.slice(0, 300)));
  c.stdin.end(); await new Promise((r) => setTimeout(r, 2000));
  if (c.exitCode === null) spawn("taskkill.exe", ["/PID", String(c.pid), "/T", "/F"]);
}));
