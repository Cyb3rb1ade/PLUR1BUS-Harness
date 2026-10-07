import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Compactor, defaultCompaction } from "../../src/session/compaction.ts";
import { buildSessionMethods } from "../../src/session/methods.ts";
import { FakeChatProvider } from "../../src/session/provider.ts";
import { SessionStore } from "../../src/session/store.ts";
import { TurnRunner } from "../../src/session/turn-loop.ts";
import { userPrincipalHash } from "../../src/principal.ts";
import { RpcError } from "../../src/rpc/errors.ts";

const CALLER = { channel: "cli" as const, accountId: "acc", userId: "u" };
const OTHER = { channel: "cli" as const, accountId: "acc", userId: "someone-else" };

function rig(gate?: () => Promise<void>) {
  const store = new SessionStore({ path: ":memory:" });
  const memory = { recall: async () => ({ text: "", degraded: null }), capture: async () => {}, checkpoint: async () => {} };
  const compactor = new Compactor(store, defaultCompaction(8192), { beforeSwap: async () => {} });
  const runner = new TurnRunner({ store, compactor, memory, provider: () => new FakeChatProvider({ chunkSize: 2, ...(gate ? { gate } : {}) }) });
  const methods = buildSessionMethods({ store, runner, agents: { workspaceOf: () => "/ws" } as never, isStopping: () => false });
  const session = store.createSession({ kind: "acp", agentId: "bernd", owner: userPrincipalHash(CALLER) });
  const call = (m: string, p: object) => methods[m]!(p, { signal: new AbortController().signal } as never) as Promise<any>;
  return { store, runner, session, call };
}

describe("session.cancel", () => {
  it("cancels the running turn; idempotent when none runs; another owner sees E_NOT_FOUND", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const r = rig(async () => { await gate; });
    assert.deepEqual(await r.call("session.cancel", { caller: CALLER, sessionId: r.session.id }), { sessionId: r.session.id, turnId: null, cancelled: false });
    const h = r.runner.submit({ session: r.session, caller: CALLER, text: "hello" });
    await assert.rejects(r.call("session.cancel", { caller: OTHER, sessionId: r.session.id }), (e: unknown) => e instanceof RpcError && e.error === "E_NOT_FOUND");
    assert.deepEqual(await r.call("session.cancel", { caller: CALLER, sessionId: r.session.id }), { sessionId: r.session.id, turnId: h.turnId, cancelled: true });
    release();
    assert.equal((await h.done).error, "cancelled");
  });
});
