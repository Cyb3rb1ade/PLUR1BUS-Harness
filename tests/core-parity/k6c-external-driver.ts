import { DatabaseSync } from "node:sqlite";
import { createExternalTurnService } from "../../packages/core/src/external-turn/index.ts";
import { guardMethods } from "../../packages/core/src/rbac/guard.ts";
import type { CallContext } from "../../packages/core/src/rpc/server.ts";
import { SessionStore } from "../../packages/core/src/session/store.ts";

function schema(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: db.prepare("PRAGMA user_version").get()?.user_version,
      schema: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all(),
      integrity: db.prepare("PRAGMA integrity_check").get()?.integrity_check,
    };
  } finally { db.close(); }
}

async function fixture(mode: string, file: string, sessionId?: string) {
  let next = 0;
  const store = new SessionStore({ path: file, clock: () => 10_000, newId: prefix => prefix + "_ts" + ++next });
  const principal = { userId: "person-a", role: "owner", kind: "person", tokenId: "fixture-caller" } as const;
  const service = createExternalTurnService({
    store,
    agents: { workspaceOf: (agent: string) => agent === "a" ? "/fixture/a" : null } as never,
    provider: () => ({ id: "fixture", async *stream() { yield { type: "delta", text: "TS result" }; } }),
    externalMemory: { async recall() { return ""; }, capture() {}, async idle() {} },
  });
  const c = guardMethods(service.methods, { resolve: () => principal, now: () => 10_000 });
  const ctx: CallContext = { connectionId: "fixture", requestId: "fixture", signal: new AbortController().signal };
  const common = { agentId: "a", audience: "mcp", tokenId: "fixture-caller" };
  let outcome: unknown;
  try {
    if (mode === "seed") {
      outcome = await c["external.turn.start"]!({ ...common, message: "TS request", wait: true }, ctx);
    } else if (mode === "read-store" && sessionId) {
      outcome = { owner: store.getSession(sessionId)?.owner, messages: store.listMessages(sessionId) };
    } else { throw new Error("unknown fixture mode"); }
  } finally { await service.idle(); store.close(); }
  process.stdout.write(JSON.stringify({ outcome, ...schema(file) }) + "\n");
}

const [_node, _script, mode, file, sessionId] = process.argv;
if (!mode || !file) throw new Error("mode and fixture file are required");
await fixture(mode, file, sessionId);
