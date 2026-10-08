import { spawn } from "node:child_process";
import { windowsJobCommand } from "../../../src/mcp/windows-job.ts";
import { FIXTURE_STDIO, NODE } from "./util.ts";
const t0 = Date.now(); const ts = () => `[${Date.now() - t0}ms]`;
for (const mode of ["job", "direct"]) {
  const args = ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", FIXTURE_STDIO];
  const l = mode === "job" ? windowsJobCommand(NODE, args, process.env) : { command: NODE, args };
  console.log(ts(), mode, "spawn");
  const c = spawn(l.command, l.args, { windowsHide: true, stdio: "pipe" });
  c.stdout.on("data", (b) => console.log(ts(), mode, "stdout", JSON.stringify(String(b).slice(0, 200))));
  c.stderr.on("data", (b) => console.log(ts(), mode, "stderr", JSON.stringify(String(b).slice(0, 400))));
  c.on("exit", (code, sig) => console.log(ts(), mode, "exit", code, sig));
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d", version: "1" } } }) + "\n");
  await new Promise((r) => setTimeout(r, 25000));
  console.log(ts(), mode, "end stdin"); c.stdin.end();
  await new Promise<void>((r) => { const k = setTimeout(r, 25000); c.on("close", () => { console.log(ts(), mode, "close"); clearTimeout(k); r(); }); });
  if (c.exitCode === null) { console.log(ts(), mode, "still alive; taskkill"); spawn("taskkill.exe", ["/PID", String(c.pid), "/T", "/F"]); await new Promise((r) => setTimeout(r, 2000)); }
}
