import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults } from "@plur1bus/config-schema";
import { runWithAgentScope, scopeFor } from "../../src/agents/scope.ts";
import { engineTurnMemory } from "../../src/session/memory-port.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { tempDir } from "../helpers/temp-dir.ts";

// The fake engine reads like the real one's ACL (acl-middleware.js checkAccess): the agent-private and workspace scopes
// answer to the agent and its workspace, the user scope only to a principal that carries `user`.
function fixture() {
  const recalls: { user: string | undefined; trust: string }[] = [];
  const captures: { user: string | undefined; sessionKey: string | undefined; runId: string | undefined; messages: { role: string; content: string }[] }[] = [];
  const engine: any = {
    async recall({ principal }: any) {
      recalls.push({ user: principal.user, trust: principal.trust });
      const blocks = [{ name: "agent-private", text: "MARK-AGENT-PRIVATE", droppable: false }, { name: "workspace", text: "MARK-WORKSPACE", droppable: false }];
      if (principal.user) blocks.push({ name: "user", text: `MARK-USER:${principal.user.slice(0, 12)}`, droppable: false });
      return { blocks: blocks.map(b => ({ ...b, chars: b.text.length })), capChars: Infinity, degraded: null };
    },
    capture({ principal, sessionKey, runId, messages }: any) { captures.push({ user: principal.user, sessionKey, runId, messages }); return { id: "capture", done: Promise.resolve({ stored: 1, skipped: 0 }) }; },
  };
  const logs: { msg: string; fields: any }[] = [];
  const logger: any = { info: (msg: string, fields: any) => logs.push({ msg, fields }), warn: (msg: string, fields: any) => logs.push({ msg, fields }) };
  const memory = engineTurnMemory({ engine, config: defaults, agents: { workspaceOf: () => tempDir("port-scopes-"), has: () => true } as any, logger, captureSignal: new AbortController().signal, isStopping: () => false });
  const run = <T>(fn: () => Promise<T>) => runWithAgentScope(scopeFor("main", "agents/main"), fn);
  const base = { agentId: "main", caller: { channel: "cli" as const, accountId: "collab", userId: "alice" }, authenticatedPerson: "alice", query: "q", signal: new AbortController().signal };
  return { memory, recalls, captures, logs, run, base };
}
const ALL = { workspace: true, user: true, agentPrivate: true };

test("without scopes the recall is unchanged: every scope the engine reads comes back", async () => {
  const f = fixture();
  const r = await f.run(() => f.memory.recall(f.base));
  assert.match(r.text, /MARK-AGENT-PRIVATE/); assert.match(r.text, /MARK-WORKSPACE/); assert.match(r.text, /MARK-USER:/);
});

test("scopes with everything on read all three scopes for the named person", async () => {
  const f = fixture();
  const r = await f.run(() => f.memory.recall({ ...f.base, scopes: ALL }));
  assert.match(r.text, /MARK-USER:/);
  assert.equal(f.recalls[0]!.user, deriveUserPrincipal("alice"));
});

test("user off: the principal goes to the engine without `user`, the other scopes are still read", async () => {
  const f = fixture();
  const r = await f.run(() => f.memory.recall({ ...f.base, scopes: { ...ALL, user: false } }));
  assert.equal(f.recalls.length, 1);
  assert.equal(f.recalls[0]!.user, undefined);
  assert.doesNotMatch(r.text, /MARK-USER/);
  assert.match(r.text, /MARK-WORKSPACE/); assert.match(r.text, /MARK-AGENT-PRIVATE/);
});

test("workspace or agent-private off: the engine cannot exclude them, so it is not asked at all", async () => {
  for (const scope of ["workspace", "agentPrivate"] as const) {
    const f = fixture();
    const r = await f.run(() => f.memory.recall({ ...f.base, scopes: { ...ALL, [scope]: false } }));
    assert.equal(f.recalls.length, 0, scope);
    assert.equal(r.text, "");
    assert.equal(r.degraded?.reason, "scope-not-enforceable");
    assert.equal(r.degraded?.capability, "recall");
  }
});

test("a capture carries the session key, the run id and the provenance in the log", async () => {
  const f = fixture();
  await f.run(() => f.memory.capture({ agentId: "main", caller: f.base.caller, authenticatedPerson: "alice", sessionId: "s-1", turnId: "t-1", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }], incognito: false, provenance: { origin: "collab", fromAgent: "asker" } }));
  assert.deepEqual(f.captures.map(c => [c.user, c.sessionKey, c.runId]), [[deriveUserPrincipal("alice"), "session:s-1", "t-1"]]);
  const done = f.logs.find(l => l.msg === "session capture done");
  assert.equal(done?.fields.origin, "collab"); assert.equal(done?.fields.fromAgent, "asker");
});
