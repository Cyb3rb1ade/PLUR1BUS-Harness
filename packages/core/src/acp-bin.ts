// Entry of dist/acp.js: `plur1bus acp serve` execs Node on it. stdout is ACP JSON-RPC only; logs go to stderr.
import { runAcpMain } from "./acp/main.ts";

for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
process.exitCode = await runAcpMain(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
// A client that closed stdin is gone: do not wait for the connection's last handles.
process.exit();
