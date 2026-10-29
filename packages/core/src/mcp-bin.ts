#!/usr/bin/env node
// Entry of dist/mcp.js: `plur1bus mcp serve` execs Node on it. stdout is MCP JSON-RPC only; logs go to stderr.
import { runMcpMain } from "./mcp/stdio-server.ts";

for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
const emptyFlag = process.argv.slice(2).find((a) => /^--[^=]+=$/.test(a));
if (emptyFlag) {
  process.stderr.write(`mcp: ${emptyFlag.slice(0, -1)} needs a value\n`);
  process.exit(2);
}
process.exitCode = await runMcpMain(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit();
