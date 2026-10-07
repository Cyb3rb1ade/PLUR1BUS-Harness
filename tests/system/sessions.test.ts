import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { cli, home, reapHome, startCore, stopCore, type RunningCore } from "./helpers.ts";

const FAKE = { PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TEST_CHAT_PROVIDER: "fake" };

async function withCore(extra: NodeJS.ProcessEnv, fn: (h: string) => Promise<void>): Promise<void> {
  const h = home(); let core: RunningCore | undefined;
  try {
    cli(h, ["agent", "create", "bernd"]);
    cli(h, ["config", "set", "engine.duplicateThreshold", "1.01", "--yes"]);
    core = await startCore(h, extra);
    await fn(h);
  } finally { if (core) await stopCore(core); await reapHome(h); rmSync(h, { recursive: true, force: true }); }
}

describe("M1b-2c — sessions and chat through the CLI (fake provider)", () => {
  it("chat → session list/show/archive", async () => {
    await withCore(FAKE, async (h) => {
      const turn = cli(h, ["chat", "--agent", "bernd", "the boiler service is on Tuesday"]);
      assert.equal(turn.schema, "chat.turn/1"); assert.equal(turn.state, "completed");
      assert.equal(turn.reply, "echo[bernd]: the boiler service is on Tuesday");

      const list = cli(h, ["session", "list"]);
      assert.equal(list.schema, "session.list/1"); assert.equal(list.sessions.length, 1); assert.equal(list.sessions[0].id, turn.sessionId);
      assert.equal(cli(h, ["session", "list", "--search", "boiler"]).sessions.length, 1);
      assert.equal(cli(h, ["session", "list", "--search", "nothing-like-this"]).sessions.length, 0);

      // a second turn in the same session through --session; single agent needs no --agent
      const again = cli(h, ["chat", "--session", turn.sessionId, "and again"]);
      assert.equal(again.sessionId, turn.sessionId);
      const show = cli(h, ["session", "show", turn.sessionId]);
      assert.equal(show.schema, "session.get/1");
      assert.deepEqual(show.messages.map((m: any) => m.role), ["user", "assistant", "user", "assistant"]);
      assert.equal(show.session.turnCount, 2);

      const inc = cli(h, ["chat", "--no-memory", "private thought"]);
      assert.equal(cli(h, ["session", "show", inc.sessionId]).session.memoryMode, "incognito");
      assert.equal(cli(h, ["memory", "list", "--agent", "bernd"]).items.some((i: any) => /private thought/.test(i.text ?? "")), false);

      const arch = cli(h, ["session", "archive", turn.sessionId]);
      assert.equal(arch.schema, "session.archive/1"); assert.notEqual(arch.session.archivedAt, null);
      assert.equal(cli(h, ["session", "list"]).sessions.some((s: any) => s.id === turn.sessionId), false);
      assert.equal(cli(h, ["session", "list", "--archived", "only"]).sessions.length, 1);
      const refused = cli(h, ["chat", "--session", turn.sessionId, "x"], { allowFail: true });
      assert.equal(refused.exit, 1); assert.equal(JSON.parse(refused.stdout).error, "E_CONFLICT");
      const missing = cli(h, ["session", "show", "ses_nope"], { allowFail: true });
      assert.equal(JSON.parse(missing.stdout).error, "E_NOT_FOUND");
    });
  });

  it("without a provider, chat says so clearly and exits non-zero", async () => {
    await withCore({}, async (h) => {
      const r = cli(h, ["chat", "--agent", "bernd", "hi"], { allowFail: true });
      assert.equal(r.exit, 2);
      const doc = JSON.parse(r.stdout);
      assert.deepEqual({ e: doc.error, r: doc.reason, s: doc.schema }, { e: "E_NOT_AVAILABLE", r: "no-provider", s: "error/1" });
      const human = cli(h, ["chat", "--agent", "bernd", "hi"], { json: false, allowFail: true });
      assert.match(human.stderr, /no chat provider is configured/);
    });
  });
});
