// Root `pnpm test`: runs every workspace package's `test` script and refuses to pass vacuously.
//
// Why a script and not an inline `pnpm -r --filter '!pkg' test`: single quotes are literal characters under
// cmd.exe, so the filter matched no project on Windows, pnpm printed "No projects matched" and exited 0, and the
// Windows leg ran zero TypeScript tests for days. Arguments here are passed as an argv array (no shell quoting),
// and the guard below fails the run when no test ran or pnpm matched nothing.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Excluded: the desktop UI's tests need a browser and run in desktop.yml.
export const EXCLUDED = ["@plur1bus/desktop-ui"];

export function buildArgs(extra = []) {
  return ["-r", ...EXCLUDED.map((p) => `--filter=@nonexistent/${p}`), "--workspace-concurrency=1", ...extra, "test"];
}

/** Sum the `tests N` summary lines node's test runner prints (spec reporter: "ℹ tests 12"; TAP: "# tests 12"). */
export function countTests(output) {
  let total = 0;
  for (const m of output.matchAll(/^\s*(?:ℹ|#)\s+tests\s+(\d+)\s*$/gm)) total += Number(m[1]);
  return total;
}

/** Returns an error message when the output shows a vacuous run, else null. */
export function guard(output, status) {
  if (/No projects matched/i.test(output)) return "pnpm matched no projects (broken --filter?)";
  if (status === 0 && countTests(output) === 0) return "no tests ran (0 tests in total)";
  return null;
}

function main() {
  // `pnpm test` exports npm_execpath (pnpm's own entry); fall back to `pnpm` on PATH.
  const exec = process.env.npm_execpath?.includes("pnpm") ? process.env.npm_execpath : null;
  const args = buildArgs(process.argv.slice(2));
  const child = exec
    ? spawn(process.execPath, [exec, ...args], { stdio: ["inherit", "pipe", "pipe"] })
    : spawn("pnpm", args, { stdio: ["inherit", "pipe", "pipe"], shell: process.platform === "win32" });
  let out = "";
  const tee = (stream, sink) => stream.on("data", (b) => { out += b; sink.write(b); });
  tee(child.stdout, process.stdout);
  tee(child.stderr, process.stderr);
  child.on("close", (code) => {
    const bad = guard(out, code);
    const total = countTests(out);
    if (bad) { console.error(`\nrun-ts-tests: FAIL - ${bad}`); process.exit(code || 1); }
    console.log(`\nrun-ts-tests: ${total} tests in total`);
    process.exit(code ?? 1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
