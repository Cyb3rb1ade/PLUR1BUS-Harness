// Entry of dist/acp.js: `plur1bus acp serve` execs Node on it. stdout is ACP JSON-RPC only; logs go to stderr.
import { runAcpMain } from "./acp/main.ts";

for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
// `--flag=` (an empty value) is a usage error, not "use the default": `--home=` must not quietly connect to the user's real home.
const emptyFlag = process.argv.slice(2).find((a) => /^--[^=]+=$/.test(a));
if (emptyFlag) { process.stderr.write(`acp: ${emptyFlag.slice(0, -1)} needs a value\n`); process.exit(2); }
process.exitCode = await runAcpMain(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
// A client that closed stdin is gone: do not wait for the connection's last handles.
process.exit();
