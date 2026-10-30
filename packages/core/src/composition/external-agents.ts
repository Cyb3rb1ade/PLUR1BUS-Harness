// Wires ACP into the shared session-origin and collaboration store lifetime.
import { join } from "node:path";
import type { ApprovalService } from "../approvals/service.ts";
import type { ProjectWorktreePort } from "../collab/coding-surface.ts";
import { CollabStore } from "../collab/store.ts";
import type { DelegationTarget } from "../collab/target.ts";
import { DEFAULT_MAX_TASKS } from "../tools/sandbox/types.ts";
import { AcpWorktreeMount } from "../tools/sandbox/acp-worktree.ts";
import { provisionedWorktreePort } from "../external-agents/provisioner.ts";
import { ExternalDelegationTarget, type ExternalTargetDeps } from "../external-agents/delegation.ts";
import { readEngine, type ExternalEngineConfig } from "../external-agents/engine.ts";
import type { SessionStore } from "../session/store.ts";

export interface ExternalWireDeps {
  home: string;
  config(): { tools?: { sandbox?: { maxTasks?: number } }; agents: Record<string, { engine?: Partial<ExternalEngineConfig>; behaviour?: { default?: { tools?: { deny?: string[] }; capabilities?: { deny?: string[] } } } }> };
  agents: { workspaceOf(agentId: string): string | null | undefined };
  permissions: { open(): Promise<{ service: ApprovalService }>; current(): { service: ApprovalService } | null };
  logger: { info(event: string, fields?: Record<string, number | string>): void };
}

/** Fills delegation targets and the worktree port only when the caller has not. Session origin is read from the live store. */
export function wireExternalAgents(
  d: ExternalWireDeps,
  options: { delegationTargets?: readonly DelegationTarget[]; projectWorktrees?: ProjectWorktreePort },
  sessions: () => { store: SessionStore },
  collabStore: () => CollabStore,
  makeTarget: (deps: ExternalTargetDeps) => DelegationTarget = deps => new ExternalDelegationTarget(deps),
): void {
  if (!options.projectWorktrees) {
    options.projectWorktrees = { root: (agentId, projectId, cardId) =>
      provisionedWorktreePort(collabStore(), id => d.agents.workspaceOf(id) ?? null, join(d.home, "state"))
        .root(agentId, projectId, cardId) };
  }
  if (!options.delegationTargets) {
    options.delegationTargets = [makeTarget({
      engineOf: (id) => readEngine(d.config().agents[id]),
      policyContext: id => {
        const policy = d.config().agents[id]?.behaviour?.default;
        return { toolsDeny: [...(policy?.tools?.deny ?? []), ...(policy?.capabilities?.deny ?? [])] };
      },
      worktreeOf: (agentId, projectId, cardId) => options.projectWorktrees!.root(agentId, projectId, cardId ?? ""),
      mountOf: (projectId, cardId) => AcpWorktreeMount.fromStore(collabStore(), join(d.home, "state"), projectId, cardId ?? null),
      home: d.home,
      maxTasks: () => d.config().tools?.sandbox?.maxTasks ?? DEFAULT_MAX_TASKS,
      sessions: () => sessions().store,
      approvals: async () => d.permissions.current()?.service ?? (await d.permissions.open()).service,
      log: (event, fields) => d.logger.info(event, fields),
    })];
  }
}
