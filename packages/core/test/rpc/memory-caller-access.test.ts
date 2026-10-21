// memory ops act as the engine principal derived from `params.caller`: the caller must belong to the authenticated person.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdentityService } from "../../src/identity/service.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { userPrincipalHash, validIdentity } from "../../src/principal.ts";
import { guardMethods, LOCAL_OWNER, RPC_RULES } from "../../src/rbac/guard.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import { memoryCallerAccess, CALLER_BOUND_MEMORY_METHODS } from "../../src/rpc/memory-caller-access.ts";

const context = () => ({ requestId: "offline", connectionId: "offline", signal: new AbortController().signal });
const actor = { user: "owner", host: "offline", role: "owner" as const, kind: "person" as const };
const extra: Record<string, object> = {
  "memory.forget": { id: "m-1" }, "memory.correct": { id: "m-1", text: "fixed" }, "memory.share": { id: "m-1", target: "user" }, "memory.state": {},
  "memory.propose": { sharedId: "m-2", text: "fixed" }, "memory.proposals.list": {}, "memory.proposals.accept": { proposalId: "p-1" }, "memory.proposals.reject": { proposalId: "p-1" },
};
const victim = { channel: "cli" as const, accountId: "macbooker", userId: "victim" };
const mine = { channel: "cli" as const, accountId: "macbooker", userId: "member" };

function fixture(t: { after: (f: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "memory-caller-"));
  const identity = createIdentityService({ dbPath: join(root, "identity.sqlite"), clock: () => 100_000, audit: () => {} });
  t.after(() => { identity.close(); rmSync(root, { recursive: true, force: true }); });
  const member = identity.createHuman({ displayName: "Member" }, actor);
  const other = identity.createHuman({ displayName: "Victim" }, actor);
  identity.link({ humanId: member.id, identity: { channel: "cli", accountId: mine.accountId, userId: mine.userId } }, actor);
  identity.link({ humanId: other.id, identity: { channel: "cli", accountId: victim.accountId, userId: victim.userId } }, actor);
  // The same derivation as the composition root's `ownership` in core.ts.
  const ownership = (a: Principal, params?: unknown): string[] => {
    const canonical = deriveUserPrincipal(a.userId);
    let linked: string[] = []; try { linked = identity.resolvePrincipals(canonical); } catch { /* bootstrap owner has no identity row */ }
    const caller = (params as { caller?: { channel: string; accountId: string; userId: string } } | undefined)?.caller;
    if (caller && (caller.channel !== "cli" || !validIdentity(caller.userId) || !validIdentity(caller.accountId))) throw new RpcError("E_DENIED", "caller identity is not valid", { reason: "principal-invalid" });
    return [...new Set([canonical, ...linked, ...(a.userId === LOCAL_OWNER.userId && caller?.channel === "cli" ? [userPrincipalHash(caller as typeof mine)] : [])])];
  };
  const seen: { method: string; caller: unknown }[] = [];
  const raw = Object.fromEntries(Object.keys(extra).map(m => [m, async (p: any) => { seen.push({ method: m, caller: p.caller }); return { ok: true }; }]));
  let who: Principal = { userId: member.id, role: "member", kind: "person", agentRights: { alpha: "use" } };
  const wrapped = memoryCallerAccess({ methods: raw, ownership, resolve: () => who });
  const methods = guardMethods({ ...raw, ...wrapped }, { resolve: () => who, now: () => 100_000 });
  return { methods, seen, member, other, set: (p: Principal) => { who = p; } };
}

test("a Member cannot act on another person's cards by naming that person's caller (memory.forget and every other caller-taking op)", async t => {
  const f = fixture(t);
  assert.ok("memory.forget" in RPC_RULES, "memory.forget stays behind the agent.use guard");
  for (const [m, p] of Object.entries(extra)) {
    await assert.rejects(f.methods[m]!({ agentId: "alpha", caller: victim, ...p }, context()), (e: any) => e instanceof RpcError && e.error === "E_DENIED" && e.reason === "caller-not-linked", m);
  }
  assert.deepEqual(f.seen, [], "no foreign caller reached the memory op");
});

test("a Member's own linked caller still reaches every memory op", async t => {
  const f = fixture(t);
  for (const [m, p] of Object.entries(extra)) await f.methods[m]!({ agentId: "alpha", caller: mine, ...p }, context());
  assert.deepEqual(f.seen.map(s => s.method), Object.keys(extra));
});

test("the installation owner (local token) keeps its OS caller; a person-Owner is bound like anyone else", async t => {
  const f = fixture(t);
  f.set(LOCAL_OWNER);
  await f.methods["memory.forget"]!({ agentId: "alpha", caller: { channel: "cli", accountId: "offline", userId: "cyberblade" }, id: "m-1" }, context());
  f.set({ userId: f.member.id, role: "owner", kind: "person" });
  await assert.rejects(f.methods["memory.forget"]!({ agentId: "alpha", caller: victim, id: "m-1" }, context()), (e: any) => e.reason === "caller-not-linked");
  await f.methods["memory.forget"]!({ agentId: "alpha", caller: mine, id: "m-1" }, context());
});

test("an invalid caller identity is passed on untouched: the op itself degrades reads and refuses writes (no user principal is derived)", async t => {
  const f = fixture(t);
  const bad = { ...mine, userId: "u".repeat(129) };
  await f.methods["memory.forget"]!({ agentId: "alpha", caller: bad, id: "m-1" }, context());
  assert.equal(f.seen.length, 1);
});

test("the wrapper covers exactly the caller-taking memory ops that memory.list/show (break-glass wrapper) do not", () => {
  assert.deepEqual([...CALLER_BOUND_MEMORY_METHODS].sort(), Object.keys(extra).sort());
});
