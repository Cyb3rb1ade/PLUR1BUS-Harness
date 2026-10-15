// E3: CLI → daemon → core on a fresh home, then backup → verify → restore into a second home. Real binary, real
// supervisor and core, fake chat provider (test-internals env guard). Real-model mode downloads pinned models.
// Native five-target CI runs both flat functional and real embedding/reranker installed-runtime smoke.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { BIN, REAL, RERANK_FAILURE, waitEngineReady, waitFor, cli, daemonStatus, home, reapHome, startDaemon, stopDaemon } from "../system/helpers.ts";

const FAKE = { PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TEST_CHAT_PROVIDER: "fake" };
const FACT = "Please remember that the e2e smoke test fact is the harbour tour at noon.";

describe("E3 — CLI → daemon → core smoke", () => {
  it("fresh home: daemon, agent, chat, backup → verify → restore elsewhere, clean stop", { timeout: REAL ? 600_000 : 240_000 }, async (t) => {
    const h1 = home();
    const h2 = home();
    const archive = join(h1, "smoke.tar.gz");
    const installation = mkdtempSync(join(tmpdir(), "p1b-smoke-install-"));
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
      execFileSync("pnpm", ["--filter", "@plur1bus/core", "deploy", "--legacy", "--prod", payload], { stdio: "pipe", shell: process.platform === "win32" });
      cpSync(resolve("packages/core/dist"), payload, { recursive: true });
      assert.deepEqual(readdirSync(h1), [], "the home starts empty before installation");
      const setup = JSON.parse(execFileSync(installedBinary, ["--json", "--home", h1, "setup", "--non-interactive", "--no-service", "--core-from", payload], { encoding: "utf8", env: installedEnv, timeout: 300_000 }));
      assert.equal(setup.check.fail, 0);
      assert.equal(setup.manifest.node.version, "24.21.0");
      stopDaemon(h1);
      if (process.env.PLUR1BUS_CI_RECALL_HARD_MS) {
        for (const key of ["core.recall.softBudgetMs", "core.recall.hardBudgetMs"]) cli(h1, ["config", "set", key, process.env.PLUR1BUS_CI_RECALL_HARD_MS, "--yes"]);
      }
      // RULING: no `init` command; a home comes into being with its first write.
      assert.equal(cli(h1, ["agent", "create", "bernd"]).created, true);
      assert.ok(existsSync(join(h1, "config.json")), "the first write materialises the home");

      // ── daemon
      cli(h1, ["daemon", "start"], { env: installedEnv });
      const status = daemonStatus(h1);
      assert.equal(typeof status.supervisor.pid, "number");
      assert.equal(status.children[0].role, "core");
      assert.equal(status.children[0].process.state, "ready", JSON.stringify(status.children[0]));
      assert.equal(typeof status.children[0].pid, "number");

      await waitEngineReady(h1, REAL ? 60_000 : 30_000);

      // ── memory + one chat session (create + submit) and a second turn on it
      assert.equal(cli(h1, ["memory", "add", "--agent", "bernd", "--session", "s1", FACT]).stored, 1);
      const turn = cli(h1, ["chat", "--agent", "bernd", "hello from the smoke test"]);
      assert.equal(turn.schema, "chat.turn/1");
      assert.equal(turn.state, "completed");
      assert.equal(turn.reply, "echo[bernd]: hello from the smoke test");
      const again = cli(h1, ["chat", "--session", turn.sessionId, "and a second turn"]);
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
      cli(h1, ["daemon", "start"], { env: installedEnv });
      await waitEngineReady(h1, REAL ? 60_000 : 30_000);
      const restartedRecall = cli(h1, ["memory", "recall", "--agent", "bernd", "--session", "after-restart", "--joined", "harbour tour"]);
      assert.equal(restartedRecall.degraded, null);
      assert.match(restartedRecall.joined.text, /harbour tour/);
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
