import { pathToFileURL } from "node:url";
import { createExternalTurnService } from "../../packages/core/src/external-turn/index.ts";
import { SessionStore } from "../../packages/core/src/session/store.ts";
import { guardMethods } from "../../packages/core/src/rbac/guard.ts";
import { RpcError } from "../../packages/core/src/rpc/errors.ts";
import type { Principal } from "../../packages/core/src/rbac/types.ts";
import type { CallContext } from "../../packages/core/src/rpc/server.ts";
import type { ChatProvider, ChatRequest } from "../../packages/core/src/session/provider.ts";
import { exporterMain } from "./lib.mjs";

interface Started { sessionId: string; turnId: string; state: string }

async function scenario(name: string, audience: "mcp" | "a2a") {
  let next = 0, now = 10_000;
  const store = new SessionStore({ path: ":memory:", clock: () => now, newId: prefix => prefix + "_" + ++next });
  const signal = new AbortController();
  const context: CallContext = { requestId: "r", connectionId: "c", signal: signal.signal };
  const who: Principal = {
    userId: "person-a", role: "owner", kind: "person", tokenId: "fixture-caller",
    ...(name === "bound" ? { binding: { audience, agentId: "a" } } : {}),
  };
  const deliveries: unknown[] = [], memory: unknown[] = [], requests: unknown[] = [];
  let wakeProducer = () => {};
  const producerReady = new Promise<void>(resolve => { wakeProducer = resolve; });
  const marked = (req: ChatRequest) => {
    requests.push({ agentId: req.agentId, sessionId: req.sessionId, turnId: req.turnId,
      principal: req.principal, person: req.authenticatedPerson, memory: req.memory, messages: req.messages });
  };
  const provider: ChatProvider = {
    id: "fixture",
    async *stream(req) {
      marked(req);
      if (name === "provider failure") throw new Error("fixture provider failure");
      yield { type: "delta", text: "Hello " };
      if (name === "cancel" || name === "busy") {
        wakeProducer();
        await new Promise<void>(resolve => {
          if (req.signal.aborted) resolve();
          else req.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }
      yield { type: "delta", text: "fixture" };
      yield { type: "usage", inputTokens: 10, outputTokens: 4 };
    },
  };
  const service = createExternalTurnService({
    store,
    agents: { has: (id: string) => ["a", "b"].includes(id), workspaceOf: (id: string) => ["a", "b"].includes(id) ? "/fixture/" + id : null } as never,
    provider: () => name === "unavailable" ? null : provider,
    externalMemory: {
      async recall(turn, query) {
        memory.push(["recall", turn.channel, turn.agentId, turn.sessionId, turn.turnId, turn.principal?.userId, query]);
        return "scoped fixture memory";
      },
      capture(turn, exchange) {
        memory.push(["capture", turn.channel, turn.agentId, turn.sessionId, turn.turnId, turn.principal?.userId, exchange]);
      },
      async idle() {},
    },
    now: () => now,
    notify: event => { deliveries.push([event.type, event.seq]); },
  });
  const methods = guardMethods(service.methods, { resolve: () => who, now: () => now });
  const call = async (method: string, input: object) => {
    try { return await methods["external.turn." + method]!(input, context); }
    catch (error) {
      if (!(error instanceof RpcError)) throw error;
      return { error: error.error, reason: error.reason ?? null };
    }
  };
  const base = { audience, tokenId: "fixture-caller" };
  try {
    const startArgs = { ...base, agentId: name === "unknown agent" ? "missing" : "a",
      message: name === "empty" ? "  " : "  fixture question  ", wait: name !== "cancel" && name !== "busy" };
    const first = await call("start", startArgs);
    const ops: unknown[] = [{ method: "start", input: startArgs, result: first }];
    if (!first || typeof first !== "object" || !("sessionId" in first)) {
      return { name, audience, ops, deliveries, requests, memory };
    }
    const { sessionId, turnId } = first as Started;
    const follow = async (method: string, input: object) => {
      const result = await call(method, input); ops.push({ method, input, result });
    };
    if (name === "cancel" || name === "busy") {
      await producerReady;
      if (name === "busy") await follow("start", { ...base, sessionId, agentId: "a", message: "next queued request" });
      await follow("cancel", { ...base, turnId, agentId: "a" });
      await service.idle();
    } else if (name === "rewind") {
      now = 10_010;
      store.rewindPath(sessionId, { toSeq: 0, lesson: "Keep the reply concise.", actor: "person-a", trigger: "user" });
      ops.push({ method: "rewind", input: { sessionId, now } });
      await follow("start", { ...base, sessionId, agentId: "a", message: "next request", wait: true });
    }
    await follow("events", { ...base, sessionId, agentId: "a", afterSeq: 0, limit: 100 });
    await follow("get", { sessionId, agentId: "a", messages: 2 });
    await follow("cancel", { ...base, sessionId, agentId: "a" });
    return { name, audience, ops, deliveries, requests, memory,
      ...(requests.length ? { ownerDivergence: "K6-D25" } : {}), ...(name === "provider failure" ? {
      divergence: "fixed-provider-error",
    } : {}) };
  } finally { await service.idle(); store.close(); }
}

export async function buildExternalTurnVectors() {
  return { turn: await Promise.all([
    scenario("mcp", "mcp"), scenario("bound", "a2a"), scenario("rewind", "mcp"),
    scenario("cancel", "a2a"), scenario("busy", "mcp"), scenario("provider failure", "mcp"),
    scenario("unknown agent", "mcp"), scenario("empty", "mcp"), scenario("unavailable", "mcp"),
  ]) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "external-turn", build: buildExternalTurnVectors });
}
