import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateResult } from "@plur1bus/rpc-schema";
import type { AgentRegistry } from "../src/agents.ts";
import type { HarnessLogger } from "../src/logger.ts";
import { buildMemoryOpMethods, mapMemoryOpError, projectCard, projectProposal, type MemoryOpDeps } from "../src/memory-ops.ts";
import { AGENT_CONTEXT_CLI } from "../src/principal.ts";

const opError = (code: string, detail?: Record<string, string>) =>
  Object.assign(new Error(`engine says ${code}`), { name: "MemoryOpError", code, ...(detail ? { detail } : {}) });

describe("mapMemoryOpError", () => {
  it("maps every MemoryOpErrorCode to its RPC code with reason = code and ids = detail", () => {
    const cases: Array<[string, string, Record<string, string> | undefined]> = [
      ["not-found", "E_NOT_FOUND", undefined],
      ["denied", "E_DENIED", undefined],
      ["invalid-input", "E_INVALID_PARAMS", undefined],
      ["approval-required", "E_APPROVAL_REQUIRED", { id: "m1" }],
      ["conflict", "E_CONFLICT", undefined],
      ["storage", "E_STORAGE", { sourceId: "a", sharedId: "b", staleSharedId: "c" }],
    ];
    for (const [code, rpc, detail] of cases) {
      const r = mapMemoryOpError(opError(code, detail), { stopping: false });
      assert.ok(r, code);
      assert.equal(r.error, rpc, code);
      assert.equal(r.reason, code, code);
      assert.equal(r.message, `engine says ${code}`, code);
      assert.deepEqual(r.ids, detail, code);
    }
  });

  it("an empty detail map carries no ids", () => {
    const r = mapMemoryOpError(opError("not-found", {}), { stopping: false });
    assert.equal(r?.ids, undefined);
    assert.equal(r?.toJSON().data.ids, undefined);
  });

  it("storage while stopping maps to E_CORE_UNAVAILABLE core-stopping", () => {
    const r = mapMemoryOpError(opError("storage"), { stopping: true });
    assert.equal(r?.error, "E_CORE_UNAVAILABLE");
    assert.equal(r?.reason, "core-stopping");
    assert.equal(r?.ids, undefined);
    // A half-finished refresh keeps its recovery ids on the shutdown path too (final review M1).
    const ids = { sourceId: "a", sharedId: "b", staleSharedId: "c" };
    const withIds = mapMemoryOpError(opError("storage", ids), { stopping: true });
    assert.equal(withIds?.error, "E_CORE_UNAVAILABLE");
    assert.equal(withIds?.reason, "core-stopping");
    assert.deepEqual(withIds?.toJSON().data.ids, ids);
    // Any other code keeps its own mapping while stopping.
    assert.equal(mapMemoryOpError(opError("denied"), { stopping: true })?.error, "E_DENIED");
  });

  it("a plain Error and an unknown code return null", () => {
    assert.equal(mapMemoryOpError(new Error("boom"), { stopping: false }), null);
    assert.equal(mapMemoryOpError(opError("exploded"), { stopping: false }), null);
    assert.equal(mapMemoryOpError(Object.assign(new Error("x"), { code: "not-found" }), { stopping: false }), null); // name must match
    assert.equal(mapMemoryOpError("not-found", { stopping: false }), null);
    assert.equal(mapMemoryOpError(null, { stopping: false }), null);
  });
});

describe("projections", () => {
  it("projects a foreign sharedBy and the result validates", () => {
    const engineCard = {
      id: "m2", scope: "user", text: "The standup moved to nine.", summary: "standup at nine", createdAt: 1_700_000_000_000, origin: "user",
      epistemicStatus: null, sharedBy: "Anna.Main", sourceId: "m1", extra: 1,
    } as unknown as Parameters<typeof projectCard>[0];
    const card = projectCard(engineCard);
    assert.equal("extra" in card, false);
    assert.equal(card.sharedBy, "Anna.Main");
    assert.equal(card.sourceId, "m1");
    assert.equal("score" in card, false);
    const v = validateResult("memory.show", { card });
    assert.ok(v.ok, JSON.stringify(v));
  });

  it("projectProposal drops unknown fields and validates inside a proposals.list result", () => {
    const engineProposal = {
      id: "p1", sharedId: "m2", sourceId: "m1", target: "user", sharerAgentId: "Bernd.Main", proposerAgentId: "Anna.Main",
      oldText: "old", newText: "new", note: null, createdAt: 1_700_000_000_000, status: "pending", resolvedAt: null, resultId: null,
      resolutionNote: null, internalPath: "/secret/path.json",
    } as unknown as Parameters<typeof projectProposal>[0];
    const p = projectProposal(engineProposal);
    assert.equal("internalPath" in p, false);
    assert.equal(p.proposerAgentId, "Anna.Main");
    const v = validateResult("memory.proposals.list", { agentId: "bernd", items: [p], truncated: false, unreadable: 0 });
    assert.ok(v.ok, JSON.stringify(v));
  });

  it("the state and proposals.list counts refuse negatives", () => {
    const state = { agentId: "bernd", cards: { agentPrivate: -1, workspace: 0, user: null }, tombstones: 0, archiveDir: "/a" };
    assert.equal(validateResult("memory.state", state).ok, false);
    assert.equal(validateResult("memory.state", { ...state, cards: { agentPrivate: 0, workspace: 0, user: null }, tombstones: -1 }).ok, false);
    assert.equal(validateResult("memory.proposals.list", { agentId: "bernd", items: [], truncated: false, unreadable: -1 }).ok, false);
  });
});

describe("buildMemoryOpMethods (fake engine)", () => {
  const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };
  const workspace = mkdtempSync(join(tmpdir(), "p1b-memops-map-"));
  const agents: AgentRegistry = { list: () => ["bernd"], has: (id) => id === "bernd", scaffold: () => {}, workspaceOf: (id) => (id === "bernd" ? workspace : undefined) };
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; }, setLevel() {}, close: async () => {} } as HarnessLogger;
  const ctx = { signal: new AbortController().signal } as any;

  function fixture(o: { stopping?: () => boolean; fail?: unknown } = {}) {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const rec = (op: string, result: unknown) => async (...args: unknown[]) => { calls.push({ op, args }); if (o.fail !== undefined) throw o.fail; return result; };
    const memory = {
      share: rec("share", { sourceId: "m1", sharedId: "m2", target: "user", extra: true }),
      propose: rec("propose", { proposalId: "p1", sharedId: "m2", sharerAgentId: "bernd" }),
      forget: rec("forget", { id: "m1", archived: true, tombstoneId: "t1", alreadyForgotten: false }),
      proposals: { reject: rec("reject", { proposalId: "p1", status: "rejected" }) },
    };
    const d: MemoryOpDeps = { engine: { memory } as unknown as MemoryOpDeps["engine"], agents, logger, isStopping: o.stopping ?? (() => false) };
    return { calls, methods: buildMemoryOpMethods(d) };
  }

  it("a stopping core refuses every op before the agent check or the engine", async () => {
    const { calls, methods } = fixture({ stopping: () => true });
    await assert.rejects(methods["memory.forget"]({ caller, agentId: "ghost", id: "m1" }, ctx), (e: any) => e.error === "E_CORE_UNAVAILABLE" && e.reason === "core-stopping");
    assert.equal(calls.length, 0);
  });

  it("share passes allowSensitive only for an explicit true; propose and reject pass note only when given", async () => {
    const { calls, methods } = fixture();
    const shared = await methods["memory.share"]({ caller, agentId: "bernd", id: "m1", target: "user" }, ctx);
    assert.deepEqual(shared, { sourceId: "m1", sharedId: "m2", target: "user" }); // projected: no `extra`
    await methods["memory.share"]({ caller, agentId: "bernd", id: "m1", target: "user", allowSensitive: false }, ctx);
    await methods["memory.share"]({ caller, agentId: "bernd", id: "m1", target: "user", allowSensitive: true }, ctx);
    assert.deepEqual(calls.map((c) => c.args.length), [4, 4, 5]);
    assert.deepEqual(calls[2]!.args[4], { allowSensitive: true });
    assert.equal(calls[0]!.args[3], AGENT_CONTEXT_CLI);
    calls.length = 0;
    await methods["memory.propose"]({ caller, agentId: "bernd", sharedId: "m2", text: "new" }, ctx);
    await methods["memory.propose"]({ caller, agentId: "bernd", sharedId: "m2", text: "new", note: "why" }, ctx);
    await methods["memory.proposals.reject"]({ caller, agentId: "bernd", proposalId: "p1" }, ctx);
    await methods["memory.proposals.reject"]({ caller, agentId: "bernd", proposalId: "p1", note: "no" }, ctx);
    assert.deepEqual(calls.map((c) => [c.op, c.args.length]), [["propose", 4], ["propose", 5], ["reject", 3], ["reject", 4]]);
    assert.deepEqual(calls[1]!.args[4], { note: "why" }); assert.deepEqual(calls[3]!.args[3], { note: "no" });
  });

  it("a degraded identity never reaches the engine on a write", async () => {
    const { calls, methods } = fixture();
    await assert.rejects(methods["memory.forget"]({ caller: { ...caller, accountId: "bad\u0001host" }, agentId: "bernd", id: "m1" }, ctx),
      (e: any) => e.error === "E_DENIED" && e.reason === "principal-invalid");
    assert.equal(calls.length, 0);
  });

  it("a storage error during shutdown is E_CORE_UNAVAILABLE; a non-MemoryOpError is rethrown unchanged", async () => {
    const running = fixture({ fail: opError("storage") });
    await assert.rejects(running.methods["memory.forget"]({ caller, agentId: "bernd", id: "m1" }, ctx), (e: any) => e.error === "E_STORAGE" && e.reason === "storage");
    // The stop begins while the engine call is in flight (engine.close() answers `storage`): isStopping is read again when mapping.
    let stopping = false;
    const d = buildMemoryOpMethods({ engine: { memory: { forget: async () => { stopping = true; throw opError("storage"); } } } as unknown as MemoryOpDeps["engine"], agents, logger, isStopping: () => stopping });
    await assert.rejects(d["memory.forget"]({ caller, agentId: "bernd", id: "m1" }, ctx), (e: any) => e.error === "E_CORE_UNAVAILABLE" && e.reason === "core-stopping");
    const boom = new TypeError("boom");
    await assert.rejects(fixture({ fail: boom }).methods["memory.forget"]({ caller, agentId: "bernd", id: "m1" }, ctx), (e: any) => e === boom);
  });
});
