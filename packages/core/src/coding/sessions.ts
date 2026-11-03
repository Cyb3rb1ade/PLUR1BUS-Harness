/** CLI-1 human worktree binding. Uses the existing session writer, D115 board and D109 grant evaluator. */
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { CallerIdentity, CodeSessionModeParams } from "@plur1bus/rpc-schema";
import type { AgentRegistry } from "../agents.ts";
import type { Collab } from "../collab/service.ts";
import type { ProjectWorktreePort } from "../collab/coding-surface.ts";
import { requireAgent } from "../memory-ops.ts";
import { deriveUserPrincipal } from "../identity/principals.ts";
import { decide, type GrantSource } from "../policy/decide.ts";
import type { DenyEntry, PathRoot } from "../policy/paths-index.ts";
import { authorize } from "../rbac/authorize.ts";
import type { AuditSink } from "../rbac/audit.ts";
import type { Principal } from "../rbac/types.ts";
import { RpcError } from "../rpc/errors.ts";
import { ownerOf, toWireSession } from "../session/methods.ts";
import type { TurnApprover } from "../session/provider.ts";
import type { SessionStore } from "../session/store.ts";
import type { MemoryMode, SessionRecord } from "../session/types.ts";
import { codingRoot } from "./root.ts";
import type { ApprovalView } from "../approvals/service.ts";
import type { CodeRootRequest } from "../approvals/code-root.ts";
import { codingGit, gitLine } from "./git.ts";

export interface CodeOpen {
  caller: CallerIdentity;
  agentId: string;
  root: string;
  sessionId?: string;
  projectId?: string;
  cardId?: string;
  memoryMode?: MemoryMode;
  interactive?: boolean;
}
interface CodeConnection {
  connectionId: string;
  surface: 0 | 1 | 2 | 3;
  signal?: AbortSignal;
}
interface CodingDeps {
  home: string;
  store(): SessionStore;
  storeFor(id: string): SessionStore;
  ephemeral(): SessionStore;
  agents: AgentRegistry;
  roots(agentId: string): readonly PathRoot[];
  codingAgent?: (agentId: string) => boolean;
  deny?: readonly DenyEntry[];
  grants: GrantSource;
  clock(): number;
  audit: AuditSink;
  project?: { collab: Collab; worktrees: ProjectWorktreePort };
  /** Legacy CLI ownership is accepted only after the core's existing identity-link check. */
  linkedCaller?: (person: Principal, caller: CallerIdentity) => boolean;
  resolvePerson?: (id: string) => Principal | null;
  endTask?: (id: string) => void;
  endSession?: (id: string) => void;
  onCleanupError?: (error: unknown) => void;
  requestFolder?: (input: CodeRootRequest) => ApprovalView;
  folderRequest?: (id: string, person: string) => ApprovalView | undefined;
  cancelFolder?: (id: string, person: string) => void;
}

interface CodePresence {
  connectionId: string;
  sessionId: string;
  person: string;
  interactive: boolean;
  taskId: string;
  approvalId?: string;
  approvalRoot?: string;
  mode?: "chat" | "coding";
}
const MAX_CODE_PRESENCES = 1024;
const presenceKey = (connectionId: string, sessionId: string): string => JSON.stringify([connectionId, sessionId]);

/** One human coding binding service, shared by CLI and ACP; no filesystem authority is cached in this object. */
export class CodingSessions {
  readonly #d: CodingDeps;
  readonly #presence = new Map<string, CodePresence>();
  readonly #ephemeralSessions = new Set<string>();

  constructor(deps: CodingDeps) {
    this.#d = deps;
  }

  /** Opening may return a Core-created D109 request; only approval.decide with OS confirmation creates its grants. */
  async open(p: CodeOpen, who: Principal, connection: CodeConnection) {
    this.#human(who, p.agentId);
    if (this.#d.linkedCaller && !this.#d.linkedCaller(who, p.caller)) {
      throw new RpcError("E_DENIED", "caller identity must be linked to the authenticated person");
    }
    if ((p.projectId === undefined) !== (p.cardId === undefined)) {
      throw new RpcError("E_INVALID_PARAMS", "projectId and cardId must be supplied together");
    }
    if (p.sessionId && p.projectId === undefined) {
      this.#owned(p.sessionId, who, p.caller);
      const bound = this.#d.storeFor(p.sessionId).worktree(p.sessionId);
      if (bound?.projectId && bound.cardId) p = { ...p, projectId: bound.projectId, cardId: bound.cardId };
    }
    const root = await codingRoot(p.root, this.#d.home, this.#d.roots(p.agentId), this.#d.deny);
    if (connection.signal?.aborted)
      throw new RpcError("E_APPROVAL_REQUIRED", "coding folder request was aborted", { reason: "aborted" });
    const project = p.projectId && p.cardId ? this.#card(who, p.agentId, p.projectId, p.cardId) : null;
    if (project && realpathSync.native(project.root) !== root.canonical) {
      throw new RpcError("E_DENIED", "coding root must equal the card's shared worktree", {
        reason: "card-root-mismatch",
      });
    }
    const target = p.sessionId
      ? this.#d.storeFor(p.sessionId)
      : p.memoryMode === "incognito"
        ? this.#d.ephemeral()
        : this.#d.store();
    const linked = project?.card.links
      .filter((link) => link.kind === "session")
      .map((link) => this.#d.storeFor(link.id).getSession(link.id))
      .filter((s): s is SessionRecord => !!s && s.archivedAt === null && s.kind === "card");
    if (linked && linked.length > 1) throw new RpcError("E_CONFLICT", "card has ambiguous active session bindings");
    const existing = p.sessionId ? this.#owned(p.sessionId, who, p.caller) : linked?.[0];
    if (existing) {
      this.#owned(existing.id, who, p.caller);
      if (
        existing.agentId !== p.agentId ||
        existing.archivedAt !== null ||
        (p.memoryMode && existing.memoryMode !== p.memoryMode)
      ) {
        throw new RpcError("E_CONFLICT", "session agent, memory mode or active state does not match");
      }
      if (
        (project
          ? existing.kind !== "card" || existing.scope !== p.projectId
          : existing.kind !== "direct" && existing.kind !== "acp") ||
        (linked?.[0] && linked[0].id !== existing.id)
      )
        throw new RpcError("E_CONFLICT", "card session binding does not match");
      const old = target.worktree(existing.id);
      if (
        old &&
        (old.root !== root.canonical || old.projectId !== (p.projectId ?? null) || old.cardId !== (p.cardId ?? null))
      ) {
        throw new RpcError("E_CONFLICT", "worktree binding is immutable");
      }
    }
    // No unbound session is created in a pipe/editor run merely to ask for permission nobody can give there.
    const mayAsk =
      p.interactive === true && p.caller.channel === "cli" && connection.surface >= 1 && existing?.kind !== "acp";
    if (!existing && !this.#granted(root, who.userId, p.agentId, "", p.projectId) && !mayAsk) {
      throw new RpcError("E_APPROVAL_REQUIRED", "folder is not a granted root; open it from an interactive local CLI", {
        reason: "root-not-granted",
      });
    }
    const session =
      existing ??
      target.createSession({
        kind: project ? "card" : "direct",
        agentId: p.agentId,
        owner: deriveUserPrincipal(who.userId),
        ...(p.projectId ? { scope: p.projectId } : {}),
        title: project?.card.title ?? "Coding",
        memoryMode: p.memoryMode ?? "remember",
      });
    if (session.memoryMode === "incognito") this.#ephemeralSessions.add(session.id);
    const key = presenceKey(connection.connectionId, session.id);
    if ([...this.#presence.values()].some(old => old.connectionId === connection.connectionId &&
      (old.person !== who.userId || (session.kind !== "acp" && old.sessionId !== session.id)))) {
      this.connectionClosed(connection.connectionId);
    }
    const mode: CodePresence = this.#presence.get(key) ?? {
      connectionId: connection.connectionId,
      sessionId: session.id,
      person: who.userId,
      interactive: p.interactive !== false,
      taskId: `code_${randomUUID()}`,
    };
    mode.interactive = p.interactive !== false;
    this.#presence.delete(key);
    this.#presence.set(key, mode);
    if (this.#presence.size > MAX_CODE_PRESENCES) this.#endPresence(this.#presence.keys().next().value!);
    if (!this.#granted(root, who.userId, session.agentId, session.id, p.projectId, mode.taskId)) {
      if (!mayAsk)
        throw new RpcError("E_APPROVAL_REQUIRED", "folder grant is missing or revoked", { reason: "root-not-granted" });
      let approval =
        mode.approvalId && mode.approvalRoot === root.canonical
          ? this.#d.folderRequest?.(mode.approvalId, who.userId)
          : undefined;
      if (approval?.status !== "pending") {
        if (!this.#d.requestFolder) throw new RpcError("E_NOT_AVAILABLE", "coding folder approval is unavailable");
        this.#cancelFolder(mode);
        try {
          approval = this.#d.requestFolder({
            root: root.canonical,
            person: who.userId,
            agentId: session.agentId,
            sessionId: session.id,
            surface: connection.surface,
            signal: connection.signal ?? new AbortController().signal,
            ...(p.projectId ? { projectId: p.projectId } : {}),
            sessionActive: () => {
              if (this.#presence.get(key) !== mode || connection.signal?.aborted) return false;
              const person = this.#d.resolvePerson ? this.#d.resolvePerson(who.userId) : who;
              if (!person) return false;
              this.#human(person, session.agentId);
              const current = this.#owned(session.id, person, p.caller);
              if (p.projectId && p.cardId) this.#card(person, session.agentId, p.projectId, p.cardId);
              return current.archivedAt === null && current.agentId === session.agentId;
            },
          });
        } catch {
          throw new RpcError("E_APPROVAL_REQUIRED", "coding folder permission request was refused or cancelled", {
            reason: "folder-request-refused",
          });
        }
        mode.approvalId = approval.id;
        mode.approvalRoot = root.canonical;
      }
      return {
        state: "grant-required" as const,
        session: toWireSession(session),
        root: root.canonical,
        grant: {
          path: root.canonical,
          recursive: true as const,
          capabilities: ["fs.read", "fs.write"] as const,
          scope: "session" as const,
          approvalId: approval.id,
        },
      };
    }
    this.#cancelFolder(mode);
    const store = this.#d.storeFor(session.id);
    if (!store.worktree(session.id))
      this.#d.audit.append({
        at: this.#d.clock(),
        actor: { user: who.userId, host: "core" },
        action: "code.session.bind",
        target: session.id,
        detail: { root: root.canonical, projectId: p.projectId ?? null, cardId: p.cardId ?? null },
      });
    store.bindWorktree({
      sessionId: session.id,
      root: root.canonical,
      projectId: p.projectId ?? null,
      cardId: p.cardId ?? null,
      createdBy: who.userId,
    });
    if (project && !project.card.links.some((link) => link.kind === "session" && link.id === session.id)) {
      this.#d.project!.collab.boardStore.updateCard(
        p.projectId!,
        p.cardId!,
        { links: [...project.card.links, { kind: "session", id: session.id }] },
        { kind: "person", id: who.userId },
      );
    }
    mode.mode = "coding";
    let branch: string | null = null;
    try {
      branch = gitLine(codingGit(root.canonical, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
    } catch {
      /* detached */
    }
    return {
      state: "open" as const,
      session: toWireSession(session),
      root: root.canonical,
      branch,
      profile: "coding" as const,
      lastEventSeq: store.lastEventSeq(session.id) ?? 0,
      runningTurnId: store.runningTurn(session.id)?.id ?? null,
      ...(p.projectId ? { projectId: p.projectId, cardId: p.cardId! } : {}),
    };
  }

  /** CX5: a human selects only this ACP connection/session's future profile, with no grant mutation. */
  async setMode(p: CodeSessionModeParams, who: Principal, connection: CodeConnection) {
    const session = this.#owned(p.sessionId, who, p.caller);
    this.#human(who, session.agentId);
    if (this.#d.linkedCaller && !this.#d.linkedCaller(who, p.caller)) {
      throw new RpcError("E_DENIED", "caller identity must be linked to the authenticated person");
    }
    if (session.kind !== "acp" || (p.mode !== "chat" && p.mode !== "coding")) {
      throw new RpcError("E_INVALID_PARAMS", "mode selection requires an ACP session and chat or coding");
    }
    const key = presenceKey(connection.connectionId, session.id);
    const presence = this.#presence.get(key);
    await this.requireRoot(session.id, who, p.caller, presence?.taskId);
    if (!presence || presence.person !== who.userId || this.#presence.get(key) !== presence ||
      connection.signal?.aborted) {
      throw new RpcError("E_CONFLICT", "open the coding session on this connection before selecting its mode", {
        reason: "code-mode-connection",
      });
    }
    const from = presence.mode ?? "coding";
    if (from === p.mode) return { mode: p.mode, changed: false };
    this.#d.audit.append({ at: this.#d.clock(), actor: { user: who.userId, host: "core" },
      action: "code.session.mode", target: session.id, detail: { from, to: p.mode } });
    presence.mode = p.mode;
    return { mode: p.mode, changed: true };
  }

  /** Revalidate ownership, live D115 assignment/native identity and current D109 read permission on every use. */
  async requireRoot(sessionId: string, who: Principal, caller?: CallerIdentity, taskId?: string) {
    const session = this.#owned(sessionId, who, caller);
    this.#human(who, session.agentId);
    if (session.archivedAt !== null) throw new RpcError("E_CONFLICT", "coding session is archived");
    const binding = this.#d.storeFor(session.id).worktree(session.id);
    if (!binding) throw new RpcError("E_NOT_AVAILABLE", "session has no coding worktree binding");
    const root = await codingRoot(binding.root, this.#d.home, this.#d.roots(session.agentId), this.#d.deny);
    // Native canonicalisation awaits filesystem operations. Re-read authority after that boundary.
    const current = this.#owned(sessionId, who, caller);
    this.#human(who, current.agentId);
    if (current.archivedAt !== null) throw new RpcError("E_CONFLICT", "coding session is archived");
    if (binding.projectId && binding.cardId) {
      const card = this.#card(who, current.agentId, binding.projectId, binding.cardId);
      if (
        realpathSync.native(card.root) !== binding.root ||
        !card.card.links.some((link) => link.kind === "session" && link.id === session.id)
      ) {
        throw new RpcError("E_DENIED", "card worktree/session binding changed");
      }
    }
    if (
      root.canonical !== binding.root ||
      !this.#granted(root, who.userId, current.agentId, current.id, binding.projectId ?? undefined, taskId)
    ) {
      throw new RpcError("E_APPROVAL_REQUIRED", "folder grant is missing or revoked", { reason: "root-not-granted" });
    }
    return { session: current, binding, root };
  }

  /** A responsible identity on a noninteractive code connection is not live T3 presence (Q13). */
  approver(connectionId: string, sessionId: string, original: TurnApprover): TurnApprover {
    const mode = this.#presence.get(presenceKey(connectionId, sessionId));
    return mode?.sessionId === sessionId && mode.person === original.person
      ? { ...original, taskId: mode.taskId, ...(mode.mode ? { codingMode: mode.mode } : {}),
        ...(!mode.interactive ? { surface: 0 as const } : {}) }
      : original;
  }

  /** The task comes from the authenticated connection's open operation, never the request body. */
  taskId(connectionId: string, sessionId: string): string | undefined {
    const mode = this.#presence.get(presenceKey(connectionId, sessionId));
    return mode?.sessionId === sessionId ? mode.taskId : undefined;
  }

  /** Native task authority also expires in memory if a failed permission writer cannot record cleanup. */
  hasTask(taskId: string, sessionId: string, person?: string): boolean {
    return [...this.#presence.values()].some(
      (mode) =>
        mode.taskId === taskId && mode.sessionId === sessionId && (person === undefined || mode.person === person),
    );
  }

  /** Coding bindings, explicit agent settings and D115 cards select the profile; background roles keep their own. */
  enabled(req: import("../session/provider.ts").ChatRequest): boolean {
    if (req.role) return false;
    const store = this.#d.storeFor(req.sessionId),
      session = store.getSession(req.sessionId);
    // ACP mode is connection-local; a persisted worktree never gives another peer this profile.
    if (session?.kind === "acp") return req.approver?.codingMode === "coding";
    return (
      store.worktree(req.sessionId) !== null ||
      this.#d.codingAgent?.(req.agentId) === true ||
      (!!this.#d.project && session?.kind === "card" && session.scope !== "user")
    );
  }

  /** Revalidate the stored owner/agent and live folder authority without promoting the sender to a human approver. */
  async prepare(req: import("../session/provider.ts").ChatRequest) {
    const store = this.#d.storeFor(req.sessionId),
      binding = store.worktree(req.sessionId);
    if (!binding) return req;
    const session = store.getSession(req.sessionId);
    if (!session || session.owner !== req.principal || session.agentId !== req.agentId) {
      throw new RpcError("E_DENIED", "coding request does not match the stored session");
    }
    if (req.role) return { ...req, ...(binding.projectId ? { projectId: binding.projectId } : {}) };
    if (session.kind === "acp" && req.approver?.codingMode === undefined) {
      throw new RpcError("E_CONFLICT", "the ACP connection mode expired; open a new editor session", {
        reason: "code-mode-connection",
      });
    }
    const who = this.#d.resolvePerson?.(binding.createdBy);
    if (!who) throw new RpcError("E_DENIED", "coding session owner is unavailable");
    await this.requireRoot(session.id, who, req.caller, req.approver?.taskId);
    return { ...req, ...(binding.projectId ? { projectId: binding.projectId } : {}) };
  }

  /** Core connection lifecycle cleanup; a new connection must explicitly open its own coding mode. */
  connectionClosed(id: string): void {
    for (const [key, mode] of this.#presence) if (mode.connectionId === id) this.#endPresence(key);
  }

  #endPresence(key: string): void {
    const mode = this.#presence.get(key);
    this.#presence.delete(key);
    if (mode) {
      this.#cancelFolder(mode);
      try {
        this.#d.endTask?.(mode.taskId);
      } catch (error) {
        try {
          this.#d.onCleanupError?.(error);
        } catch {
          /* lifecycle cleanup must continue */
        }
      }
    }
  }

  /** Session archive/replacement withdraws pending root requests before the standing grants end. */
  sessionEnded(sessionId: string): void {
    this.#ephemeralSessions.delete(sessionId);
    for (const [key, mode] of this.#presence) if (mode.sessionId === sessionId) this.#endPresence(key);
  }

  #cancelFolder(mode: CodePresence): void {
    const id = mode.approvalId;
    delete mode.approvalId;
    delete mode.approvalRoot;
    if (!id) return;
    try {
      this.#d.cancelFolder?.(id, mode.person);
    } catch (error) {
      try {
        this.#d.onCleanupError?.(error);
      } catch {
        /* the live mode still expires */
      }
    }
  }

  /** End every native task before the permission runtime closes. */
  close(): void {
    for (const key of this.#presence.keys()) this.#endPresence(key);
    for (const id of this.#ephemeralSessions) {
      try {
        this.#d.endSession?.(id);
      } catch (error) {
        try {
          this.#d.onCleanupError?.(error);
        } catch {
          /* shutdown still ends the ephemeral session */
        }
      }
    }
    this.#ephemeralSessions.clear();
  }

  #human(who: Principal, agentId: string): void {
    if (who.kind !== "person") throw new RpcError("E_DENIED", "coding session binding requires a person");
    requireAgent(this.#d.agents, agentId);
    if (authorize(who, "agent.use", { kind: "agent", agentId }).effect !== "allow") {
      throw new RpcError("E_DENIED", "agent use right required");
    }
  }

  #owned(id: string, who: Principal, caller?: CallerIdentity): SessionRecord {
    const session = this.#d.storeFor(id).getSession(id);
    const legacy = caller && this.#d.linkedCaller?.(who, caller) ? ownerOf(caller) : null;
    if (!session || (session.owner !== deriveUserPrincipal(who.userId) && session.owner !== legacy)) {
      throw new RpcError("E_NOT_FOUND", "session not found");
    }
    return session;
  }

  #card(who: Principal, agentId: string, projectId: string, cardId: string) {
    const port = this.#d.project;
    if (!port) throw new RpcError("E_NOT_AVAILABLE", "project coding is unavailable");
    const project = port.collab.getProject(who, projectId);
    const member = project.members.find((row) => row.userId === who.userId);
    const scoped = { ...who, projectRights: member ? { [projectId]: member.role } : {} };
    if (
      project.archivedAt !== null ||
      authorize(scoped, "project.write", { kind: "project", projectId }).effect !== "allow"
    ) {
      throw new RpcError("E_DENIED", "active project write membership required");
    }
    const card = port.collab.boardStore.getCard(projectId, cardId);
    if (
      card.archived ||
      !project.agents.includes(agentId) ||
      !card.assignees.some((a) => a.kind === "agent" && a.id === agentId)
    ) {
      throw new RpcError("E_DENIED", "active card requires the assigned project agent");
    }
    const root = port.worktrees.root(agentId, projectId, cardId);
    if (!root) throw new RpcError("E_NOT_AVAILABLE", "bound card worktree is unavailable");
    return { card, root };
  }

  #granted(
    root: Awaited<ReturnType<typeof codingRoot>>,
    person: string,
    agentId: string,
    sessionId: string,
    projectId?: string,
    taskId?: string,
  ) {
    if (taskId && !this.hasTask(taskId, sessionId, person)) taskId = undefined;
    const decision = decide(
      {
        capability: "fs.read",
        tool: "file.read",
        effect: "read",
        flags: {
          outsideRoots: root.rootId === null,
          denyListHit: false,
          ...(root.systemTree ? { systemTree: true } : {}),
        },
        targets: [root.canonical],
        access: "read",
        actionHash: createHash("sha256")
          .update(JSON.stringify([sessionId, root.canonical]))
          .digest("hex"),
      },
      // A read-permission probe never asserts a human surface or makes a decision.
      {
        principal: { person },
        subject: { kind: "agent", agentId },
        surface: 0,
        sessionId,
        ...(taskId ? { taskId } : {}),
        ...(projectId ? { projectId } : {}),
      },
      { grants: this.#d.grants, clock: { now: this.#d.clock } },
    );
    if (decision.kind !== "allow") return false;
    if (decision.via !== "grant") return true;
    const grant = decision.grantId ? this.#d.grants.get(decision.grantId) : undefined;
    return !!grant && grant.scope !== "once";
  }
}
