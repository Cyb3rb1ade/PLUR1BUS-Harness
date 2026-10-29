// Wires external ACP agents into composition. index.ts calls this once and spreads externalSubject into policyContext.
import { join } from "node:path";
import type { ApprovalService } from "../approvals/service.ts";
import type { ProjectWorktreePort } from "../collab/coding-surface.ts";
import { CollabStore } from "../collab/store.ts";
import type { DelegationTarget } from "../collab/target.ts";
import type { SubjectKind } from "../policy/decide.ts";
import { subjectForOrigin, type SessionOrigin } from "./protocols.ts";
import { provisionedWorktreePort } from "../external-agents/provisioner.ts";
import { ExternalDelegationTarget } from "../external-agents/delegation.ts";
import { readEngine, type ExternalEngineConfig } from "../external-agents/engine.ts";
import type { SessionStore } from "../session/store.ts";

type OriginLookup = (sessionId: string) => SessionOrigin | null | undefined;
let originOf: OriginLookup = () => undefined;

/** Test and composition hook. A missing origin leaves the dispatcher subject untouched. */
export function bindExternalOrigin(lookup: OriginLookup): void {
  originOf = lookup;
}

export function externalSubject(ctx: { sessionId?: string; agentId: string }): { subject?: { kind: SubjectKind; agentId: string } } {
  if (!ctx.sessionId) return {};
  let origin: SessionOrigin | null | undefined;
  try { origin = originOf(ctx.sessionId); } catch { return {}; }
  if (origin !== "mcp" && origin !== "a2a" && origin !== "acp-agent") return {};
  return { subject: { kind: subjectForOrigin(origin), agentId: ctx.agentId } };
}

export interface ExternalWireDeps {
  home: string;
  config(): { agents: Record<string, { engine?: Partial<ExternalEngineConfig> }> };
  agents: { workspaceOf(agentId: string): string | null | undefined };
  permissions: { open(): Promise<{ service: ApprovalService }>; current(): { service: ApprovalService } | null };
  logger: { info(event: string, fields?: Record<string, number | string>): void };
}

/** Fills delegation targets and the worktree port only when the caller has not. Session origin is read from the live store. */
export function wireExternalAgents(
  d: ExternalWireDeps,
  options: { delegationTargets?: readonly DelegationTarget[]; projectWorktrees?: ProjectWorktreePort },
  sessions: () => { store: SessionStore },
): void {
  bindExternalOrigin((id) => {
    try { return sessions().store.getSession(id)?.origin ?? null; } catch { return null; }
  });
  if (!options.projectWorktrees) {
    const path = join(d.home, "state", "collab.sqlite");
    let store: CollabStore | undefined;
    const open = () => (store ??= new CollabStore({ path }));
    options.projectWorktrees = {
      root: (agentId, projectId, cardId) => provisionedWorktreePort(open(), (id) => d.agents.workspaceOf(id) ?? null).root(agentId, projectId, cardId),
    };
  }
  if (!options.delegationTargets) {
    options.delegationTargets = [new ExternalDelegationTarget({
      engineOf: (id) => readEngine(d.config().agents[id]),
      worktreeOf: (agentId, projectId) => options.projectWorktrees!.root(agentId, projectId, ""),
      home: d.home,
      sessions: () => sessions().store,
      approvals: async () => d.permissions.current()?.service ?? (await d.permissions.open()).service,
      log: (event, fields) => d.logger.info(event, fields),
    })];
  }
}
