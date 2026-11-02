// The turn provider: a successful tool result is redacted against the registered secret values before the model, the stream
// (and so the transcript), the offloaded result file, memory capture and the audit/log records see it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTurnProvider } from "../../src/composition/provider.ts";
import { createPolicyAudit } from "../../src/policy/audit.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { Compactor, defaultCompaction } from "../../src/session/compaction.ts";
import type { TurnMemory } from "../../src/session/memory-port.ts";
import { SessionStore } from "../../src/session/store.ts";
import { TurnRunner } from "../../src/session/turn-loop.ts";
import type { StreamingAdapter, ChatResult } from "../../../providers/src/index.ts";
import { collect, readTool, scriptedAdapter, turnFixture, TURN_PRINCIPAL, useTempDirs, type ScriptedRound } from "./helpers.ts";

const tmp = useTempDirs("p1b-result-redaction-");
/** A fake secret value derived from a short label at run time; no token-like literal is committed. */
const fakeSecret = (label: string): string => `fixture-${label}-${createHash("sha256").update(label).digest("hex").slice(0, 16)}`;
const MARK = "[REDACTED:secret]";
const call = (id: string) => ({ id, name: "file.read", args: { path: "x" } });
const toolMessage = (messages: { role: string; content?: unknown }[]): string => {
  const m = messages.find((x) => x.role === "tool");
  assert.ok(m && typeof m.content === "string");
  return m.content as string;
};
async function setup(rounds: ScriptedRound[], extra: Parameters<typeof turnFixture>[1] = {}) {
  const s = scriptedAdapter(rounds);
  return { ...s, ...turnFixture(s.adapter, extra, tmp.make()) };
}

describe("composition/provider: a successful tool result never carries a registered secret value", () => {
  it("(a) the model and the stream get the redacted value; the secret is not in any request or chunk", async () => {
    const secret = fakeSecret("model");
    const { provider, registry, requests, close } = await setup([{ calls: [call("c1")] }, { text: "done" }], { secrets: () => [secret] });
    registry.register(readTool("file.read", async () => ({ text: `api=${secret}`, lines: 1 })));
    try {
      const chunks = await collect(provider);
      assert.equal(requests.length, 2);
      const seen = toolMessage(requests[1]!.messages as never);
      assert.deepEqual(JSON.parse(seen), { isError: false, value: { text: `api=${MARK}`, lines: 1 }, truncated: false });
      const streamed = chunks.find((c) => c.type === "tool.result");
      assert.ok(streamed && streamed.type === "tool.result");
      assert.equal(streamed.output, seen);
      assert.ok(!JSON.stringify([requests, chunks]).includes(secret));
    } finally { close(); }
  });

  it("(c) the offloaded result file (over 32 KiB) is written from the redacted value", async () => {
    const secret = fakeSecret("offload");
    const dir = tmp.make();
    const files: string[] = [];
    // the production store: one `<uuid>.json` per result under state/tool-results
    const resultStore = { async put(value: unknown) { const id = randomUUID(); const file = join(dir, `${id}.json`); await writeFile(file, JSON.stringify(value), { flag: "wx", mode: 0o600 }); files.push(file); return `tool-result:${id}`; } };
    const { provider, registry, requests, close } = await setup([{ calls: [call("c1")] }, { text: "done" }], { secrets: () => [secret], resultStore });
    registry.register(readTool("file.read", async () => `${"x".repeat(40 * 1024)} ${secret} ${"y".repeat(1024)}`));
    try {
      await collect(provider);
      const seen = JSON.parse(toolMessage(requests[1]!.messages as never)) as { truncated: boolean; reference: string };
      assert.equal(seen.truncated, true, "the over-limit path was taken");
      assert.equal(files.length, 1);
      assert.deepEqual(readdirSync(dir).length, 1);
      const stored = readFileSync(files[0]!, "utf8");
      assert.ok(!stored.includes(secret), "no secret value on disk");
      assert.ok(stored.includes(MARK));
      assert.doesNotThrow(() => JSON.parse(stored));
    } finally { close(); }
  });

  it("(d) the audit lines and the stage logs written for the call carry no value, and the outcome size is the redacted size", async () => {
    const secret = fakeSecret("audit");
    const events = memoryAuditSink();
    const audit = createPolicyAudit({ sink: events, clock: { now: () => 1000 }, host: "h" });
    const { provider, registry, requests, logs, close } = await setup([{ calls: [call("c1")] }, { text: "done" }], { secrets: () => [secret], audit });
    registry.register(readTool("file.read", async () => ({ text: `api=${secret}` })));
    try {
      await collect(provider);
      assert.ok(events.events.length >= 2, "decision and outcome lines");
      assert.ok(!JSON.stringify([events.events, logs]).includes(secret));
      const outcome = events.events.find((e) => JSON.stringify(e).includes("policy.outcome")) as unknown as { detail: { resultBytes: number } };
      assert.equal(outcome.detail.resultBytes, Buffer.byteLength(JSON.stringify({ text: `api=${MARK}` }), "utf8"));
      assert.ok(!toolMessage(requests[1]!.messages as never).includes(secret));
    } finally { close(); }
  });

  it("results without a registered value are identical to a provider without a registry", async () => {
    const payload = { text: "https://example.test/a?x=1 password=hunter2", nested: [1, null, { ok: true }] };
    const messages: string[] = [];
    for (const secrets of [undefined, () => [fakeSecret("absent")]]) {
      const { provider, registry, requests, close } = await setup([{ calls: [call("c1")] }, { text: "done" }], secrets ? { secrets } : {});
      registry.register(readTool("file.read", async () => payload));
      try { await collect(provider); messages.push(toolMessage(requests[1]!.messages as never)); } finally { close(); }
    }
    assert.equal(messages[0], messages[1]);
    assert.deepEqual(JSON.parse(messages[0]!), { isError: false, value: payload, truncated: false });
  });

  it("the failure path is unchanged: a thrown message is still masked, with the same marker", async () => {
    const secret = fakeSecret("error");
    const { provider, registry, requests, close } = await setup([{ calls: [call("c1")] }, { text: "recovered" }], { secrets: () => [secret] });
    registry.register(readTool("file.read", async () => { throw Object.assign(new Error(`upstream said ${secret}`), { code: "disk_gone" }); }));
    try {
      await collect(provider);
      const seen = toolMessage(requests[1]!.messages as never);
      assert.ok(!seen.includes(secret));
      assert.match(seen, /\[REDACTED:secret\]/);
      assert.equal(JSON.parse(seen).error.sourceCode, "disk_gone");
    } finally { close(); }
  });
});

describe("composition/provider with the turn loop: transcript and memory capture", () => {
  /** A model that answers with what it was shown: the second round repeats the tool message verbatim. */
  const echoingModel = (): StreamingAdapter => {
    let round = 0;
    return { async *stream(request) {
      round++;
      const shown = request.messages.filter((m) => m.role === "tool").map((m) => (m.role === "tool" ? m.content : "")).join("\n");
      const calls = round === 1 ? [{ id: "c1", name: "file.read", arguments: { path: "x" }, argumentsRaw: JSON.stringify({ path: "x" }) }] : [];
      const text = round === 1 ? "" : `the tool said: ${shown}`;
      if (text) yield { type: "text_delta", text };
      yield { type: "done", result: { text, toolCalls: calls, finishReason: calls.length ? "tool_calls" : "stop", rawFinishReason: "stop", usage: { inputTokens: 10, outputTokens: 2 }, meta: {} } as unknown as ChatResult };
    } };
  };

  it("(b) the stored transcript row and the captured memory hold the redacted value", async () => {
    const secret = fakeSecret("transcript");
    const { provider, registry, close } = turnFixture(echoingModel(), { secrets: () => [secret] }, tmp.make());
    registry.register(readTool("file.read", async () => ({ text: `api=${secret}` })));
    const store = new SessionStore({ path: ":memory:" });
    const captured: unknown[] = [];
    const memory: TurnMemory = { async recall() { return { text: "", degraded: null }; }, async capture(a) { captured.push(a.messages); }, async checkpoint() {} };
    const compactor = new Compactor(store, defaultCompaction(8192), { beforeSwap: async () => {} });
    const runner = new TurnRunner({ store, compactor, memory, provider: () => provider as never });
    try {
      const session = store.createSession({ kind: "direct", agentId: "a1", owner: TURN_PRINCIPAL, memoryMode: "remember" });
      const out = await runner.submit({ session, caller: { channel: "cli", accountId: "acc", userId: "u" }, text: "read it" }).done;
      assert.equal(out.state, "completed", JSON.stringify(out));
      const rows = store.listEvents(session.id).filter((e) => e.type === "tool.result");
      assert.equal(rows.length, 1);
      const output = rows[0]!.data.output as string;
      assert.ok(!output.includes(secret));
      assert.deepEqual(JSON.parse(output), { isError: false, value: { text: `api=${MARK}` }, truncated: false });
      // the reply repeats what the model was shown; neither the stored events nor the capture hold the value
      assert.ok(!JSON.stringify(store.listEvents(session.id)).includes(secret));
      assert.ok(captured.length >= 1 && !JSON.stringify(captured).includes(secret));
      assert.ok(JSON.stringify(captured).includes(MARK), "the model did see the marker");
    } finally { await runner.idle(); close(); }
  });
});
