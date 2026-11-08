import { GitWorktreeProvisioner } from "../external-agents/provisioner.ts";
import type { ChatProvider } from "../session/provider.ts";
import { FakeChatProvider } from "../session/provider.ts";
import { estimateTokens, truncateWithPointer } from "../session/compaction.ts";
import { wellFormedPrefix } from "../logs/utf16.ts";
import type { Principal } from "../rbac/types.ts";
import { withoutAgentScope } from "../agents/scope.ts";
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
import { dirname, join, sep } from "node:path";
import { CollabStore, type TaskGrantEnd } from "./store.ts";
import { delegationWorkBudget, type CallClass, type TaskClass, type CollabLimits } from './limits.ts';
import type { CollaborationLimitsConfig } from '@plur1bus/config-schema';
import { writerCapacity, type CapacityFacts } from './capacity.ts';
import type {
  CollabEvent, CollabSettings, CollabTrace, ConsultAnswer, ConsultInput, DelegateHandle, DelegateInput,
  DelegateTask, Project, ProjectRole, RepoBinding, SpanStatus,
} from "./types.ts";
import { assertRepoBinding } from "../external-agents/binding.ts";
import type { GitExec } from "../external-agents/git.ts";

export interface CollabOptions {
  teamPolicy?: () => import('@plur1bus/rpc-schema').TeamPolicy;
  /** Trusted receiving-agent view. Missing means no writer tools; contracts may only narrow it. */
  toolView?: (agentId: string) => readonly string[];
  limits?: () => CollaborationLimitsConfig;
  capacity?: () => CapacityFacts;
  timers?: { set(callback: () => void, ms: number): () => void };
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
  provisionWorktrees?: boolean;
}

interface Chain {
  traceId: string;
  projectId: string;
  rootAgent: string;
  rootSpanId: string;
  startedAt: number;
  fanout: number;
  readStarts: Map<string, number>;
  pairCounts: Map<string, number>;
  tokensUsed: number;
  abort: AbortController;
  inflight: Set<AbortController>;
  ended: boolean;
}

export interface WriterReservation { release(): void }
type WriterIdentity = Pick<DelegateInput, 'principal' | 'projectId' | 'fromAgent' | 'toAgent' | 'traceId' | 'parentSpanId'>;

export interface Collab {
  readonly worktreeStore: CollabStore;
  /** Synchronous trusted admission, shared across all turns using this service. */
  reserveWriter(input: WriterIdentity): WriterReservation;
  /** Create the shared turn trace synchronously, before any worker preparation. */
  openChain(principal: Principal, projectId: string, fromAgent: string, signal?: AbortSignal): string;
  finishChain(principal: Principal, traceId: string): void;
  limits(principal: Principal, projectId: string): CollabLimits;
  readonly boardStore: import("./board.ts").ProjectBoardStore;
  boardProject(id: string): Project | null;
  /** Authoritative target metadata; names in the reserved A2A namespace remain foreign after revocation. */
  isA2aAgent(id: string): boolean;
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
  const store = new CollabStore({ path: o.path, ...(o.redact ? { redact: o.redact } : {}), ...(o.teamPolicy ? { teamPolicy: o.teamPolicy } : {}), ...(o.limits ? { limits: o.limits } : {}), ...(o.clock ? { clock: o.clock } : {}), ...(o.newId ? { newId: o.newId } : {}), ...(o.grants ? { grants: o.grants } : {}), ...(o.logWarn ? { logWarn: o.logWarn } : {}) });
  const marker = `${sep}state${sep}collab.sqlite`;
  const harnessHome = o.home ?? (o.path.endsWith(marker) ? dirname(dirname(o.path)) : undefined);
  const timers = o.timers ?? { set(callback: () => void, ms: number) { const timer = setTimeout(callback, ms); timer.unref?.(); return () => clearTimeout(timer); } };
  const writers = new Map<string, number>();
  const reservations = new WeakMap<WriterReservation, { identity: WriterIdentity; local: boolean; running: boolean; released: boolean }>();
  let localReserved = 0, localRunning = 0;
  const authorize = o.authorize ?? rbacAuthorizePort;
  const budget = o.budget ?? unlimitedBudget();
  const redact = o.redact ?? logsRedactionPort();
  const emit = o.emit ?? noopEmitter();
  const scope = o.scope ?? alsAgentScopePort();
  const directory = o.directory ?? activeDirectory();
  const isA2aAgent = (id: string): boolean => {
    const target = directory.get(id);
    return id.startsWith("a2a:") || target?.origin === "a2a" || target?.targetKind === "a2a";
  };
  const requireA2aOwner = (principal: Principal, id: string): void => {
    if (isA2aAgent(id) && (principal.kind !== "person" || principal.role !== "owner")) {
      throw new CollabError("unauthorized", "A2A assignment and execution require an Owner person");
    }
  };
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
  const preview = (s: string): string => {
    const masked = redact.text(s).toWellFormed();
    return masked.length > SPAN_PREVIEW_CHARS ? `${wellFormedPrefix(masked, SPAN_PREVIEW_CHARS)}…` : masked;
  };
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
      fanout: 0, readStarts: new Map(), pairCounts: new Map(), tokensUsed: 0, abort, inflight: new Set(), ended: false,
    };
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
      return existing;
    }
    const persisted = store.getTrace(traceId);
    if (!persisted || persisted.projectId !== project.id) throw new CollabError("not-found", `trace ${traceId} not found`, { reason: "trace" });
    const abort = new AbortController();
    const revived: Chain = {
      traceId, projectId: project.id, rootAgent: persisted.rootAgent, rootSpanId: persisted.rootSpanId,
      startedAt: persisted.createdAt, fanout: persisted.spans.filter((s) => s.kind !== "guardrail").length,
      readStarts: new Map([[JSON.stringify([persisted.rootAgent, null]), persisted.spans.filter(s => s.kind !== 'guardrail').length]]),
      pairCounts: new Map(), tokensUsed: persisted.spans.reduce((n, s) => n + s.inputTokens + s.outputTokens, 0),
      abort, inflight: new Set(), ended: persisted.endedAt !== null,
    };
    chains.set(traceId, revived);
    attachSignal(revived, extra);
    return revived;
  };

  const endChainIfIdle = (chain: Chain, status: SpanStatus): void => {
    if (storeClosed || chain.inflight.size > 0 || chain.ended) return;
    chain.ended = true;
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
    fromAgent: string; toAgent: string; path: string[]; question: string; parentSpanId: string | null; nextTokens: number; turnKey: string;
    callClass: CallClass; consult: boolean;
  }): void => {
    const limits = store.limits(project.id);
    const { sameProject } = assertAgents(project, i.fromAgent, i.toAgent);
    const pk = pairKey(i.turnKey, i.toAgent);
    const decision = evaluateGuardrails({
      settings: { ...project.settings, maxDepth: limits.readHelpers.depth, maxFanout: limits.readHelpers.perTurn, maxPairPerTurn: limits.consults.perPairPerTurn }, fromAgent: i.fromAgent, toAgent: i.toAgent, path: i.path,
      callClass: i.callClass, consult: i.consult,
      fanout: chain.readStarts.get(i.turnKey) ?? 0, pairCount: chain.pairCounts.get(pk) ?? 0, now: store.now(), chainStartedAt: chain.startedAt,
      lastRepeatAt: store.lastRepeat(repeatKey(i.fromAgent, i.toAgent, i.question)),
      sameProject, tokensUsed: chain.tokensUsed, nextTokens: i.nextTokens,
    });
    if (decision) refuse(chain, { agentId: i.toAgent, parentSpanId: i.parentSpanId, reason: decision, detail: `guardrail ${decision}` });
    const b = budget.check({ tokens: i.nextTokens, projectId: project.id, agentId: i.toAgent, chainId: chain.traceId });
    if (!b.allowed) refuse(chain, { agentId: i.toAgent, parentSpanId: i.parentSpanId, reason: b.reason, detail: `guardrail ${b.reason}` });
  };

  const reserveWriter = (identity: WriterIdentity): WriterReservation => {
    requireA2aOwner(identity.principal, identity.toAgent);
    authz(identity.principal, 'project.write', { kind: 'project', projectId: identity.projectId });
    const project = liveProject(identity.projectId);
    authz(identity.principal, 'agent.use', { kind: 'agent', agentId: identity.fromAgent });
    authz(identity.principal, 'agent.use', { kind: 'agent', agentId: identity.toAgent });
    assertAgents(project, identity.fromAgent, identity.toAgent);
    const limits = store.limits(project.id), local = !isA2aAgent(identity.toAgent);
    const capacity = local && o.capacity ? writerCapacity(limits.writers.perProject, o.capacity(), localRunning) : undefined;
    if ((writers.get(project.id) ?? 0) >= limits.writers.perProject || (capacity && localReserved >= capacity.slots)) {
      const chain = getChain(identity.traceId, project, identity.fromAgent);
      refuse(chain, { agentId: identity.toAgent, parentSpanId: identity.parentSpanId ?? null, reason: 'fanout', detail: 'project writer slots full' });
    }
    if (capacity?.exceeded && localReserved >= capacity.computed) o.logWarn?.(`team.capacity.exceeded: project ${project.id}, computed ${capacity.computed}, configured ${capacity.slots}`);
    const state = { identity: { ...identity, principal: { ...identity.principal } }, local, running: false, released: false };
    const reservation: WriterReservation = { release() {
      if (state.released) return;
      state.released = true;
      writers.set(project.id, (writers.get(project.id) ?? 1) - 1);
      if (local) { localReserved--; if (state.running) localRunning--; }
    } };
    reservations.set(reservation, state);
    writers.set(project.id, (writers.get(project.id) ?? 0) + 1);
    if (local) localReserved++;
    return reservation;
  };
  const useReservation = (reservation: WriterReservation, input: WriterIdentity): void => {
    const state = reservations.get(reservation), identity = state?.identity;
    if (!state || state.released || state.running || identity!.projectId !== input.projectId || identity!.fromAgent !== input.fromAgent || identity!.toAgent !== input.toAgent || identity!.principal.userId !== input.principal.userId || identity!.principal.kind !== input.principal.kind) throw new CollabError('unauthorized', 'writer reservation identity mismatch or already consumed');
    state.running = true;
    if (state.local) localRunning++;
  };

  const runTarget = async (chain: Chain, project: Project, toAgent: string, question: string, context: string, signal: AbortSignal, principal?: Principal, handoff?: import("./runner.ts").AgentRunInput["handoff"], hop?: { spanId: string; fromAgent: string; path: string[]; callClass: CallClass; taskClass: TaskClass }, outbound?: import("./runner.ts").AgentRunInput["outbound"]): Promise<import("./runner.ts").AgentRunResult> => {
    const limits = store.limits(project.id), taskLimits = limits.taskClasses[hop?.taskClass ?? 'consult'];
    const deadline = new AbortController();
    const remaining = Math.max(0, Math.min(taskLimits.wallTimeMs, handoff ? Date.parse(handoff.contract.budget.deadline) - store.now() : Infinity));
    const stopDeadline = timers.set(() => deadline.abort(new Error('delegation deadline')), remaining);
    signal = AbortSignal.any([signal, deadline.signal]);
    const parent = scope.current()?.delegation;
    let finished = false;
    let stopStall = () => {};
    const markProgress = () => {
      if (signal.aborted || finished) return;
      stopStall();
      stopStall = timers.set(() => deadline.abort(new Error('delegation stalled')), taskLimits.stallTimeMs);
      parent?.onProgress?.();
    };
    markProgress();
    const clearTimers = () => { finished = true; stopDeadline(); stopStall(); };
    signal.addEventListener('abort', clearTimers, { once: true });
    const workBudget = delegationWorkBudget(Math.min(handoff?.contract.budget.tokens ?? limits.workTokens, limits.workTokens), parent?.workBudget);
    const sc = scopeFor(toAgent, project.id);
    if (hop?.callClass === 'write') sc.toolView = (o.toolView?.(toAgent) ?? []).filter(name => handoff?.contract.constraints.scope.tools.includes(name));
    if (hop) sc.delegation = { traceId: chain.traceId, spanId: hop.spanId, path: hop.path, callClass: hop.callClass, workBudget, onProgress: markProgress };
    if (hop?.callClass !== 'write') sc.toolView = handoff ? handoff.contract.constraints.scope.tools : ['file.read', 'file.list', 'file.stat'];
    const external = directory.get(toAgent)?.targetKind === "external";
    const sessions = external ? undefined : o.sessions?.();
    const session = sessions && hop ? sessions.createSession({ kind: 'project', agentId: toAgent, owner: `collab-project:${project.id}`, scope: project.id, title: `Delegation ${hop.fromAgent} → ${toAgent}` }) : null;
    const turn = session && sessions ? sessions.beginTurn(session.id, redact.text(question), estimateTokens(question)).turn : null;
    if (session && hop) store.bindSession(hop.spanId, session.id);
    if (turn && sessions && handoff) sessions.appendEvent(turn.id, 'tool.result', { kind: 'tool_result', trust: 'untrusted', provenance: { traceId: chain.traceId, fromAgent: hop!.fromAgent }, handoff: redact.value(handoff.contract) });
    const runScoped = <T>(run: () => Promise<T>): Promise<T> => external ? withoutAgentScope(run) : scope.run(sc, run);
    const execute = () => runScoped(async () => {
      if (!external && (!scope.current() || scope.current()!.agentId !== toAgent)) {
        throw new CollabError("no-scope", "AgentScope is required; unscoped access is refused");
      }
      const origin = hop ? { origin: { fromAgent: hop.fromAgent, traceId: chain.traceId, spanId: hop.spanId } } : {};
      const execution = { maxRounds: taskLimits.rounds, workBudget, returnTokens: limits.returnTokens };
      if (!handoff) return runner.run({ ...execution, ...(session ? { sessionId: session.id } : {}), agentId: toAgent, question, context, signal, onProgress: markProgress, ...(principal ? { principal } : {}), ...origin, ...(outbound ? { outbound } : {}) });
      let progress = { text: "", inputTokens: 0, outputTokens: 0 };
      let detach = () => {};
      const aborted = new Promise<import("./runner.ts").AgentRunResult>(resolve => {
        const done = () => resolve({ ...progress, partial: true });
        if (signal.aborted) done();
        else { signal.addEventListener("abort", done, { once: true }); detach = () => signal.removeEventListener("abort", done); }
      });
      if (signal.aborted) return { ...progress, partial: true };
      try {
        return await Promise.race([runner.run({ ...execution, ...(session ? { sessionId: session.id } : {}), agentId: toAgent, question, context, signal, ...(principal ? { principal } : {}), ...origin, ...(outbound ? { outbound } : {}), ...(handoff ? { handoff } : {}), onTranscript: entry => { markProgress(); if (turn && sessions && !signal.aborted && !storeClosed) sessions.appendEvent(turn.id, 'tool.result', { kind: 'tool_result', trust: 'untrusted', provenance: { traceId: chain.traceId, spanId: hop!.spanId, agentId: toAgent }, entry: redact.value(entry) }); }, onProgress: p => { if (!signal.aborted) { markProgress(); progress = { ...p }; } } }), aborted]);
      } catch (error) {
        if (signal.aborted) return { ...progress, partial: true };
        throw error;
      } finally { detach(); }
    });
    try {
      const out = await execute();
      if (turn && sessions) {
        sessions.appendEvent(turn.id, 'tool.result', { kind: 'tool_result', trust: 'untrusted', provenance: { fromAgent: hop!.fromAgent, toAgent, projectId: project.id, traceId: chain.traceId, spanId: hop!.spanId }, result: redact.text(out.text), status: out.partial ? 'partial' : 'done', usage: { inputTokens: out.inputTokens, outputTokens: out.outputTokens } });
        if (out.partial) sessions.failTurn(turn.id, redact.text(signal.reason instanceof Error ? signal.reason.message : 'delegation interrupted'), { traceId: chain.traceId, spanId: hop!.spanId, status: 'partial' });
        else sessions.completeTurn(turn.id, { text: redact.text(out.text), tokens: out.outputTokens, data: { traceId: chain.traceId, spanId: hop!.spanId, status: 'done' } });
      }
      return out;
    } catch (e) {
      if (turn && sessions) sessions.failTurn(turn.id, redact.text(e instanceof Error ? e.message : String(e)), { traceId: chain.traceId, spanId: hop!.spanId });
      throw e;
    } finally {
      clearTimers(); signal.removeEventListener('abort', clearTimers);
    }
  };

  const api: Collab = {
    worktreeStore: store,
    reserveWriter,
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
      for (const c of chains.values()) c.abort.abort(new Error('core closed'));
      storeClosed = true;
      store.close();
    },

    boardStore: store.board,
    openChain(principal, projectId, fromAgent, signal) {
      authz(principal, 'project.write', { kind: 'project', projectId });
      authz(principal, 'agent.use', { kind: 'agent', agentId: fromAgent });
      const project = liveProject(projectId);
      if (!project.agents.includes(fromAgent)) throw new CollabError('unauthorized', 'project agent assignment required');
      return beginChain(project, fromAgent, signal).traceId;
    },
    limits(principal, projectId) { api.getProject(principal, projectId); return store.limits(projectId); },
    finishChain(principal, traceId) {
      if (storeClosed) return;
      const trace = api.getTrace(principal, traceId), chain = chains.get(traceId);
      if (!chain || chain.inflight.size || chain.ended) return;
      const status = trace.spans.some(span => span.status === 'failed' || span.status === 'refused') ? 'failed'
        : trace.spans.some(span => span.status === 'partial') ? 'partial'
        : trace.spans.some(span => span.status === 'cancelled') ? 'cancelled' : 'succeeded';
      endChainIfIdle(chain, status);
    },
    boardProject: id => store.getProject(id),
    isA2aAgent,
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
      const project = store.setRepo(projectId, binding);
      if (o.provisionWorktrees) new GitWorktreeProvisioner(store, join(harnessHome, "state"), o.git).fork({ projectId });
      return project;
    },

    unbindRepo(principal, projectId) {
      requireLead(principal, projectId);
      return store.clearRepo(projectId);
    },

    addAgent(principal, projectId, agentId) {
      requireA2aOwner(principal, agentId);
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
      const turnKey = JSON.stringify([input.fromAgent, input.handoff?.context.taskId ?? null]);
      const callClass = input.callClass ?? 'read';
      const taskClass = input.taskClass ?? 'consult';
      requireA2aOwner(input.principal, input.toAgent);
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
        guard(chain, project, { fromAgent: input.fromAgent, toAgent: input.toAgent, path, question: input.question, parentSpanId, nextTokens, callClass, consult: true, turnKey });
      } catch (e) {
        throw e;
      }
      chain.fanout += 1;
      chain.readStarts.set(turnKey, (chain.readStarts.get(turnKey) ?? 0) + 1);
      chain.pairCounts.set(pairKey(turnKey, input.toAgent), (chain.pairCounts.get(pairKey(turnKey, input.toAgent)) ?? 0) + 1);
      store.rememberRepeat(repeatKey(input.fromAgent, input.toAgent, input.question), store.now());
      const spanId = chain.fanout === 1 ? chain.rootSpanId : newSpanId();
      const childPath = [...path, input.toAgent];
      store.insertSpan({ spanId, traceId: chain.traceId, parentSpanId, agentId: input.toAgent, kind: "consult", inputPreview: preview(input.question) });
      fire({ type: "consult.started", projectId: project.id, traceId: chain.traceId, agentId: input.toAgent, data: { fromAgent: input.fromAgent, spanId } });
      const local = new AbortController();
      chain.inflight.add(local);
      const signal = chainSignal(chain, input.signal ? AbortSignal.any([local.signal, input.signal]) : local.signal);
      if (input.signal?.aborted || chain.abort.signal.aborted) local.abort(new Error("aborted"));
      input.onAdmitted?.();
      try {
        const out = await runTarget(chain, project, input.toAgent, input.question, input.context, signal, input.principal, input.handoff, { spanId, fromAgent: input.fromAgent, path: childPath, callClass, taskClass }, input.outbound);
        chain.tokensUsed += out.inputTokens + out.outputTokens;
        budget.record({ tokens: out.inputTokens + out.outputTokens, projectId: project.id, agentId: input.toAgent, chainId: chain.traceId });
        store.finishSpan(spanId, {
          status: out.partial ? "partial" : "succeeded", outputPreview: preview(out.text), inputTokens: out.inputTokens, outputTokens: out.outputTokens, ...(out.targetKind ? { targetKind: out.targetKind } : {}), ...(out.origin ? { origin: out.origin } : {}),
        });
        fire({ type: "consult.finished", projectId: project.id, traceId: chain.traceId, agentId: input.toAgent, data: { spanId, status: "succeeded" } });
        return {
          kind: "consult.answer", status: out.partial ? "partial" : "done",
          text: out.text,
          provenance: {
            agentId: input.toAgent, projectId: project.id, traceId: chain.traceId, spanId,
            at: store.now(), cost: { inputTokens: out.inputTokens, outputTokens: out.outputTokens }, targetKind: out.targetKind ?? "local", ...(out.origin ? { origin: out.origin } : {}),
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
          if (chain.abort.signal.aborted) cancelChainInner(chain);
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
      const turnKey = JSON.stringify([input.fromAgent, input.handoff?.context.taskId ?? null]);
      const callClass = input.callClass ?? 'write';
      let reservation: WriterReservation | undefined;
      try {
      const taskClass = input.taskClass ?? 'code-small';
      requireA2aOwner(input.principal, input.toAgent);
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
        guard(chain, project, { fromAgent: input.fromAgent, toAgent: input.toAgent, path, question: input.task, parentSpanId, nextTokens, callClass, consult: false, turnKey });
      } catch (e) {
        throw e;
      }
      if (callClass === 'write') {
        const held = input.writerReservation ?? reserveWriter({ ...input, traceId: chain.traceId });
        try { useReservation(held, input); } catch (error) { if (!input.writerReservation) held.release(); throw error; }
        reservation = held;
      }
      chain.fanout += 1;
      if (callClass !== 'write') chain.readStarts.set(turnKey, (chain.readStarts.get(turnKey) ?? 0) + 1);
      store.rememberRepeat(repeatKey(input.fromAgent, input.toAgent, input.task), store.now());
      const spanId = chain.fanout === 1 ? chain.rootSpanId : newSpanId();
      const taskId = store.id("tsk");
      const childPath = [...path, input.toAgent];
      store.insertSpan({ spanId, traceId: chain.traceId, parentSpanId, agentId: input.toAgent, kind: "delegate", inputPreview: preview(input.task) });
      let queued: DelegateTask;
      try { queued = store.insertTask({
        id: taskId, projectId: project.id, traceId: chain.traceId, spanId, parentTaskId: input.parentTaskId ?? null,
        fromAgent: input.fromAgent, toAgent: input.toAgent, kind: "delegate", status: "queued",
        task: input.task, acceptance: input.acceptanceCriteria, path: childPath,
      }); } catch (error) {
        try { store.finishSpan(spanId, { status: 'failed', error: 'run-failed' }); } catch { /* preserve the original storage failure */ }
        throw error;
      }
      const local = new AbortController();
      chain.inflight.add(local);
      const signal = chainSignal(chain, input.signal ? AbortSignal.any([local.signal, input.signal]) : local.signal);
      // Admission reserved before persistence; setup and execution failures release the same identity-bound slot.
      fire({ type: "delegate.queued", projectId: project.id, traceId: chain.traceId, agentId: input.toAgent, data: { taskId, spanId } });

      input.onAdmitted?.();
      const done = (async (): Promise<DelegateTask> => {
        try {
          signal.throwIfAborted();
          store.updateTask(taskId, { status: "running" });
          fire({ type: "delegate.started", projectId: project.id, traceId: chain.traceId, agentId: input.toAgent, data: { taskId, spanId } });
          signal.throwIfAborted();
          const prompt = `${input.task}\n\nAcceptance criteria:\n${input.acceptanceCriteria}`;
          const out = await runTarget(chain, project, input.toAgent, prompt, "", signal, input.principal, input.handoff, { spanId, fromAgent: input.fromAgent, path: childPath, callClass, taskClass }, input.outbound);
          chain.tokensUsed += out.inputTokens + out.outputTokens;
          budget.record({ tokens: out.inputTokens + out.outputTokens, projectId: project.id, agentId: input.toAgent, chainId: chain.traceId });
          const art = artifacts.put({ projectId: project.id, body: out.text, contentType: "text/plain" });
          const cap = capReturn(out.text, project.settings.returnTokens, art.pointer);
          const result = cap.text;
          const finished = store.updateTask(taskId, {
            status: out.partial ? "cancelled" : "succeeded", error: out.partial ? "partial" : null, result, truncated: cap.truncated, artifactId: art.id,
            inputTokens: out.inputTokens, outputTokens: out.outputTokens, ...(out.targetKind ? { targetKind: out.targetKind } : {}), ...(out.origin ? { origin: out.origin } : {}),
          });
          store.finishSpan(spanId, {
            status: out.partial ? "partial" : "succeeded", outputPreview: preview(result), inputTokens: out.inputTokens, outputTokens: out.outputTokens, ...(out.targetKind ? { targetKind: out.targetKind } : {}), ...(out.origin ? { origin: out.origin } : {}),
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
          if (chain.abort.signal.aborted) cancelChainInner(chain);
          return finished;
        } finally {
          chain.inflight.delete(local);
          reservation?.release();
          if (chain.abort.signal.aborted) endChainIfIdle(chain, "cancelled");
        }
      })();

      return { task: queued, done };
      } catch (error) { reservation?.release(); throw error; }
    },

    replay(principal, traceId, spanId) {
      const trace = api.getTrace(principal, traceId);
      const span = trace.spans.find(s => s.spanId === spanId);
      const sessions = o.sessions?.();
      if (!span?.sessionId || !sessions) throw new CollabError('not-found', 'delegation transcript not found');
      const session = sessions.getSession(span.sessionId);
      if (!session || session.scope !== trace.projectId || session.owner !== `collab-project:${trace.projectId}`) throw new CollabError('not-found', 'delegation transcript not found');
      const stored = sessions.listEvents(session.id);
      const events = redact.value(stored);
      for (const [index, event] of stored.entries()) {
        const projected = events[index]!;
        const original = event.data.provenance;
        const safe = projected.data.provenance;
        // These IDs are already exposed by this authorized replay; arbitrary provenance stays redacted.
        if (original && typeof original === "object" && !Array.isArray(original)
          && safe && typeof safe === "object" && !Array.isArray(safe)) {
          if (Object.hasOwn(original, "traceId") && Object.hasOwn(safe, "traceId")
            && "traceId" in original && original.traceId === trace.traceId) Object.assign(safe, { traceId: trace.traceId });
          if (Object.hasOwn(original, "spanId") && Object.hasOwn(safe, "spanId")
            && "spanId" in original && original.spanId === span.spanId) Object.assign(safe, { spanId: span.spanId });
        }
      }
      return { sessionId: session.id, traceId, spanId, messages: redact.value(sessions.listMessages(session.id)), events };
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
