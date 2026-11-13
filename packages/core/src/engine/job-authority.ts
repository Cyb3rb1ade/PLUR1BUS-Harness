import type { Principal as EnginePrincipal } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { AgentRegistry } from "../agents.ts";
import type { GrantStore } from "../grants/store.ts";
import { deriveUserPrincipal } from "../identity/principals.ts";
import type { IdentityService, Link } from "../identity/service.ts";
import { decide } from "../policy/decide.ts";
import { callerToPrincipal } from "../principal.ts";
import { authorize } from "../rbac/authorize.ts";
import type { Principal } from "../rbac/types.ts";

const JOB_CAPABILITY = "memory.jobs.run";

/** Resolve exactly one owner's active, self-issued standing grant at job admission. */
export function resolveEngineJobAuthority(
  deps: { agents: Pick<AgentRegistry, "workspaceOf">; resolvePerson: (id: string) => Principal | null; identity: Pick<IdentityService, "jobLink">; grants: GrantStore; now: number },
  agentId: string,
  job: string,
  dryRun: boolean,
): EnginePrincipal | null {
  const workspace = deps.agents.workspaceOf(agentId);
  if (!workspace) return null;
  const jobId = `engine:${job}`;
  let match: { person: string; grantId: string; link: Link } | undefined;
  for (const { grant, state } of deps.grants.inspect({ agent: agentId })) {
    if (state !== "active" || grant.capability !== JOB_CAPABILITY || grant.jobId !== jobId
      || grant.scope !== "always" || grant.match.kind !== "capability" || grant.createdBy !== grant.person
      || grant.delegable === true || grant.taskId !== undefined || grant.sessionId !== undefined || grant.projectId !== undefined) continue;

    const person = deps.resolvePerson(grant.person);
    const memory = { kind: "memory", scope: "agent-private", agentId } as const;
    if (person?.kind !== "person" || person.userId !== grant.person
      || authorize(person, "agent.use", { kind: "agent", agentId }).effect !== "allow"
      || authorize(person, "memory.agent-private.read", memory).effect !== "allow"
      || authorize(person, "memory.agent-private.write", memory).effect !== "allow") continue;

    const decision = decide(
      { capability: JOB_CAPABILITY, tool: jobId, flags: { outsideRoots: false, denyListHit: false }, actionHash: jobId },
      { principal: { person: person.userId }, subject: { kind: "agent", agentId }, surface: 0, headless: { jobId } },
      { clock: { now: () => deps.now }, grants: { list: () => [grant], get: () => undefined, maxGrantDays: deps.grants.maxGrantDays } },
    );
    if (decision.kind !== "allow" || decision.via !== "grant") continue;
    const link = deps.identity.jobLink(person.userId);
    if (!link || link.humanId !== person.userId || link.revokedAt !== null) continue;
    if (match && match.person !== person.userId) return null;
    match ??= { person: person.userId, grantId: grant.id, link };
  }
  if (!match) return null;
  const { person, grantId, link } = match;
  const { principal, degraded } = callerToPrincipal({ channel: "cli", accountId: link.accountId, userId: link.userId }, agentId, workspace);
  if (degraded) return null;
  principal.user = deriveUserPrincipal(person);
  principal.channel = link.channel;
  principal.chat = { id: "", kind: "direct" };
  if (!dryRun) deps.grants.markUsed(grantId);
  return principal;
}
