// `plur1bus setup` end to end (2a-H3b-b Task 4, spec §6.5): the real Node 24.21.0 from nodejs.org (checked against the
// pinned SHA-256), the real core as a payload (`pnpm --filter @plur1bus/core deploy --prod` plus `dist/`), the
// supervisor started by setup, and a two-session add/recall round trip through the installed runtime. The OS service
// is not registered (`--no-service`; the recording fake answers the status calls). Linux and macOS (CI system job).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BIN, FLAT_INTERNALS, REAL, cli, home, reapHome, waitEngineReady } from "./helpers.ts";

const STEP_IDS = ["state-root", "runtime.node", "runtime.core", "modules.bundled", "config", "skills", "service", "start", "check"];
/** The first run downloads Node (~30 MB); a slow runner gets generous room, the test still ends. */
const SETUP_TIMEOUT_MS = 300_000;

let root = "";
let payload = "";
let fake = "";
const h = home();

/** The setup environment: no dev overrides (PLUR1BUS_NODE, PLUR1BUS_CORE_JS), so the core runs on what setup
 *  installed; the flat embedder unless real models run. */
function setupEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLUR1BUS_ALLOW_TEST_INTERNALS: "1",
    PLUR1BUS_SERVICE_FAKE: fake,
    ...(REAL ? {} : { PLUR1BUS_TEST_INTERNALS: FLAT_INTERNALS }),
  };
  for (const k of ["PLUR1BUS_NODE", "PLUR1BUS_CORE_JS", "PLUR1BUS_NODE_MIRROR", "PLUR1BUS_CONTAINER", "PLUR1BUS_HOME"]) delete env[k];
  return env;
}

/** `plur1bus --json --home <h> setup …` → { code, doc }. */
function setup(args: string[]): { code: number; doc: any } {
  const all = ["--json", "--home", h, "setup", "--non-interactive", "--no-service", "--core-from", payload, ...args];
  try {
    const out = execFileSync(BIN, all, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: SETUP_TIMEOUT_MS, env: setupEnv() });
    return { code: 0, doc: JSON.parse(out) };
  } catch (e: any) {
    if (typeof e.stdout !== "string" || e.stdout === "") throw new Error(`setup: exit ${e.status}\n${e.stderr}`);
    return { code: e.status, doc: JSON.parse(e.stdout) };
  }
}

describe("setup (spec §6.5)", { skip: process.platform === "win32" }, () => {
  before(() => {
    root = mkdtempSync(join(tmpdir(), "p1b-setup-"));
    payload = join(root, "core");
    fake = join(root, "fake");
    mkdirSync(fake);
    // `--legacy`: pnpm 10 deploys a non-injected workspace only that way.
    execFileSync("pnpm", ["--filter", "@plur1bus/core", "deploy", "--legacy", "--prod", payload], { stdio: ["ignore", "pipe", "inherit"], shell: process.platform === "win32" });
    // The payload root holds core.js (setup runs <home>/runtime/core/core.js), next to its node_modules.
    cpSync(resolve("packages/core/dist"), payload, { recursive: true });
    assert.ok(existsSync(join(payload, "core.js")), "payload has core.js");
  });

  after(async () => {
    cli(h, ["daemon", "stop"], { allowFail: true });
    await reapHome(h);
    // The payload and its installed copy are the core with its production dependencies (hundreds of MB each).
    rmSync(root, { recursive: true, force: true });
    rmSync(h, { recursive: true, force: true });
  });

  it("setup then a two-session add and recall round trip", async (t) => {
    const t0 = performance.now();
    const { code, doc } = setup([]);
    t.diagnostic(`setup ${(performance.now() - t0).toFixed(0)} ms: ${JSON.stringify(doc.steps.map((s: any) => `${s.id}:${s.status}`))}`);
    assert.equal(code, 0, JSON.stringify(doc, null, 2));
    assert.equal(doc.check.fail, 0, JSON.stringify(doc.check));
    assert.ok(existsSync(join(h, "runtime/node-24.21.0/bin/node")), "the pinned Node runtime is installed");
    assert.equal(doc.manifest.node.version, "24.21.0");
    assert.match(doc.manifest.core.contract, /^\d+\.\d+\.\d+$/, "the running core reported its contract");

    await waitEngineReady(h, REAL ? 120_000 : 30_000);
    const add = cli(h, ["memory", "add", "--agent", "main", "--session", "s1", "Please remember that the harbour tour starts at nine."]);
    assert.ok(add.stored >= 1, JSON.stringify(add));
    const r = cli(h, ["memory", "recall", "--agent", "main", "--session", "s2", "--joined", "when does the harbour tour start"]);
    assert.equal(r.degraded, null, JSON.stringify(r.degraded));
    assert.match(r.joined.text, /harbour tour/i);
  });

  it("setup --json matches setup/1", () => {
    const { code, doc } = setup([]);
    assert.equal(code, 0, JSON.stringify(doc, null, 2));
    assert.deepEqual(Object.keys(doc).sort(), ["check", "home", "manifest", "schema", "steps", "target"]);
    assert.equal(doc.schema, "setup/1");
    assert.equal(doc.home, h);
    assert.match(doc.target, /^(linux|darwin|win)-(x64|arm64)$/);
    assert.deepEqual(doc.steps.map((s: any) => s.id), STEP_IDS);
    for (const s of doc.steps) {
      assert.ok(["done", "skipped", "failed"].includes(s.status), JSON.stringify(s));
      assert.deepEqual(Object.keys(s).sort(), ["detail", "id", "reason", "status"]);
    }
    const node = doc.steps.find((s: any) => s.id === "runtime.node");
    assert.equal(node.status, "skipped");
    assert.equal(node.reason, "already-installed");
    assert.deepEqual(Object.keys(doc.check).sort(), ["fail", "failing", "ok", "warn"]);
    assert.equal(doc.manifest.schemaVersion, 1);
  });
});
