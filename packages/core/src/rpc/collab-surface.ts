import type { Handler } from "./server.ts";
import { RpcError } from "./errors.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import type { Principal, ProjectRight } from "../rbac/types.ts";
import { authorize } from "../rbac/authorize.ts";
import type { Collab } from "../collab/service.ts";
import { surfaceError } from "./surface-errors.ts";

export function buildCollabSurface(
  service: () => Collab | null,
  hasAgent?: (id: string) => boolean,
): Record<string, Handler> {
  const bind =
    (fn: (s: Collab, p: any, a: Principal) => unknown): Handler =>
    async (p, ctx) => {
      const a = authenticatedPrincipal(ctx);
      const s = service();
      if (!s)
        throw new RpcError("E_NOT_AVAILABLE", "collaboration unavailable");
      try {
        // Membership comes from persisted projects, not caller-supplied object rights.
        const projectRights: Record<string, ProjectRight> = {};
        for (const project of s.listProjects(a)) {
          const membership = project.members.find(
            (member) => member.userId === a.userId,
          );
          if (membership) projectRights[project.id] = membership.role;
        }
        return fn(s, p, { ...a, projectRights });
      } catch (e) {
        return surfaceError(e);
      }
    };
  const read = (s: Collab, a: Principal, id: string) => {
    const project = s.getProject(a, id);
    if (
      !["owner", "admin", "operator"].includes(a.role) &&
      !project.members.some((m) => m.userId === a.userId)
    )
      throw new RpcError("E_DENIED", "project membership required");
    return project;
  };
  const trace = (s: Collab, a: Principal, id: string) => {
    const t = s.getTrace(a, id);
    read(s, a, t.projectId);
    return t;
  };
  return {
    "project.create": bind((s, p, a) => s.createProject(a, { name: p.name })),
    "project.get": bind((s, p, a) => read(s, a, p.projectId)),
    "project.list": bind((s, _p, a) => ({
      projects: s
        .listProjects(a)
        .filter(
          (project) =>
            ["owner", "admin", "operator"].includes(a.role) ||
            project.members.some((m) => m.userId === a.userId),
        ),
    })),
    "project.update": bind((s, p, a) =>
      s.updateProject(a, p.projectId, p.name),
    ),
    "project.archive": bind((s, p, a) => s.archiveProject(a, p.projectId)),
    "project.member.add": bind((s, p, a) => {
      const project = read(s, a, p.projectId);
      if (project.owner === p.userId && p.role !== "lead")
        throw new RpcError("E_CONFLICT", "owner must remain lead");
      return s.addMember(a, p.projectId, p.userId, p.role);
    }),
    "project.member.remove": bind((s, p, a) =>
      s.removeMember(a, p.projectId, p.userId),
    ),
    "project.member.role": bind((s, p, a) => {
      const project = read(s, a, p.projectId);
      const member = project.members.find((m) => m.userId === p.userId);
      if (!member) throw new RpcError("E_NOT_FOUND", "member not found");
      if (member.userId === project.owner && p.role !== "lead")
        throw new RpcError("E_CONFLICT", "owner must remain lead");
      return s.addMember(a, p.projectId, p.userId, p.role);
    }),
    "project.agent.add": bind((s, p, a) => {
      if (hasAgent && !hasAgent(p.agentId))
        throw new RpcError("E_AGENT_UNKNOWN", "unknown project agent");
      if (
        authorize(a, "agent.use", { kind: "agent", agentId: p.agentId })
          .effect !== "allow"
      )
        throw new RpcError("E_DENIED", "agent use required");
      return s.addAgent(a, p.projectId, p.agentId);
    }),
    "project.agent.remove": bind((s, p, a) =>
      s.removeAgent(a, p.projectId, p.agentId),
    ),
    "collab.trace.get": bind((s, p, a) => trace(s, a, p.traceId)),
    "collab.trace.list": bind((s, p, a) => {
      read(s, a, p.projectId);
      return { traces: s.listTraces(a, p.projectId) };
    }),
    "collab.chain.cancel": bind((s, p, a) => {
      trace(s, a, p.traceId);
      s.cancelChain(a, p.traceId);
      return { cancelled: true };
    }),
  };
}
