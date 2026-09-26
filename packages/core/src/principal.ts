import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { AgentContext, Degraded, Principal, UserPrincipal } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { CallerIdentity } from "@plur1bus/rpc-schema";

export const AGENT_CONTEXT_CLI: AgentContext = Object.freeze({ origin: "user", background: false });

const MAX_IDENTITY = 128; // INPUT_LIMITS.ACCOUNT_ID / USER_ID in the engine's lib/input-limits.js
const CONTROL = /[\u0000-\u001f\u007f]/;

function validIdentity(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_IDENTITY && !CONTROL.test(v);
}

/** Exactly lib/memory-request-context.js:332-334: sha256 over JSON.stringify([channel, accountId, userId]). */
export function userPrincipalHash(c: CallerIdentity): UserPrincipal {
  return `user:v1:${createHash("sha256").update(JSON.stringify([c.channel, c.accountId, c.userId]), "utf8").digest("hex")}`;
}

export function callerToPrincipal(c: CallerIdentity, agentId: string, workspaceDir: string): { principal: Principal; degraded: Degraded | null } {
  // Must canonicalize exactly like the engine (lib/memory-request-context.js uses fs.realpathSync, the JS
  // variant). realpathSync.native differs on Windows (C:\Windows\Temp vs C:\WINDOWS\TEMP, 8.3 names), and the
  // engine then rejects every capture with "conflicting workspace identity".
  const workspace = `workspace-dir:v1:${realpathSync(workspaceDir)}` as const;
  const problems: string[] = [];
  if (c.channel !== "cli") problems.push("channel");
  if (!validIdentity(c.accountId)) problems.push("accountId");
  if (!validIdentity(c.userId)) problems.push("userId");
  if (problems.length) {
    return {
      principal: { agentId, workspace, channel: "cli", accountId: "", chat: { id: "", kind: "direct" }, trust: "inferred" },
      degraded: { reason: "principal-invalid", capability: "identity", detail: `invalid ${problems.join(", ")}` },
    };
  }
  return {
    principal: { agentId, workspace, user: userPrincipalHash(c), channel: "cli", accountId: c.accountId, chat: { id: `cli:${c.userId}`, kind: "direct" }, trust: "proved" },
    degraded: null,
  };
}
