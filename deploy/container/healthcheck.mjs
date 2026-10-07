// Container HEALTHCHECK (and compose healthcheck): exit 0 when the supervisor answers and its core child is `ready`,
// otherwise 1 with one line on stderr. Read-only: `daemon status` never starts or signals anything.
// PLUR1BUS_HEALTHCHECK_BIN overrides the CLI binary (tests only).
import { execFileSync } from "node:child_process";

const bin = process.env.PLUR1BUS_HEALTHCHECK_BIN || "plur1bus";

function fail(why) {
  console.error(`unhealthy: ${why}`);
  process.exit(1);
}

let out;
try {
  out = execFileSync(bin, ["--json", "daemon", "status"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  // A non-zero exit still prints the document on stdout for some states; use it for the reason when present.
  out = typeof e.stdout === "string" ? e.stdout : "";
  if (out === "") fail(`daemon status failed: ${e.code ?? e.signal ?? e.message}`);
}

let doc;
try {
  doc = JSON.parse(out);
} catch {
  fail("daemon status printed no JSON");
}
const core = (doc.children ?? []).find((c) => c.role === "core" || c.kind === "core");
const state = core?.process?.state;
if (state !== "ready") fail(`core is ${state ?? "absent"}`);
