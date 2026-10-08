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
import { CollabStore } from "./store.ts";
import type {
  CollabEvent, CollabSettings, CollabTrace, ConsultAnswer, ConsultInput, DelegateHandle, DelegateInput,
  DelegateTask, Project, ProjectRole, SpanStatus,
} from "./types.ts";

export interface CollabOptions {
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
  costUsed: number;
  abort: AbortController;
  timeout: ReturnType<typeof setTimeout> | undefined;
  inflight: Set<AbortController>;
  ended: boolean;
}

export interface Collab {
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
  consult(input: ConsultInput): Promise<ConsultAnswer>;
  delegate(input: DelegateInput): DelegateHandle;
  getTask(principal: Principal, id: string): DelegateTask;
  cancelChain(principal: Principal, traceId: string): void;
  getTrace(principal: Principal, traceId: string): CollabTrace;
  listTraces(principal: Principal, projectId: string): CollabTrace[];
  exportTrace(principal: Principal, traceId: string): string;
}

export function createCollab(o: CollabOptions): Collab {
  const store = new CollabStore({ path: o.path, ...(o.clock ? { clock: o.clock } : {}), ...(o.newId ? { newId: o.newId } : {}) });
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
  const readableProject = (id: string): Project => {
    const p = store.getProject(id);
    if (!p) throw new CollabError("not-found", `project ${id} not found`, { reason: "project" });
    return p;
  };

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
      fanout: 0, pairCounts: new Map(), tokensUsed: 0, costUsed: 0, abort, timeout: undefined, inflight: new Set(), ended: false,
    };
    const remain = project.settings.timeoutMs;
    if (remain > 0 && Number.isFinite(remain)) {
      chain.timeout = setTimeout(() => abort.abort(new Error("timeout")), remain);
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
    if (existing) { attachSignal(existing, extra); return existing; }
    const persisted = store.getTrace(traceId);
    if (!persisted || persisted.projectId !== project.id) throw new CollabError("not-found", `trace ${traceId} not found`, { reason: "trace" });
    const abort = new AbortController();
    const revived: Chain = {
      traceId, projectId: project.id, rootAgent: persisted.rootAgent, rootSpanId: persisted.rootSpanId,
      startedAt: persisted.createdAt, fanout: persisted.spans.filter((s) => s.kind !== "guardrail").length,
      pairCounts: new Map(), tokensUsed: persisted.spans.reduce((n, s) => n + s.inputTokens + s.outputTokens, 0),
      costUsed: 0, abort, timeout: undefined, inflight: new Set(), ended: persisted.endedAt !== null,
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
      sameProject, tokensUsed: chain.tokensUsed, nextTokens: i.nextTokens, costUsed: chain.costUsed, nextCost: 0,
    });
    if (decision) refuse(chain, { agentId: i.toAgent, parentSpanId: i.parentSpanId, reason: decision, detail: `guardrail ${decision}` });
    const b = budget.check({ tokens: i.nextTokens, cost: 0, projectId: project.id, agentId: i.toAgent, chainId: chain.traceId });
    if (!b.allowed) refuse(chain, { agentId: i.toAgent, parentSpanId: i.parentSpanId, reason: b.reason, detail: `guardrail ${b.reason}` });
  };

  const runTarget = async (chain: Chain, project: Project, toAgent: string, question: string, context: string, signal: AbortSignal, principal?: Principal): Promise<{ text: string; inputTokens: number; outputTokens: number }> => {
    const sc = scopeFor(toAgent, project.id);
    return scope.run(sc, async () => {
      if (!scope.current() || scope.current()!.agentId !== toAgent) {
        throw new CollabError("no-scope", "AgentScope is required; unscoped access is refused");
      }
      return runner.run({ agentId: toAgent, question, context, signal, ...(principal ? { principal } : {}) });
    });
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
      for (const c of chains.values()) { if (c.timeout) clearTimeout(c.timeout); }
      storeClosed = true;
      store.close();
    },

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
      const p = readableProject(id);
      authz(principal, "project.read", { kind: "project", projectId: id });
      return p;
    },

    listProjects(principal) {
      return store.listProjects().filter((p) => authorize(principal, "project.read", { kind: "project", projectId: p.id }).effect === "allow");
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
      const project = liveProject(input.projectId);
      authz(input.principal, "project.write", { kind: "project", projectId: input.projectId });
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
        const out = await runTarget(chain, project, input.toAgent, input.question, input.context, signal, input.principal);
        chain.tokensUsed += out.inputTokens + out.outputTokens;
        budget.record({ tokens: out.inputTokens + out.outputTokens, cost: 0, projectId: project.id, agentId: input.toAgent, chainId: chain.traceId });
        store.finishSpan(spanId, {
          status: "succeeded", outputPreview: preview(out.text), inputTokens: out.inputTokens, outputTokens: out.outputTokens, costEstimate: 0,
        });
        fire({ type: "consult.finished", projectId: project.id, traceId: chain.traceId, agentId: input.toAgent, data: { spanId, status: "succeeded" } });
        return {
          kind: "consult.answer",
          text: out.text,
          provenance: {
            agentId: input.toAgent, projectId: project.id, traceId: chain.traceId, spanId,
            at: store.now(), cost: { inputTokens: out.inputTokens, outputTokens: out.outputTokens }, targetKind: "local",
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
      const project = liveProject(input.projectId);
      authz(input.principal, "project.write", { kind: "project", projectId: input.projectId });
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
          const out = await runTarget(chain, project, input.toAgent, prompt, "", signal, input.principal);
          chain.tokensUsed += out.inputTokens + out.outputTokens;
          budget.record({ tokens: out.inputTokens + out.outputTokens, cost: 0, projectId: project.id, agentId: input.toAgent, chainId: chain.traceId });
          const art = artifacts.put({ projectId: project.id, body: out.text, contentType: "text/plain" });
          const cap = capReturn(out.text, project.settings.returnTokens, art.pointer);
          const result = cap.text;
          const finished = store.updateTask(taskId, {
            status: "succeeded", result, truncated: cap.truncated, artifactId: art.id,
            inputTokens: out.inputTokens, outputTokens: out.outputTokens,
          });
          store.finishSpan(spanId, {
            status: "succeeded", outputPreview: preview(result), inputTokens: out.inputTokens, outputTokens: out.outputTokens, costEstimate: 0,
          });
          fire({ type: "delegate.finished", projectId: project.id, traceId: chain.traceId, agentId: input.toAgent, data: { taskId, status: "succeeded", truncated: cap.truncated } });
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

    getTask(principal, id) {
      const t = store.getTask(id);
      if (!t) throw new CollabError("not-found", `task ${id} not found`, { reason: "task" });
      authz(principal, "project.read", { kind: "project", projectId: t.projectId });
      return t.result ? { ...t, result: redact.text(t.result) } : t;
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
      return redactTrace(t);
    },

    listTraces(principal, projectId) {
      authz(principal, "project.read", { kind: "project", projectId });
      return store.listTraces(projectId).map(redactTrace);
    },

    exportTrace(principal, traceId) {
      return JSON.stringify(api.getTrace(principal, traceId));
    },
  };

  return api;
}

export { DEFAULT_COLLAB_SETTINGS };
