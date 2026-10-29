import type { ChatProvider } from "../session/provider.ts";
import { FakeChatProvider } from "../session/provider.ts";
import { estimateTokens, truncateWithPointer } from "../session/compaction.ts";
import type { Principal } from "../rbac/types.ts";
import { DEFAULT_COLLAB_SETTINGS, SPAN_PREVIEW_CHARS } from "./defaults.ts";
import { CollabError, type GuardrailReason } from "./errors.ts";
import { evaluateGuardrails } from "./guardrails.ts";
import { newSpanId, newTraceId, pairKey, repeatKey } from "./ids.ts";
import {
  activeDirectory, logsRedactionPort, noopEmitter, rbacAuthorizePort, unlimitedBudget,
  type AgentDirectoryPort, type AgentScopePort, type ArtifactPort, type AuthorizePort, type BudgetPort,
  type EventEmitter, type RedactionPort,
} from "./ports.ts";
import { providerRunner, type AgentRunner } from "./runner.ts";
import { alsAgentScopePort, scopeFor } from "./scope.ts";
import { dirname, sep } from "node:path";
import { CollabStore, type TaskGrantEnd } from "./store.ts";
import type {
  CollabEvent, CollabSettings, CollabTrace, ConsultAnswer, ConsultInput, DelegateHandle, DelegateInput,
  DelegateTask, Project, ProjectRole, RepoBinding, SpanStatus,
} from "./types.ts";
import { assertRepoBinding } from "../external-agents/binding.ts";
import type { GitExec } from "../external-agents/git.ts";

export interface CollabOptions {
  sessions?: () => import("../session/store.ts").SessionStore;
  path: string;
  clock?: () => number;
  newId?: (prefix: string) => string;
  authorize?: AuthorizePort;
  budget?: BudgetPort;
  artifacts?: ArtifactPort;
  redact?: RedactionPort;
  emit?: EventEmitter;
  provider?: ChatProvider;
  runner?: AgentRunner;
  scope?: AgentScopePort;
  directory?: AgentDirectoryPort;
  /** Ends task-scoped grants when a delegate task reaches a terminal status (D109 §9.9). */
  grants?: TaskGrantEnd;
  logWarn?: (msg: string, fields?: { err?: unknown }) => void;
  /** Harness home. `project.repo.bind` refuses a repository inside it. */
  home?: string;
  git?: GitExec;
}

interface Chain {
  traceId: string;
  projectId: string;
  rootAgent: string;
  rootSpanId: string;
  startedAt: number;
  fanout: number;
  pairCounts: Map<string, number>;
  tokensUsed: number;
  abort: AbortController;
  timeout: ReturnType<typeof setTimeout> | undefined;
  inflight: Set<AbortController>;
  ended: boolean;
}

export interface Collab {
  readonly boardStore: import("./board.ts").ProjectBoardStore;
  boardProject(id: string): Project | null;
  close(): void;
  /** Aborts every chain, waits up to `budgetMs` (default 5 s) for in-flight runs, then abandons the rest (`chain.abandoned`). */
  shutdown(budgetMs?: number): Promise<void>;
  createProject(principal: Principal, input: { name: string; settings?: Partial<CollabSettings> }): Project;
  updateProject(principal: Principal, id: string, name: string): Project;
  getProject(principal: Principal, id: string): Project;
  listProjects(principal: Principal): Project[];
  archiveProject(principal: Principal, id: string): Project;
  addMember(principal: Principal, projectId: string, userId: string, role: ProjectRole): Project;
  removeMember(principal: Principal, projectId: string, userId: string): Project;
  addAgent(principal: Principal, projectId: string, agentId: string): Project;
  removeAgent(principal: Principal, projectId: string, agentId: string): Project;
  /** Lead person only. Checks toplevel, bare repos and the harness home before writing. */
  bindRepo(principal: Principal, projectId: string, repoPath: string, baseBranch: string): Project;
  unbindRepo(principal: Principal, projectId: string): Project;
  consult(input: ConsultInput): Promise<ConsultAnswer>;
  delegate(input: DelegateInput): DelegateHandle;
  getTask(principal: Principal, id: string): DelegateTask;
  cancelChain(principal: Principal, traceId: string): void;
  getTrace(principal: Principal, traceId: string): CollabTrace;
  listTraces(principal: Principal, projectId: string): CollabTrace[];
  replay(principal: Principal, traceId: string, spanId: string): { sessionId: string; traceId: string; spanId: string; messages: import("../session/types.ts").MessageRecord[]; events: import("../session/types.ts").EventRecord[] };
  exportTrace(principal: Principal, traceId: string): string;
}

export function createCollab(o: CollabOptions): Collab {
  const store = new CollabStore({ path: o.path, ...(o.clock ? { clock: o.clock } : {}), ...(o.newId ? { newId: o.newId } : {}), ...(o.grants ? { grants: o.grants } : {}), ...(o.logWarn ? { logWarn: o.logWarn } : {}) });
  const marker = `${sep}state${sep}collab.sqlite`;
  const harnessHome = o.home ?? (o.path.endsWith(marker) ? dirname(dirname(o.path)) : undefined);
  const authorize = o.authorize ?? rbacAuthorizePort;
  const budget = o.budget ?? unlimitedBudget();
  const redact = o.redact ?? logsRedactionPort();
  const emit = o.emit ?? noopEmitter();
  const scope = o.scope ?? alsAgentScopePort();
  const directory = o.directory ?? activeDirectory();
  const artifacts: ArtifactPort = o.artifacts ?? {
    put: (a) => store.putArtifact(a.projectId, a.body, a.contentType ?? "text/plain"),
    get: (id) => store.getArtifact(id),
  };
  const provider = o.provider ?? new FakeChatProvider();
  const runner = o.runner ?? providerRunner(provider, scope);
  const chains = new Map<string, Chain>();
  // Set once the store is closed: a run abandoned at shutdown that finishes later must not touch it (nor reject unobserved).
  let storeClosed = false;

  const fire = (e: Omit<CollabEvent, "at">): void => {
    try { emit.emit({ ...e, at: store.now() }); } catch { /* emitter must not break collab */ }
  };
  const authz = (principal: Principal, action: string, resource: Parameters<AuthorizePort>[2]): void => {
    const d = authorize(principal, action, resource);
    if (d.effect !== "allow") throw new CollabError("unauthorized", `refused ${action}`, { reason: d.reason });
  };
  const requireLead = (principal: Principal, projectId: string): Project => {
    if (principal.kind !== "person") throw new CollabError("unauthorized", "only a person may bind a repository", { reason: "agent-principal" });
    const project = liveProject(projectId);
    const membership = project.members.find((m) => m.userId === principal.userId);
    if (!membership || membership.role !== "lead") throw new CollabError("unauthorized", "repository binding requires a project lead", { reason: "lead-required" });
    return project;
  };
  /** Cap a delegate return. `truncateWithPointer` can clip its own marker when the budget is tiny; the pointer must always survive. */
  const capReturn = (text: string, maxTokens: number, pointer: string): { text: string; truncated: boolean } => {
    const cap = truncateWithPointer(text, maxTokens, pointer);
    if (!cap.truncated) return cap;
    if (cap.text.includes(pointer) && cap.text.includes("[truncated")) return cap;
    return { text: `[truncated ${text.length} chars; ${pointer}]`, truncated: true };
  };
  const preview = (s: string): string => redact.text(s.length > SPAN_PREVIEW_CHARS ? `${s.slice(0, SPAN_PREVIEW_CHARS)}…` : s);
  const redactTrace = (t: CollabTrace): CollabTrace => ({
    ...t,
    spans: t.spans.map((s) => ({
      ...s,
      inputPreview: redact.text(s.inputPreview),
      outputPreview: redact.text(s.outputPreview),
      error: s.error ? redact.text(s.error) : null,
    })),
  });

  const liveProject = (id: string): Project => {
    const p = store.getProject(id);
    if (!p) throw new CollabError("not-found", `project ${id} not found`, { reason: "project" });
    if (p.archivedAt !== null) throw new CollabError("archived", `project ${id} is archived`, { reason: "archived" });
    return p;
  };
  /** RBAC `project.read` is role-wide; what a project shows to a person is decided by stored membership (privileged roles see all). */
  const privileged = (principal: Principal): boolean => principal.role === "owner" || principal.role === "admin" || principal.role === "operator";
  const visible = (principal: Principal, p: Project): boolean =>
    privileged(principal)
    || p.members.some((m) => m.userId === principal.userId)
    || (principal.kind === "agent" && p.agents.includes(principal.userId));
  /** A project the caller may not see is refused exactly like a missing one (privileged roles get a plain not-found). */
  const visibleProject = (principal: Principal, id: string, what = "project"): Project => {
    const p = store.getProject(id);
    if (p && visible(principal, p)) return p;
    if (privileged(principal)) throw new CollabError("not-found", `${what} ${id} not found`, { reason: what });
    throw new CollabError("unauthorized", "project access refused", { reason: "membership" });
  };
  const redactTask = (t: DelegateTask): DelegateTask => ({
    ...t,
    task: redact.text(t.task),
    acceptanceCriteria: redact.text(t.acceptanceCriteria),
    result: t.result ? redact.text(t.result) : t.result,
    error: t.error ? redact.text(t.error) : t.error,
  });

  const assertAgents = (project: Project, fromAgent: string, toAgent: string): { sameProject: boolean } => {
    const inP = (id: string) => project.agents.includes(id);
    const sameProject = inP(fromAgent) && inP(toAgent);
    for (const id of [fromAgent, toAgent]) {
      const info = directory.get(id);
      if (!info || info.state !== "active") {
        throw new CollabError("guardrail", `agent ${id} is not an active consult/delegate target`, { guardrail: "agent-inactive", reason: "agent-inactive" });
      }
    }
    return { sameProject };
  };

  const refuse = (chain: Chain, i: { agentId: string; parentSpanId: string | null; reason: GuardrailReason; detail: string }): never => {
    const spanId = newSpanId();
    store.insertSpan({ spanId, traceId: chain.traceId, parentSpanId: i.parentSpanId, agentId: i.agentId, kind: "guardrail", status: "refused", inputPreview: preview(i.detail) });
    store.finishSpan(spanId, { status: "refused", error: i.reason, guardrail: i.reason, outputPreview: preview(i.detail) });
    fire({ type: "guardrail.refused", projectId: chain.projectId, traceId: chain.traceId, agentId: i.agentId, data: { reason: i.reason } });
    throw new CollabError("guardrail", i.detail, { guardrail: i.reason, reason: i.reason });
  };

  const chainSignal = (chain: Chain, extra?: AbortSignal): AbortSignal => {
    const parts: AbortSignal[] = [chain.abort.signal];
    if (extra) parts.push(extra);
    return parts.length === 1 ? parts[0]! : AbortSignal.any(parts);
  };

  const beginChain = (project: Project, rootAgent: string, extra?: AbortSignal): Chain => {
    const traceId = newTraceId();
    const rootSpanId = newSpanId();
    store.insertTrace({ traceId, projectId: project.id, rootAgent, rootSpanId });
    const abort = new AbortController();
    if (extra) {
      if (extra.aborted) abort.abort(extra.reason);
      else extra.addEventListener("abort", () => abort.abort(extra.reason), { once: true });
    }
    const chain: Chain = {
      traceId, projectId: project.id, rootAgent, rootSpanId, startedAt: store.now(),
      fanout: 0, pairCounts: new Map(), tokensUsed: 0, abort, timeout: undefined, inflight: new Set(), ended: false,
    };
    const remain = project.settings.timeoutMs;
    if (remain > 0 && Number.isFinite(remain)) {
      // Node fires a timer beyond 2^31-1 ms after 1 ms; a huge configured timeout must mean "very long", not "at once".
      chain.timeout = setTimeout(() => abort.abort(new Error("timeout")), Math.min(remain, 2_147_483_647));
      chain.timeout.unref?.();
    }
    chains.set(traceId, chain);
    return chain;
  };

  const attachSignal = (chain: Chain, extra?: AbortSignal): void => {
    if (!extra) return;
    if (extra.aborted) chain.abort.abort(extra.reason);
    else extra.addEventListener("abort", () => chain.abort.abort(extra.reason), { once: true });
  };

  const getChain = (traceId: string | undefined, project: Project, rootAgent: string, extra?: AbortSignal): Chain => {
    if (!traceId) return beginChain(project, rootAgent, extra);
    const existing = chains.get(traceId);
    if (existing) {
      // A trace belongs to one project: another project's live chain is reported as missing, never joined.
      if (existing.projectId !== project.id) throw new CollabError("not-found", `trace ${traceId} not found`, { reason: "trace" });
      attachSignal(existing, extra); return existing;
    }
    const persisted = store.getTrace(traceId);
    if (!persisted || persisted.projectId !== project.id) throw new CollabError("not-found", `trace ${traceId} not found`, { reason: "trace" });
    const abort = new AbortController();
    const revived: Chain = {
      traceId, projectId: project.id, rootAgent: persisted.rootAgent, rootSpanId: persisted.rootSpanId,
      startedAt: persisted.createdAt, fanout: persisted.spans.filter((s) => s.kind !== "guardrail").length,
      pairCounts: new Map(), tokensUsed: persisted.spans.reduce((n, s) => n + s.inputTokens + s.outputTokens, 0),
      abort, timeout: undefined, inflight: new Set(), ended: persisted.endedAt !== null,
    };
    chains.set(traceId, revived);
    attachSignal(revived, extra);
    return revived;
  };

  const endChainIfIdle = (chain: Chain, status: SpanStatus): void => {
    if (storeClosed || chain.inflight.size > 0 || chain.ended) return;
    chain.ended = true;
    if (chain.timeout) clearTimeout(chain.timeout);
    store.finishTrace(chain.traceId, status);
  };

  const cancelChainInner = (chain: Chain): void => {
    if (!chain.abort.signal.aborted) chain.abort.abort(new Error("aborted"));
    for (const child of chain.inflight) { try { child.abort(new Error("aborted")); } catch { /* already */ } }
    if (storeClosed) return;
    store.cancelOpenTasks(chain.traceId);
    const t = store.getTrace(chain.traceId);
    if (t) {
      for (const s of t.spans) {
        if (s.status === "running") store.finishSpan(s.spanId, { status: "cancelled", error: "aborted" });
      }
    }
    endChainIfIdle(chain, "cancelled");
  };

  const guard = (chain: Chain, project: Project, i: {
    fromAgent: string; toAgent: string; path: string[]; question: string; parentSpanId: string | null; nextTokens: number;
  }): void => {
    const { sameProject } = assertAgents(project, i.fromAgent, i.toAgent);
    const pk = pairKey(i.fromAgent, i.toAgent);
    const decision = evaluateGuardrails({
      settings: project.settings, fromAgent: i.fromAgent, toAgent: i.toAgent, path: i.path,
      fanout: chain.fanout, pairCount: chain.pairCounts.get(pk) ?? 0, now: store.now(), chainStartedAt: chain.startedAt,
      lastRepeatAt: store.lastRepeat(repeatKey(i.fromAgent, i.toAgent, i.question)),
      sameProject, tokensUsed: chain.tokensUsed, nextTokens: i.nextTokens,
    });
    if (decision) refuse(chain, { agentId: i.toAgent, parentSpanId: i.parentSpanId, reason: decision, detail: `guardrail ${decision}` });
    const b = budget.check({ tokens: i.nextTokens, projectId: project.id, agentId: i.toAgent, chainId: chain.traceId });
    if (!b.allowed) refuse(chain, { agentId: i.toAgent, parentSpanId: i.parentSpanId, reason: b.reason, detail: `guardrail ${b.reason}` });
  };

  const runTarget = async (chain: Chain, project: Project, toAgent: string, question: string, context: string, signal: AbortSignal, principal?: Principal, handoff?: import("./runner.ts").AgentRunInput["handoff"], hop?: { spanId: string; fromAgent: string }): Promise<import("./runner.ts").AgentRunResult> => {
    if (handoff) {
      const remaining = Math.max(1, Math.min(300000, Date.parse(handoff.contract.budget.deadline) - store.now()));
      signal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    }
    const sc = scopeFor(toAgent, project.id);
    const sessions = o.sessions?.();
    const session = sessions && hop ? sessions.createSession({ kind: 'project', agentId: toAgent, owner: `collab-project:${project.id}`, scope: project.id, title: `Delegation ${hop.fromAgent} → ${toAgent}` }) : null;
    const turn = session && sessions ? sessions.beginTurn(session.id, redact.text(question), estimateTokens(question)).turn : null;
    if (session && hop) store.bindSession(hop.spanId, session.id);
    if (turn && sessions && handoff) sessions.appendEvent(turn.id, 'tool.result', { kind: 'tool_result', trust: 'untrusted', provenance: { traceId: chain.traceId, fromAgent: hop!.fromAgent }, handoff: redact.value(handoff.contract) });
    const execute = () => scope.run(sc, async () => {
      if (!scope.current() || scope.current()!.agentId !== toAgent) {
        throw new CollabError("no-scope", "AgentScope is required; unscoped access is refused");
      }
      if (!handoff) return runner.run({ ...(session ? { sessionId: session.id } : {}), agentId: toAgent, question, context, signal, ...(principal ? { principal } : {}) });
      let progress = { text: "", inputTokens: 0, outputTokens: 0 };
      let detach = () => {};
      const aborted = new Promise<import("./runner.ts").AgentRunResult>(resolve => {
        const done = () => resolve({ ...progress, partial: true });
        if (signal.aborted) done();
        else { signal.addEventListener("abort", done, { once: true }); detach = () => signal.removeEventListener("abort", done); }
      });
      if (signal.aborted) return { ...progress, partial: true };
      try {
        return await Promise.race([runner.run({ ...(session ? { sessionId: session.id } : {}), agentId: toAgent, question, context, signal, ...(principal ? { principal } : {}), ...(handoff ? { handoff } : {}), onTranscript: entry => { if (turn && sessions && !signal.aborted && !storeClosed) sessions.appendEvent(turn.id, 'tool.result', { kind: 'tool_result', trust: 'untrusted', provenance: { traceId: chain.traceId, spanId: hop!.spanId, agentId: toAgent }, entry: redact.value(entry) }); }, onProgress: p => { if (!signal.aborted) progress = { ...p }; } }), aborted]);
      } finally { detach(); }
    });
    try {
      const out = await execute();
      if (turn && sessions) {
        sessions.appendEvent(turn.id, 'tool.result', { kind: 'tool_result', trust: 'untrusted', provenance: { fromAgent: hop!.fromAgent, toAgent, projectId: project.id, traceId: chain.traceId, spanId: hop!.spanId }, result: redact.text(out.text), status: out.partial ? 'partial' : 'done', usage: { inputTokens: out.inputTokens, outputTokens: out.outputTokens } });
        sessions.completeTurn(turn.id, { text: redact.text(out.text), tokens: out.outputTokens, data: { traceId: chain.traceId, spanId: hop!.spanId, status: out.partial ? 'partial' : 'done' } });
      }
      return out;
    } catch (e) {
      if (turn && sessions) sessions.failTurn(turn.id, redact.text(e instanceof Error ? e.message : String(e)), { traceId: chain.traceId, spanId: hop!.spanId });
      throw e;
    }
  };

  const api: Collab = {
    async shutdown(budgetMs = 5_000) {
      for (const chain of chains.values()) chain.abort.abort(new Error("core stopping"));
      const busy = () => [...chains.values()].filter(chain => chain.inflight.size > 0);
      // Bounded like sessions.close: a runner that ignores its abort signal cannot hold core stop forever.
      const deadline = Date.now() + Math.max(0, budgetMs);
      while (busy().length > 0 && Date.now() < deadline) await new Promise<void>(resolve => { const t = setTimeout(resolve, 5); t.unref?.(); });
      for (const chain of busy()) {
        const inflight = chain.inflight.size;
        try {
          store.cancelOpenTasks(chain.traceId);
          for (const s of store.getTrace(chain.traceId)?.spans ?? []) if (s.status === "running") store.finishSpan(s.spanId, { status: "cancelled", error: "abandoned at shutdown" });
          if (!chain.ended) { chain.ended = true; store.finishTrace(chain.traceId, "cancelled"); }
        } catch { /* best effort: the store is closing */ }
        fire({ type: "chain.abandoned", projectId: chain.projectId, traceId: chain.traceId, data: { inflight, budgetMs } });
        chain.inflight.clear();
      }
      api.close();
    },
    close() {
      if (storeClosed) return;
      for (const c of chains.values()) { if (c.timeout) clearTimeout(c.timeout); }
      storeClosed = true;
      store.close();
    },

    boardStore: store.board,
    boardProject: id => store.getProject(id),
    createProject(principal, input) {
      const id = store.id("prj");
      authz(principal, "project.write", { kind: "project", projectId: id });
      const p = store.createProject({ name: input.name, owner: principal.userId, id, ...(input.settings ? { settings: input.settings } : {}) });
      fire({ type: "project.created", projectId: p.id, data: { name: p.name, owner: p.owner } });
      return p;
    },

    updateProject(principal, id, name) {
      authz(principal, "project.manage", { kind: "project", projectId: id });
      return store.updateProject(id, name);
    },

    getProject(principal, id) {
      authz(principal, "project.read", { kind: "project", projectId: id });
      return visibleProject(principal, id);
    },

    listProjects(principal) {
      return store.listProjects().filter((p) => visible(principal, p) && authorize(principal, "project.read", { kind: "project", projectId: p.id }).effect === "allow");
    },

    archiveProject(principal, id) {
      authz(principal, "project.manage", { kind: "project", projectId: id });
      const p = store.archiveProject(id);
      fire({ type: "project.archived", projectId: id, data: {} });
      return p;
    },

    addMember(principal, projectId, userId, role) {
      authz(principal, "project.manage", { kind: "project", projectId });
      const p = store.addMember(projectId, userId, role);
      fire({ type: "project.member.added", projectId, data: { userId, role } });
      return p;
    },

    removeMember(principal, projectId, userId) {
      authz(principal, "project.manage", { kind: "project", projectId });
      const p = store.removeMember(projectId, userId);
      fire({ type: "project.member.removed", projectId, data: { userId } });
      return p;
    },

    bindRepo(principal, projectId, repoPath, baseBranch) {
      requireLead(principal, projectId);
      if (!harnessHome) throw new CollabError("invalid", "harness home is required to bind a repository", { reason: "home-required" });
      const binding: RepoBinding = assertRepoBinding(repoPath, baseBranch, harnessHome, o.git);
      return store.setRepo(projectId, binding);
    },

    unbindRepo(principal, projectId) {
      requireLead(principal, projectId);
      return store.clearRepo(projectId);
    },

    addAgent(principal, projectId, agentId) {
      authz(principal, "project.write", { kind: "project", projectId });
      const p = store.addAgent(projectId, agentId);
      fire({ type: "project.agent.added", projectId, data: { agentId } });
      return p;
    },

    removeAgent(principal, projectId, agentId) {
      authz(principal, "project.write", { kind: "project", projectId });
      const p = store.removeAgent(projectId, agentId);
      fire({ type: "project.agent.removed", projectId, data: { agentId } });
      return p;
    },

    async consult(input) {
      if (!input.question.trim()) throw new CollabError("invalid", "question is required", { reason: "question" });
      authz(input.principal, "project.write", { kind: "project", projectId: input.projectId });
      const project = liveProject(input.projectId);
      authz(input.principal, "agent.use", { kind: "agent", agentId: input.fromAgent });
      authz(input.principal, "agent.use", { kind: "agent", agentId: input.toAgent });
      const path = input.path ?? [input.fromAgent];
      const chain = getChain(input.traceId, project, input.fromAgent, input.signal);
      const parentSpanId = input.parentSpanId ?? null;
      const nextTokens = estimateTokens(input.question) + estimateTokens(input.context);
      try {
        guard(chain, project, { fromAgent: input.fromAgent, toAgent: input.toAgent, path, question: input.question, parentSpanId, nextTokens });
      } catch (e) {
        endChainIfIdle(chain, "failed");
        throw e;
      }
      chain.fanout += 1;
      chain.pairCounts.set(pairKey(input.fromAgent, input.toAgent), (chain.pairCounts.get(pairKey(input.fromAgent, input.toAgent)) ?? 0) + 1);
      store.rememberRepeat(repeatKey(input.fromAgent, input.toAgent, input.question), store.now());
      const spanId = chain.fanout === 1 ? chain.rootSpanId : newSpanId();
      const childPath = [...path, input.toAgent];
      store.insertSpan({ spanId, traceId: chain.traceId, parentSpanId, agentId: input.toAgent, kind: "consult", inputPreview: preview(input.question) });
      fire({ type: "consult.started", projectId: project.id, traceId: chain.traceId, agentId: input.toAgent, data: { fromAgent: input.fromAgent, spanId } });
      const local = new AbortController();
      chain.inflight.add(local);
      const signal = chainSignal(chain, local.signal);
      if (input.signal?.aborted || chain.abort.signal.aborted) local.abort(new Error("aborted"));
      try {
        const out = await runTarget(chain, project, input.toAgent, input.question, input.context, signal, input.principal, input.handoff, { spanId, fromAgent: input.fromAgent });
        chain.tokensUsed += out.inputTokens + out.outputTokens;
        budget.record({ tokens: out.inputTokens + out.outputTokens, projectId: project.id, agentId: input.toAgent, chainId: chain.traceId });
        store.finishSpan(spanId, {
          status: out.partial ? "partial" : "succeeded", outputPreview: preview(out.text), inputTokens: out.inputTokens, outputTokens: out.outputTokens, ...(out.targetKind ? { targetKind: out.targetKind } : {}),
        });
        fire({ type: "consult.finished", projectId: project.id, traceId: chain.traceId, agentId: input.toAgent, data: { spanId, status: "succeeded" } });
        return {
          kind: "consult.answer", status: out.partial ? "partial" : "done",
          text: out.text,
          provenance: {
            agentId: input.toAgent, projectId: project.id, traceId: chain.traceId, spanId,
            at: store.now(), cost: { inputTokens: out.inputTokens, outputTokens: out.outputTokens }, targetKind: out.targetKind ?? "local",
          },
          path: childPath,
          traceId: chain.traceId,
        };
      } catch (e) {
        if (storeClosed) throw new CollabError("aborted", "consult abandoned at shutdown", { reason: "aborted" });
        const aborted = signal.aborted || chain.abort.signal.aborted || input.signal?.aborted === true;
        const msg = aborted ? "aborted" : e instanceof Error ? e.message : String(e);
        store.finishSpan(spanId, { status: aborted ? "cancelled" : "failed", error: msg, outputPreview: "" });
        fire({ type: "consult.finished", projectId: project.id, traceId: chain.traceId, agentId: input.toAgent, data: { spanId, status: aborted ? "cancelled" : "failed" } });
        if (aborted) {
          cancelChainInner(chain);
          throw new CollabError("aborted", "consult aborted", { reason: "aborted" });
        }
        if (e instanceof CollabError) throw e;
        throw new CollabError("invalid", msg, { reason: "run-failed" });
      } finally {
        chain.inflight.delete(local);
        if (chain.abort.signal.aborted) endChainIfIdle(chain, "cancelled");
      }
    },

    delegate(input) {
      if (!input.task.trim()) throw new CollabError("invalid", "task is required", { reason: "task" });
      authz(input.principal, "project.write", { kind: "project", projectId: input.projectId });
      const project = liveProject(input.projectId);
      authz(input.principal, "agent.use", { kind: "agent", agentId: input.fromAgent });
      authz(input.principal, "agent.use", { kind: "agent", agentId: input.toAgent });
      const path = input.path ?? [input.fromAgent];
      const chain = getChain(input.traceId, project, input.fromAgent, input.signal);
      const parentSpanId = input.parentSpanId ?? null;
      const nextTokens = estimateTokens(input.task) + estimateTokens(input.acceptanceCriteria);
      try {
        guard(chain, project, { fromAgent: input.fromAgent, toAgent: input.toAgent, path, question: input.task, parentSpanId, nextTokens });
      } catch (e) {
        endChainIfIdle(chain, "failed");
        throw e;
      }
      chain.fanout += 1;
      chain.pairCounts.set(pairKey(input.fromAgent, input.toAgent), (chain.pairCounts.get(pairKey(input.fromAgent, input.toAgent)) ?? 0) + 1);
      store.rememberRepeat(repeatKey(input.fromAgent, input.toAgent, input.task), store.now());
      const spanId = chain.fanout === 1 ? chain.rootSpanId : newSpanId();
      const taskId = store.id("tsk");
      const childPath = [...path, input.toAgent];
      store.insertSpan({ spanId, traceId: chain.traceId, parentSpanId, agentId: input.toAgent, kind: "delegate", inputPreview: preview(input.task) });
      const queued = store.insertTask({
        id: taskId, projectId: project.id, traceId: chain.traceId, spanId, parentTaskId: input.parentTaskId ?? null,
        fromAgent: input.fromAgent, toAgent: input.toAgent, kind: "delegate", status: "queued",
        task: input.task, acceptance: input.acceptanceCriteria, path: childPath,
      });
      fire({ type: "delegate.queued", projectId: project.id, traceId: chain.traceId, agentId: input.toAgent, data: { taskId, spanId } });
      const local = new AbortController();
      chain.inflight.add(local);
      const signal = chainSignal(chain, local.signal);

      const done = (async (): Promise<DelegateTask> => {
        store.updateTask(taskId, { status: "running" });
        fire({ type: "delegate.started", projectId: project.id, traceId: chain.traceId, agentId: input.toAgent, data: { taskId, spanId } });
        try {
          const prompt = `${input.task}\n\nAcceptance criteria:\n${input.acceptanceCriteria}`;
          const out = await runTarget(chain, project, input.toAgent, prompt, "", signal, input.principal, input.handoff, { spanId, fromAgent: input.fromAgent });
          chain.tokensUsed += out.inputTokens + out.outputTokens;
          budget.record({ tokens: out.inputTokens + out.outputTokens, projectId: project.id, agentId: input.toAgent, chainId: chain.traceId });
          const art = artifacts.put({ projectId: project.id, body: out.text, contentType: "text/plain" });
          const cap = capReturn(out.text, project.settings.returnTokens, art.pointer);
          const result = cap.text;
          const finished = store.updateTask(taskId, {
            status: out.partial ? "cancelled" : "succeeded", error: out.partial ? "partial" : null, result, truncated: cap.truncated, artifactId: art.id,
            inputTokens: out.inputTokens, outputTokens: out.outputTokens, ...(out.targetKind ? { targetKind: out.targetKind } : {}),
          });
          store.finishSpan(spanId, {
            status: out.partial ? "partial" : "succeeded", outputPreview: preview(result), inputTokens: out.inputTokens, outputTokens: out.outputTokens, ...(out.targetKind ? { targetKind: out.targetKind } : {}),
          });
          fire({ type: "delegate.finished", projectId: project.id, traceId: chain.traceId, agentId: input.toAgent, data: { taskId, status: out.partial ? "partial" : "succeeded", truncated: cap.truncated } });
          return finished;
        } catch (e) {
          if (storeClosed) return { ...queued, status: "cancelled", error: "abandoned at shutdown" } as DelegateTask;
          const aborted = signal.aborted || chain.abort.signal.aborted || input.signal?.aborted === true;
          const msg = aborted ? "aborted" : e instanceof Error ? e.message : String(e);
          const finished = store.updateTask(taskId, { status: aborted ? "cancelled" : "failed", error: msg });
          store.finishSpan(spanId, { status: aborted ? "cancelled" : "failed", error: msg });
          fire({
            type: aborted ? "delegate.cancelled" : "delegate.finished",
            projectId: project.id, traceId: chain.traceId, agentId: input.toAgent,
            data: { taskId, status: aborted ? "cancelled" : "failed" },
          });
          if (aborted) cancelChainInner(chain);
          return finished;
        } finally {
          chain.inflight.delete(local);
          if (chain.abort.signal.aborted) endChainIfIdle(chain, "cancelled");
        }
      })();

      return { task: queued, done };
    },

    replay(principal, traceId, spanId) {
      const trace = api.getTrace(principal, traceId);
      const span = trace.spans.find(s => s.spanId === spanId);
      const sessions = o.sessions?.();
      if (!span?.sessionId || !sessions) throw new CollabError('not-found', 'delegation transcript not found');
      const session = sessions.getSession(span.sessionId);
      if (!session || session.scope !== trace.projectId || session.owner !== `collab-project:${trace.projectId}`) throw new CollabError('not-found', 'delegation transcript not found');
      return { sessionId: session.id, traceId, spanId, messages: redact.value(sessions.listMessages(session.id)), events: redact.value(sessions.listEvents(session.id)) };
    },

    getTask(principal, id) {
      const t = store.getTask(id);
      if (!t) throw new CollabError("not-found", `task ${id} not found`, { reason: "task" });
      authz(principal, "project.read", { kind: "project", projectId: t.projectId });
      visibleProject(principal, t.projectId, "task");
      return redactTask(t);
    },

    cancelChain(principal, traceId) {
      const t = store.getTrace(traceId);
      if (!t) throw new CollabError("not-found", `trace ${traceId} not found`, { reason: "trace" });
      authz(principal, "project.write", { kind: "project", projectId: t.projectId });
      const chain = chains.get(traceId);
      if (chain) cancelChainInner(chain);
      else store.cancelOpenTasks(traceId);
    },

    getTrace(principal, traceId) {
      const t = store.getTrace(traceId);
      if (!t) throw new CollabError("not-found", `trace ${traceId} not found`, { reason: "trace" });
      authz(principal, "project.read", { kind: "project", projectId: t.projectId });
      visibleProject(principal, t.projectId, "trace");
      return redactTrace(t);
    },

    listTraces(principal, projectId) {
      authz(principal, "project.read", { kind: "project", projectId });
      visibleProject(principal, projectId);
      return store.listTraces(projectId).map(redactTrace);
    },

    exportTrace(principal, traceId) {
      return JSON.stringify(api.getTrace(principal, traceId));
    },
  };

  return api;
}

export { DEFAULT_COLLAB_SETTINGS };
