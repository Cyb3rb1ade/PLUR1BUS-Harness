// E3: CLI → daemon → core on a fresh home, then backup → verify → restore into a second home. Real binary, real
// supervisor and core, fake chat provider (test-internals env guard). Real-model mode downloads pinned models.
// Native five-target CI runs both flat functional and real embedding/reranker installed-runtime smoke.
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { BIN, REAL, RERANK_FAILURE, waitEngineReady, waitFor, cli, daemonStatus, home, reapHome, startDaemon, stopDaemon } from "../system/helpers.ts";

const FAKE = { PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TEST_CHAT_PROVIDER: "fake" };
/** pnpm's deploy joins the workspace directory with a path relative to it; across Windows drives that path is
 *  absolute and the deploy fails with ENOENT (a `D:` checkout with `%TEMP%` on `C:`). The installation therefore
 *  lives under the checkout's `target/` (gitignored) when the system temp directory is on another volume, the same
 *  rule as scripts/release/assemble-payload.mjs. */
function installationParent(): string {
  const volume = (d: string) => parse(resolve(d)).root.toLowerCase();
  if (volume(tmpdir()) === volume(".")) return tmpdir();
  const parent = resolve("target");
  mkdirSync(parent, { recursive: true });
  return parent;
}

const FACT = "Please remember that the e2e smoke test fact is the harbour tour at noon.";

/** `<mtime> <bytes> <path>` for every file under the home's model cache. A finished artefact's mtime is when its
 *  download ended; a `.part-<pid>-…` file is a download still running, or one a stopped core left behind. */
function modelFiles(h: string): string[] {
  const dir = join(h, "models");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((rel) => ({ rel, s: statSync(join(dir, rel)) })).filter(({ s }) => s.isFile())
    .map(({ rel, s }) => `${s.mtime.toISOString()} ${String(s.size).padStart(11)} ${rel}`).sort();
}

/** The core's own timing lines from `logs/core.log`: each start (`core.process.ready`), the model warm-up (`models warm`,
 *  `recall path warm`, `reranker warm` and its patience limit) and, per turn, how long each pipeline stage took (a stage
 *  without an end record is still running). */
function coreTimings(h: string): string[] {
  const file = join(h, "logs", "core.log");
  if (!existsSync(file)) return [];
  const out: string[] = []; const turns = new Map<string, Map<string, string>>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    if (r.msg === "turn.stage") {
      const spans = turns.get(r.trace_id) ?? new Map<string, string>(); turns.set(r.trace_id, spans);
      spans.set(r.span_id, r.phase === "start" ? `${r.stage} running since ${r.at}` : `${r.stage}${r.phase === "error" ? ` error ${r.code}` : ""} ${Math.round(r.durationMs)} ms`);
    } else if (r.event === "core.process.ready" || /^(models warm|recall path warm|reranker warm)/.test(r.msg ?? "")) out.push(line);
  }
  for (const [trace, spans] of turns) out.push(`turn ${trace.slice(0, 8)}: ${[...spans.values()].join(", ")}`);
  return out;
}

/** The supervisor's view of its children: every warning and error (a failed health poll is a core that did not answer
 *  `core.status` within 2 s; 30 s without an answer is a hang, and the core is terminated) and every spawn and exit. */
function supervisorEvents(h: string): string[] {
  const file = join(h, "logs", "supervisor.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((line) => /"level":"(warn|error)"|"msg":"([\w.-]+ (exited|spawned|ready|adopted)|restarting )/.test(line));
}

/** What a red run needs to say where the time went: the tails of the home's core and supervisor logs, the core's
 *  timing lines and the model cache. Printed for every failure (the logs of a home that never started are absent). */
function printHome(h: string): void {
  for (const name of ["core.log", "supervisor.log"]) {
    const file = join(h, "logs", name);
    if (existsSync(file)) console.error(`--- ${name} of ${h} (tail) ---\n${readFileSync(file, "utf8").slice(-12_000)}`);
  }
  console.error(`--- core timings of ${h} ---\n${coreTimings(h).join("\n")}\n--- supervisor events of ${h} ---\n${supervisorEvents(h).join("\n")}`);
  console.error(`--- models of ${h} ---\n${modelFiles(h).join("\n")}`);
}

/** Runs `f` and records its wall time as a test diagnostic, also when it throws: a green run gives the numbers a red
 *  one is compared with. */
function timed<T>(t: TestContext, what: string, f: () => T): T {
  const t0 = performance.now();
  try { return f(); } finally { t.diagnostic(`${what}: ${Math.round(performance.now() - t0)} ms`); }
}

describe("E3 — CLI → daemon → core smoke", () => {
  it("fresh home: daemon, agent, chat, backup → verify → restore elsewhere, clean stop", { timeout: REAL ? 600_000 : 240_000 }, async (t) => {
    const h1 = home();
    const h2 = home();
    const archive = join(h1, "smoke.tar.gz");
    const installation = mkdtempSync(join(installationParent(), "p1b-smoke-install-"));
    const payload = join(installation, "core");
    const service = join(installation, "service");
    mkdirSync(service);
    const user = join(installation, "user");
    mkdirSync(user);
    const installedBinary = join(installation, process.platform === "win32" ? "plur1bus.exe" : "plur1bus");
    cpSync(BIN, installedBinary);
    const installedEnv: NodeJS.ProcessEnv = { ...process.env, ...FAKE, ...(REAL ? {} : { PLUR1BUS_TEST_INTERNALS: "flat-embedder" }), PLUR1BUS_SERVICE_FAKE: service, PLUR1BUS_UPDATE_TARGET_BIN: installedBinary, HOME: user, USERPROFILE: user, LOCALAPPDATA: join(user, "AppData", "Local"), XDG_CONFIG_HOME: join(user, ".config") };
    for (const key of ["PLUR1BUS_NODE", "PLUR1BUS_CORE_JS", "PLUR1BUS_NODE_MIRROR", "PLUR1BUS_CONTAINER", "PLUR1BUS_HOME"]) delete installedEnv[key];
    if (REAL) delete installedEnv.PLUR1BUS_TEST_INTERNALS;
    if (process.env.PLUR1BUS_SMOKE_NODE_MIRROR) installedEnv.PLUR1BUS_NODE_MIRROR = process.env.PLUR1BUS_SMOKE_NODE_MIRROR;
    try {
      // Deploy the same production payload shape used by setup; dependencies stay pinned.
      // Hoisted, like the release payload (scripts/release/assemble-payload.mjs): setup copies link targets on
      // Windows, which only resolves for a flat node_modules.
      execFileSync("pnpm", ["--filter", "@plur1bus/core", "deploy", "--legacy", "--prod", "--config.node-linker=hoisted", payload], { stdio: ["ignore", "inherit", "inherit"], shell: process.platform === "win32" });
      cpSync(resolve("packages/core/dist"), payload, { recursive: true });
      assert.deepEqual(readdirSync(h1), [], "the home starts empty before installation");
      let setupOut: string;
      try {
        setupOut = timed(t, "setup", () => execFileSync(installedBinary, ["--json", "--home", h1, "setup", "--non-interactive", "--no-service", "--core-from", payload], { encoding: "utf8", env: installedEnv, timeout: 300_000 }));
      } catch (e) {
        // `setup` answers a failure with a JSON document on stdout (`reason`: not-ready, core-crashed, ... and the last supervisor status);
        // without it a red run only says "exit 1". A crashed core reports only "gave-up": the catch below prints its log.
        const failure = (e as { stdout?: unknown }).stdout;
        if (typeof failure === "string" && failure !== "") console.error(`--- setup stdout (tail) ---\n${failure.slice(-4000)}`);
        throw e;
      }
      const setup = JSON.parse(setupOut);
      assert.equal(setup.check.fail, 0);
      assert.equal(setup.manifest.node.version, "24.21.0");
      stopDaemon(h1);
      if (process.env.PLUR1BUS_CI_RECALL_HARD_MS) {
        // Hard first: the soft budget may not exceed the hard one, and each `config set` is validated on its own.
        for (const key of ["core.recall.hardBudgetMs", "core.recall.softBudgetMs"]) cli(h1, ["config", "set", key, process.env.PLUR1BUS_CI_RECALL_HARD_MS, "--yes"]);
      }
      // RULING: no `init` command; a home comes into being with its first write.
      assert.equal(cli(h1, ["agent", "create", "bernd"]).created, true);
      assert.ok(existsSync(join(h1, "config.json")), "the first write materialises the home");

      // ── daemon
      t.diagnostic(`daemon start at ${new Date().toISOString()}`);
      cli(h1, ["daemon", "start"], { env: installedEnv });
      const status = daemonStatus(h1);
      assert.equal(typeof status.supervisor.pid, "number");
      assert.equal(status.children[0].role, "core");
      assert.equal(status.children[0].process.state, "ready", JSON.stringify(status.children[0]));
      assert.equal(typeof status.children[0].pid, "number");

      t.diagnostic(`models warm ${Math.round(await waitEngineReady(h1, REAL ? 60_000 : 30_000))} ms after daemon start`);

      // ── memory + one chat session (create + submit) and a second turn on it
      assert.equal(timed(t, "memory add", () => cli(h1, ["memory", "add", "--agent", "bernd", "--session", "s1", FACT])).stored, 1);
      const turn = timed(t, "first chat turn", () => cli(h1, ["chat", "--agent", "bernd", "hello from the smoke test"]));
      assert.equal(turn.schema, "chat.turn/1");
      assert.equal(turn.state, "completed");
      assert.equal(turn.reply, "echo[bernd]: hello from the smoke test");
      const again = timed(t, "second chat turn", () => cli(h1, ["chat", "--session", turn.sessionId, "and a second turn"]));
      assert.equal(again.sessionId, turn.sessionId);
      const shown = cli(h1, ["session", "show", turn.sessionId]);
      assert.deepEqual(shown.messages.map((m: any) => m.role), ["user", "assistant", "user", "assistant"]);
      const memoryIds = (h: string) => cli(h, ["memory", "list", "--agent", "bernd"]).items.map((i: any) => i.id as string).sort();
      if (REAL) assert.equal(cli(h1, ["memory", "add", "--agent", "bernd", "--session", "s1", "Please remember that the quarterly budget draft is due in March."]).stored, 1);
      const logFile = join(h1, "logs", "core.log");
      const logMark = existsSync(logFile) ? statSync(logFile).size : 0;
      const recall = cli(h1, ["memory", "recall", "--agent", "bernd", "--session", "s2", "--joined", "harbour tour"]);
      assert.equal(recall.degraded, null, JSON.stringify(recall));
      assert.match(recall.joined.text, /harbour tour/);
      if (REAL) {
        assert.ok((recall.timing?.namespacePhases ?? []).some((p: any) => p.phase === "rerank" && p.ms >= 5), "real reranker must run");
        const logs = existsSync(logFile) ? readFileSync(logFile).subarray(logMark).toString("utf8") : "";
        assert.equal(logs.split("\n").find(line => RERANK_FAILURE.test(line)), undefined, "no reranker fallback");
      }
      stopDaemon(h1);
      t.diagnostic(`daemon restart at ${new Date().toISOString()}`);
      cli(h1, ["daemon", "start"], { env: installedEnv });
      t.diagnostic(`models warm ${Math.round(await waitEngineReady(h1, REAL ? 60_000 : 30_000))} ms after the restart`);
      const restartedRecall = cli(h1, ["memory", "recall", "--agent", "bernd", "--session", "after-restart", "--joined", "harbour tour"]);
      assert.equal(restartedRecall.degraded, null);
      assert.match(restartedRecall.joined.text, /harbour tour/);
      for (const line of [...coreTimings(h1), ...supervisorEvents(h1), ...(REAL ? modelFiles(h1) : [])]) t.diagnostic(line);
      const idsBefore = memoryIds(h1);
      assert.ok(idsBefore.length >= 1, "the fact is stored");

      // ── backup create → verify (daemon still running)
      const created = cli(h1, ["backup", "create", "--out", archive]);
      assert.equal(created.schema, "backup.create/1");
      assert.equal(created.secrets.included, false);
      assert.ok(created.units.includes("config.json") && created.units.includes("state/lancedb"), JSON.stringify(created.units));
      const verified = cli(h1, ["backup", "verify", archive]);
      assert.equal(verified.ok, true);

      // ── clean stop: nothing is left against h1
      stopDaemon(h1);
      assert.equal(daemonStatus(h1).supervisor.process.state, "stopped", "no supervisor answers after daemon stop");
      assert.deepEqual(daemonStatus(h1).children, []);

      // ── restore into a second, empty home and look at it through a daemon of its own
      const restored = cli(h2, ["backup", "restore", "--yes", archive]);
      assert.equal(restored.applied, true, JSON.stringify(restored));
      startDaemon(h2, FAKE);
      assert.ok(JSON.stringify(cli(h2, ["agent", "list"])).includes("bernd"), "the agent came across");
      assert.deepEqual(memoryIds(h2), idsBefore, "the same memories");
      if ((created.units as string[]).includes("state/sessions.sqlite")) {
        assert.equal(cli(h2, ["session", "show", turn.sessionId]).session.turnCount, 2, "the session came across");
      } else {
        t.diagnostic("sessions.sqlite is not an archived unit; session carry-over not asserted");
      }
      stopDaemon(h2);
      assert.equal(daemonStatus(h2).supervisor.process.state, "stopped", "no supervisor answers after daemon stop (h2)");
      const uninstalled = cli(h1, ["uninstall", "--yes"], { env: installedEnv });
      assert.deepEqual(uninstalled.result.failures, []);
      assert.equal(cli(h1, ["service", "status"], { env: installedEnv }).registered, false);
      await waitFor("installed binary removed (deferred on Windows)", () => !existsSync(installedBinary), 10_000);
      assert.equal(existsSync(join(h1, "runtime")), false);
      assert.equal(daemonStatus(h1).supervisor.process.state, "stopped");
    } catch (e) {
      for (const h of [h1, h2]) printHome(h);
      throw e;
    } finally {
      for (const h of [h1, h2]) {
        try { cli(h, ["daemon", "stop"], { allowFail: true }); } catch { /* best effort */ }
        await reapHome(h);
        rmSync(h, { recursive: true, force: true });
      }
      rmSync(installation, { recursive: true, force: true });
    }
  });
});
