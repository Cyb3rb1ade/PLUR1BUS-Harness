import type { Principal as EnginePrincipal } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { engineJobScope, SCHEMA } from "@plur1bus/rpc-schema";
import type { AgentRegistry } from "../agents.ts";
import { AUTO_JOB_ISSUER, type GrantStore } from "../grants/store.ts";
import { deriveUserPrincipal } from "../identity/principals.ts";
import type { IdentityService } from "../identity/service.ts";
import { decide, grantExpiry } from "../policy/decide.ts";
import { callerToPrincipal } from "../principal.ts";
import { authorize } from "../rbac/authorize.ts";
import type { Principal } from "../rbac/types.ts";

const JOB_CAPABILITY = "memory.jobs.run";
const CATALOG = new Set((SCHEMA.$defs as { EngineContractJobNameData: { enum: string[] } }).EngineContractJobNameData.enum);
interface Dependencies {
  agents: Pick<AgentRegistry, "workspaceOf">;
  ownerOf(agentId: string): string | undefined;
  resolvePerson(id: string): Principal | null;
  identity: Pick<IdentityService, "jobLink">;
  grants: GrantStore;
  now: number;
}

export function canRunOwnJobs(person: Principal | null, agentId: string): person is Principal {
  return person?.kind === "person" && authorize(person, "agent.use", { kind: "agent", agentId }).effect === "allow";
}

/** Only the capability can authorize a partition. Grants do not change another person's permissions. */
export function resolveEngineJobAuthorities(deps: Dependencies, agentId: string, job: string): EnginePrincipal[] {
  const workspace = deps.agents.workspaceOf(agentId);
  const owner = deps.ownerOf(agentId);
  if (!workspace || !owner || !CATALOG.has(job)) return [];
  const jobId = `engine:${job}`;
  const eachPerson = engineJobScope(job) === "each-person";
  const admitted = new Map<string, EnginePrincipal>();
  for (const { grant, state } of deps.grants.inspect({ agent: agentId })) {
    if (admitted.has(grant.person) || state !== "active" || grant.capability !== JOB_CAPABILITY
      || (grant.jobId !== jobId && grant.jobId !== "engine:*")
      || (!eachPerson && grant.person !== owner)
      || grant.scope !== "always" || grant.match.kind !== "capability"
      || grant.delegable === true || grant.taskId !== undefined || grant.sessionId !== undefined || grant.projectId !== undefined) continue;

    const automatic = grant.origin === "auto-agent-owner" && grant.createdBy === AUTO_JOB_ISSUER
      && grant.jobId === "engine:*" && grant.person === owner;
    if (!automatic && grant.createdBy !== grant.person) continue;
    const person = deps.resolvePerson(grant.person);
    if (!canRunOwnJobs(person, agentId) || person.userId !== grant.person) continue;

    const decision = decide(
      { capability: JOB_CAPABILITY, tool: jobId, flags: { outsideRoots: false, denyListHit: false }, actionHash: jobId },
      { principal: { person: person.userId }, subject: { kind: "agent", agentId }, surface: 0, headless: { jobId } },
      { clock: { now: () => deps.now }, grants: { list: () => [grant], get: () => undefined, maxGrantDays: deps.grants.maxGrantDays } },
    );
    if (decision.kind !== "allow" || decision.via !== "grant") continue;
    const link = deps.identity.jobLink(person.userId);
    const linked = link?.humanId === person.userId && link.revokedAt === null ? link : null;
    const { principal, degraded } = callerToPrincipal({
      channel: "cli", accountId: linked?.accountId ?? "local", userId: linked?.userId ?? person.userId,
    }, agentId, workspace);
    if (degraded) continue;
    principal.user = deriveUserPrincipal(person.userId);
    principal.channel = linked?.channel ?? "cli";
    principal.chat = { id: "", kind: "direct" };
    admitted.set(person.userId, principal);
  }
  const order = [...admitted.keys()].filter(person => person !== owner).sort();
  if (admitted.has(owner)) order.unshift(owner);
  return order.slice(0, 64).map(person => admitted.get(person)!);
}

export function engineJobGrantStatus(grants: GrantStore | undefined, person: string, agentId: string, now: number) {
  const rows = grants?.inspect({ person, agent: agentId }).filter(({ grant }) => grant.capability === JOB_CAPABILITY) ?? [];
  const active = rows.filter(({ grant, state }) => state === "active" && grant.createdAt <= now && now < grantExpiry(grant, grants!.maxGrantDays()));
  const renewed = Math.max(...active.map(({ grant }) => grant.lastJobTurnAt ?? grant.createdAt));
  const state = active.length > 0 ? "active" as const
    : rows.some(({ grant, state }) => state === "revoked" && grant.jobId === "engine:*") ? "revoked" as const
    : rows.some(({ state }) => state === "active") ? "expired" as const : "never-issued" as const;
  return { agentId, state, ...(Number.isFinite(renewed) ? { lastRenewedAt: new Date(renewed).toISOString() } : {}) };
}

/** Legacy reverse method has the original single-principal response shape. */
export function resolveEngineJobAuthority(deps: Dependencies, agentId: string, job: string, _dryRun: boolean): EnginePrincipal | null {
  const principals = resolveEngineJobAuthorities(deps, agentId, job);
  return principals.length === 1 ? principals[0]! : null;
}
