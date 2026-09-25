import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
// The only lib import in the harness: proves the harness hash equals the engine's, forever.
import { resolveMemoryRequestContext } from "@cyb3rb1ade/plur1bus-memory/lib/memory-request-context.js";
import { AGENT_CONTEXT_CLI, callerToPrincipal, userPrincipalHash } from "../src/principal.ts";

describe("principal", () => {
  const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };
  it("derives the same user principal as the engine's own resolver", () => {
    const ws = mkdtempSync(join(tmpdir(), "p1b-ws-"));
    const lib = resolveMemoryRequestContext({ agentId: "bernd", workspaceDir: ws, channel: "cli", accountId: "macbooker", userId: "cyberblade" });
    assert.equal(userPrincipalHash(caller), lib.userPrincipal);
    const { principal, degraded } = callerToPrincipal(caller, "bernd", ws);
    assert.equal(degraded, null);
    assert.equal(principal.user, lib.userPrincipal);
    assert.equal(principal.workspace, `workspace-dir:v1:${realpathSync.native(ws)}`);
    assert.equal(principal.workspace, lib.workspaceIdentity);
    assert.deepEqual({ trust: principal.trust, channel: principal.channel, accountId: principal.accountId, chat: principal.chat }, { trust: "proved", channel: "cli", accountId: "macbooker", chat: { id: "cli:cyberblade", kind: "direct" } });
    assert.deepEqual(AGENT_CONTEXT_CLI, { origin: "user", background: false });
  });
  it("an invalid caller identity degrades to inferred and says so", () => {
    const ws = mkdtempSync(join(tmpdir(), "p1b-ws-"));
    const bad = callerToPrincipal({ channel: "cli", accountId: "host\u0000name", userId: "u" }, "bernd", ws);
    assert.equal(bad.principal.trust, "inferred");
    assert.equal(bad.principal.user, undefined);
    assert.deepEqual({ reason: bad.degraded?.reason, capability: bad.degraded?.capability }, { reason: "principal-invalid", capability: "identity" });
    const long = callerToPrincipal({ channel: "cli", accountId: "h", userId: "u".repeat(129) }, "bernd", ws);
    assert.equal(long.principal.trust, "inferred");
  });
});
