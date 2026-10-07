// E3: CLI → daemon → core on a fresh home, then backup → verify → restore into a second home. Real binary, real
// supervisor and core, fake chat provider (test-internals env guard), loopback/temp sockets only, no network.
// Linux and macOS; Windows is skipped (the shared reaper is POSIX-only).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REAL, cli, daemonStatus, home, reapHome, startDaemon, stopDaemon } from "../system/helpers.ts";

const FAKE = { PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TEST_CHAT_PROVIDER: "fake" };
const FACT = "Please remember that the e2e smoke test fact is the harbour tour at noon.";

describe("E3 — CLI → daemon → core smoke", { skip: (process.platform === "win32" && "POSIX reaper") || (REAL && "flat embedder only") }, () => {
  it("fresh home: daemon, agent, chat, backup → verify → restore elsewhere, clean stop", { timeout: 240_000 }, async (t) => {
    const h1 = home();
    const h2 = home();
    const archive = join(h1, "smoke.tar.gz");
    try {
      // RULING: no `init` command; a home comes into being with its first write.
      assert.deepEqual(readdirSync(h1), [], "the home starts empty");
      assert.equal(cli(h1, ["agent", "create", "bernd"]).created, true);
      assert.ok(existsSync(join(h1, "config.json")), "the first write materialises the home");

      // ── daemon
      startDaemon(h1, FAKE);
      const status = daemonStatus(h1);
      assert.equal(typeof status.supervisor.pid, "number");
      assert.equal(status.children[0].role, "core");
      assert.equal(status.children[0].process.state, "ready", JSON.stringify(status.children[0]));
      assert.equal(typeof status.children[0].pid, "number");

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
    } finally {
      for (const h of [h1, h2]) {
        try { cli(h, ["daemon", "stop"], { allowFail: true }); } catch { /* best effort */ }
        await reapHome(h);
        rmSync(h, { recursive: true, force: true });
      }
    }
  });
});
