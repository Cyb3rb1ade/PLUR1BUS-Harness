import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CallerIdentity } from "@plur1bus/rpc-schema";
import {
  a2aCaller, createProviderTurnPort, createSessionTurnPort, openA2aSessionBackend, type A2aSessionBackend, type A2aTurnRequest, type TurnChunk,
} from "../../src/a2a/turn-port.ts";
import { FakeChatProvider, type ChatChunk, type ChatProvider, type ChatRequest } from "../../src/session/provider.ts";
import { SessionError } from "../../src/session/types.ts";

async function collect(it: AsyncIterable<TurnChunk>): Promise<TurnChunk[]> {
  const out: TurnChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}
const text = (cs: TurnChunk[]): string => cs.map((c) => (c.type === "delta" ? c.text : "")).join("");
const req = (o: Partial<A2aTurnRequest> = {}): A2aTurnRequest => ({
  peerId: "p1", agentId: "bernd", contextId: "ctx1", sessionId: "ctx1", text: "hi", signal: new AbortController().signal, ...o,
});
/** A gate that only ends when the request is aborted. */
const hang = (r: ChatRequest): Promise<void> => new Promise((_, rej) => {
  if (r.signal.aborted) { rej(r.signal.reason); return; }
  r.signal.addEventListener("abort", () => rej(r.signal.reason), { once: true });
});
const MARKERS: [string, TurnChunk][] = [
  ["please INPUT_REQUIRED now", { type: "pause", state: "input-required", message: "More information is required." }],
  ["AUTH_REQUIRED", { type: "pause", state: "auth-required", message: "Authentication is required." }],
  ["this is a REJECT.", { type: "reject", message: "The agent rejected the task." }],
  ["REJECT", { type: "reject", message: "The agent rejected the task." }],
];
const NOT_MARKERS = ["REJECTED", "xREJECT", "REJECTx", "reject", "input_required", "auth required"];

describe("a2aCaller", () => {
  it("maps a peer to a cli caller identity", () => {
    assert.deepEqual(a2aCaller("peer-1"), { channel: "cli", accountId: "a2a-peer-1", userId: "peer-1" });
    assert.deepEqual(a2aCaller(""), { channel: "cli", accountId: "a2a-", userId: "" });
  });
});

describe("createProviderTurnPort", () => {
  it("available() follows the provider callback", () => {
    let p: ChatProvider | null = null;
    const port = createProviderTurnPort(() => p);
    assert.equal(port.available(), false);
    p = new FakeChatProvider();
    assert.equal(port.available(), true);
  });
  it("ensureSession: contextId is the session id, stable per peer/agent/context", () => {
    const port = createProviderTurnPort(() => null);
    assert.deepEqual(port.ensureSession({ peerId: "a", agentId: "x", contextId: "c" }), { sessionId: "c" });
    assert.deepEqual(port.ensureSession({ peerId: "a", agentId: "x", contextId: "c" }), { sessionId: "c" });
    assert.deepEqual(port.ensureSession({ peerId: "b", agentId: "x", contextId: "c" }), { sessionId: "c" });
    assert.deepEqual(port.ensureSession({ peerId: "a", agentId: "y", contextId: "d" }), { sessionId: "d" });
  });
  it("cancel() always reports no running turn", () => {
    assert.equal(createProviderTurnPort(() => null).cancel("anything"), false);
  });
  for (const [input, expected] of MARKERS) {
    it(`marker ${JSON.stringify(input)} yields one control chunk without touching the provider`, async () => {
      let called = 0;
      const port = createProviderTurnPort(() => { called++; return new FakeChatProvider(); });
      assert.deepEqual(await collect(port.run(req({ text: input }))), [expected]);
      assert.equal(called, 0);
    });
  }
  for (const input of NOT_MARKERS) {
    it(`non-marker ${JSON.stringify(input)} goes to the provider`, async () => {
      const port = createProviderTurnPort(() => new FakeChatProvider());
      const out = await collect(port.run(req({ text: input })));
      assert.ok(out.every((c) => c.type === "delta"));
      assert.equal(text(out), `echo[bernd]: ${input}`);
    });
  }
  it("input-required wins over auth and reject when several markers are present", async () => {
    const port = createProviderTurnPort(() => null);
    const out = await collect(port.run(req({ text: "REJECT AUTH_REQUIRED INPUT_REQUIRED" })));
    assert.deepEqual(out.map((c) => c.type === "pause" ? c.state : c.type), ["input-required"]);
    const out2 = await collect(port.run(req({ text: "REJECT AUTH_REQUIRED" })));
    assert.deepEqual(out2.map((c) => c.type === "pause" ? c.state : c.type), ["auth-required"]);
  });
  it("streams only deltas and forwards the request fields to the provider", async () => {
    let seen: ChatRequest | undefined;
    const port = createProviderTurnPort(() => new FakeChatProvider({ onRequest: (r) => { seen = r; } }));
    const out = await collect(port.run(req({ text: "TOOL go", sessionId: "s9", agentId: "anna" })));
    assert.ok(out.every((c) => c.type === "delta"));
    assert.equal(text(out), "echo[anna]: TOOL go");
    assert.equal(seen!.sessionId, "s9"); assert.equal(seen!.agentId, "anna"); assert.deepEqual(seen!.summaries, []); assert.equal(seen!.memory, "");
    assert.deepEqual(seen!.messages, [{ role: "user", text: "TOOL go" }]);
  });
  it("handles unicode and an empty text", async () => {
    const port = createProviderTurnPort(() => new FakeChatProvider());
    assert.equal(text(await collect(port.run(req({ text: "Grüße 🌍" })))), "echo[bernd]: Grüße 🌍");
    assert.equal(text(await collect(port.run(req({ text: "" })))), "echo[bernd]: ");
  });
  it("throws a no-provider coded error when the provider disappeared", async () => {
    const port = createProviderTurnPort(() => null);
    await assert.rejects(collect(port.run(req())), (e: Error & { code?: string }) => e.code === "no-provider" && /no chat provider/.test(e.message));
  });
  it("an already aborted signal stops before the first chunk and closes the provider stream", async () => {
    let closed = false;
    const provider: ChatProvider = {
      id: "x",
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: false as const, value: { type: "delta" as const, text: "a" } }),
          return: async () => { closed = true; return { done: true as const, value: undefined }; },
        }),
      }),
    };
    const ac = new AbortController(); ac.abort(new Error("stop"));
    await assert.rejects(collect(createProviderTurnPort(() => provider).run(req({ signal: ac.signal }))), /stop/);
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(closed, true);
  });
  it("aborting between chunks throws and closes the stream", async () => {
    const ac = new AbortController();
    let closed = false;
    const provider: ChatProvider = {
      id: "x",
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: false as const, value: { type: "delta" as const, text: "a" } }),
          return: async () => { closed = true; return { done: true as const, value: undefined }; },
        }),
      }),
    };
    const got: string[] = [];
    await assert.rejects((async () => { for await (const c of createProviderTurnPort(() => provider).run(req({ signal: ac.signal }))) { if (c.type === "delta") got.push(c.text); ac.abort(new Error("mid")); } })(), /mid/);
    await new Promise<void>((r) => setImmediate(r));
    assert.deepEqual(got, ["a"]); assert.equal(closed, true);
  });
  it("a provider iterator without return() and one whose return() rejects are both tolerated", async () => {
    const chunks: ChatChunk[] = [{ type: "delta", text: "ok" }, { type: "usage", inputTokens: 1, outputTokens: 1 }];
    const noReturn: ChatProvider = {
      id: "n",
      stream: () => ({ [Symbol.asyncIterator]() { let i = 0; return { next: async () => (i < chunks.length ? { done: false as const, value: chunks[i++]! } : { done: true as const, value: undefined }) }; } }),
    };
    assert.equal(text(await collect(createProviderTurnPort(() => noReturn).run(req()))), "ok");
    const rejecting: ChatProvider = {
      id: "r",
      stream: () => ({ [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next: async () => (i < chunks.length ? { done: false as const, value: chunks[i++]! } : { done: true as const, value: undefined }),
          return: () => Promise.reject(new Error("close failed")),
        };
      } }),
    };
    assert.equal(text(await collect(createProviderTurnPort(() => rejecting).run(req()))), "ok");
  });
  it("a provider error propagates", async () => {
    const port = createProviderTurnPort(() => new FakeChatProvider());
    await assert.rejects(collect(port.run(req({ text: "FAIL this" }))), /fake provider failure/);
  });
});

describe("createSessionTurnPort / openA2aSessionBackend", () => {
  const backends: A2aSessionBackend[] = [];
  afterEach(async () => { while (backends.length) { const b = backends.pop()!; await b.runner.idle(); b.close(); } });
  const open = (provider: () => ChatProvider | null = () => new FakeChatProvider(), clock?: () => number): A2aSessionBackend => {
    const b = openA2aSessionBackend({ provider, ...(clock ? { clock } : {}) });
    backends.push(b); return b;
  };
  const session = (b: A2aSessionBackend, peerId = "p1", agentId = "bernd", contextId = "ctx1"): string =>
    b.port.ensureSession({ peerId, agentId, contextId }).sessionId;

  it("available() follows the provider callback", () => {
    let p: ChatProvider | null = null;
    const b = open(() => p);
    assert.equal(b.port.available(), false);
    p = new FakeChatProvider();
    assert.equal(b.port.available(), true);
  });
  it("accepts an injected clock", () => {
    const b = open(undefined, () => 1_700_000_000_000);
    const id = session(b);
    assert.ok(b.store.getSession(id));
  });
  it("createSessionTurnPort defaults available() to true", () => {
    const b = open();
    assert.equal(createSessionTurnPort({ store: b.store, runner: b.runner }).available(), true);
  });
  it("ensureSession creates a direct session owned by the peer and reuses it", () => {
    const b = open();
    const id = session(b);
    const rec = b.store.getSession(id)!;
    assert.equal(rec.kind, "direct"); assert.equal(rec.agentId, "bernd"); assert.equal(rec.owner, "a2a-peer:p1"); assert.equal(rec.title, "A2A");
    assert.equal(session(b), id);
    assert.notEqual(session(b, "p2"), id);
    assert.notEqual(session(b, "p1", "anna"), id);
    assert.notEqual(session(b, "p1", "bernd", "ctx2"), id);
  });
  it("ensureSession creates a fresh session when the remembered one was erased", () => {
    const b = open();
    const id = session(b);
    b.store.archiveSession(id);
    b.store.eraseSession(id, { actor: "test", reason: "gone" });
    assert.equal(b.store.getSession(id), null);
    const again = session(b);
    assert.notEqual(again, id);
    assert.ok(b.store.getSession(again));
  });
  it("close() closes the store", () => {
    const b = openA2aSessionBackend({ provider: () => null });
    b.close();
    assert.throws(() => b.store.createSession({ kind: "direct", agentId: "a", owner: "o", title: "t" }));
  });

  for (const [input, expected] of MARKERS) {
    it(`marker ${JSON.stringify(input)} yields one control chunk and runs no turn`, async () => {
      const b = open();
      const id = session(b);
      assert.deepEqual(await collect(b.port.run(req({ text: input, sessionId: id }))), [expected]);
      assert.equal(b.store.listTurns(id).length, 0);
    });
  }
  it("a missing session fails with a no-provider coded error", async () => {
    const b = open();
    await assert.rejects(collect(b.port.run(req({ sessionId: "does-not-exist" }))), (e: Error & { code?: string }) => e.code === "no-provider" && /session missing/.test(e.message));
  });
  it("no provider at submit time maps NoProviderError to code no-provider", async () => {
    let p: ChatProvider | null = new FakeChatProvider();
    const b = open(() => p);
    const id = session(b);
    p = null;
    await assert.rejects(collect(b.port.run(req({ sessionId: id }))), (e: Error & { code?: string }) => e.code === "no-provider" && /no chat provider/.test(e.message));
  });
  it("other submit errors are rethrown unchanged", async () => {
    const b = open();
    const id = session(b);
    await assert.rejects(collect(b.port.run(req({ sessionId: id, text: "" }))), (e: unknown) => e instanceof SessionError && e.reason === "text-empty");
  });
  it("streams the reply deltas and does not replay earlier events on the next run", async () => {
    const b = open(() => new FakeChatProvider({ chunkSize: 4 }));
    const id = session(b);
    const first = await collect(b.port.run(req({ sessionId: id, text: "one" })));
    assert.ok(first.length > 1);
    assert.equal(text(first), "echo[bernd]: one");
    const second = await collect(b.port.run(req({ sessionId: id, text: "two" })));
    assert.equal(text(second), "echo[bernd]: two");
  });
  it("tool events from the provider are not surfaced as chunks", async () => {
    const b = open();
    const id = session(b);
    const out = await collect(b.port.run(req({ sessionId: id, text: "TOOL x" })));
    assert.ok(out.every((c) => c.type === "delta"));
    assert.equal(text(out), "echo[bernd]: TOOL x");
  });
  it("uses the injected caller factory", async () => {
    const b = open();
    const id = session(b);
    const seen: string[] = [];
    const callers: CallerIdentity[] = [];
    const port = createSessionTurnPort({
      store: b.store, runner: b.runner, available: () => false,
      caller: (p) => { seen.push(p); const c = { channel: "cli", accountId: `x-${p}`, userId: p } as CallerIdentity; callers.push(c); return c; },
    });
    assert.equal(port.available(), false);
    assert.equal(text(await collect(port.run(req({ sessionId: id, peerId: "zed" })))), "echo[bernd]: hi");
    assert.deepEqual(seen, ["zed"]);
  });
  it("a failing provider turn throws a 'failed' coded error with the turn error", async () => {
    const b = open();
    const id = session(b);
    await assert.rejects(collect(b.port.run(req({ sessionId: id, text: "FAIL it" }))), (e: Error & { code?: string }) => e.code === "failed");
  });
  it("aborting the signal cancels the running turn and ends the stream quietly", async () => {
    const b = open(() => new FakeChatProvider({ gate: hang }));
    const id = session(b);
    const ac = new AbortController();
    const it = b.port.run(req({ sessionId: id, signal: ac.signal }))[Symbol.asyncIterator]();
    const next = it.next();
    for (let i = 0; i < 50 && b.store.runningTurn(id) === null; i++) await new Promise<void>((r) => setImmediate(r));
    assert.equal(b.port.cancel(id), true);
    const r = await next;
    assert.equal(r.done, true);
    const turn = b.store.listTurns(id).at(-1)!;
    assert.equal(turn.state, "failed");
  });
  it("a signal aborted before the run cancels immediately", async () => {
    const b = open(() => new FakeChatProvider({ gate: hang }));
    const id = session(b);
    const ac = new AbortController(); ac.abort();
    const out = await collect(b.port.run(req({ sessionId: id, signal: ac.signal })));
    assert.deepEqual(out, []);
  });
  it("aborting the signal while streaming triggers runner.cancel", async () => {
    const b = open(() => new FakeChatProvider({ gate: hang }));
    const id = session(b);
    const ac = new AbortController();
    const p = collect(b.port.run(req({ sessionId: id, signal: ac.signal })));
    for (let i = 0; i < 50 && b.store.runningTurn(id) === null; i++) await new Promise<void>((r) => setImmediate(r));
    ac.abort();
    assert.deepEqual(await p, []);
  });
  it("cancel() is false when nothing runs, true while a turn runs", async () => {
    const b = open(() => new FakeChatProvider({ gate: hang }));
    const id = session(b);
    assert.equal(b.port.cancel(id), false);
    assert.equal(b.port.cancel("unknown"), false);
    const p = collect(b.port.run(req({ sessionId: id })));
    for (let i = 0; i < 50 && b.store.runningTurn(id) === null; i++) await new Promise<void>((r) => setImmediate(r));
    assert.equal(b.port.cancel(id), true);
    assert.equal(b.port.cancel(id), false); // already cancelling
    await p;
  });
});
