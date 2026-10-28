import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { connect, engineAddress, readRecordedPid, readRunToken, RpcCallError, type ConnectOptions, type CoreClient } from "@plur1bus/module-api";
import {
  ERROR_CODES, type ErrorCode,
  type EngineMemoryStatsParams, type EngineMemoryPromoteParams,
  type EngineMemoryCurationListParams, type EngineMemoryCurationResolveParams, type EngineMemoryCurationResolveResult,
  type EngineContractMemoryCurationListResultData, type EngineContractMemoryPromotionResultData, type EngineContractMemoryStatsResultData,
} from "@plur1bus/rpc-schema";
import { assertEngineContract, CORE_CONTRACT } from "../engine.ts";
import { RpcError } from "../rpc/errors.ts";

export interface EngineClientOptions {
  home: string;
  address?: string;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** Forward engine events through the Core's existing host mapper and audience checks. */
  onEvent?: (name: E.EngineEventName, payload: unknown) => void;
}

/** The additive A1 members are already in RE-01's schema while the pinned TypeScript package still omits them. */
type RpcMemory = E.MemoryOps & {
  stats(ids: EngineMemoryStatsParams["ids"], p: E.Principal, a: E.AgentContext): Promise<EngineContractMemoryStatsResultData>;
  promote(req: EngineMemoryPromoteParams["req"], p: E.Principal, a: E.AgentContext): Promise<EngineContractMemoryPromotionResultData>;
  curation: {
    list(q: EngineMemoryCurationListParams["q"], p: E.Principal, a: E.AgentContext): Promise<EngineContractMemoryCurationListResultData>;
    resolve(id: string, action: EngineMemoryCurationResolveParams["action"], p: E.Principal, a: E.AgentContext): Promise<EngineMemoryCurationResolveResult>;
    keep(id: string, p: E.Principal, a: E.AgentContext): Promise<EngineMemoryCurationResolveResult>;
    drop(id: string, p: E.Principal, a: E.AgentContext): Promise<EngineMemoryCurationResolveResult>;
  };
};

type AsyncMethod = (...args: any[]) => Promise<any>;
type PendingCapture = {
  resolve: (result: E.CaptureResult) => void;
  reject: (error: Error) => void;
  remoteId?: string;
  aborted?: string;
  removeAbort: () => void;
  releaseAgent?: () => void;
};

const memoryErrors = new Set(["not-found", "denied", "invalid-input", "approval-required", "conflict", "storage", "unsupported", "identity-already-bound", "ledger-corrupt", "lock-lost"]);
const unavailable = () => new RpcError("E_NOT_AVAILABLE", "the memory engine is unavailable", { reason: "engine-unavailable" });

/** Signals and callbacks belong to this process. The wire contract contains only their data fields. */
function wire(value: unknown): unknown {
  if (value instanceof AbortSignal || typeof value === "function") return undefined;
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (Array.isArray(value)) return value.map(wire);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const encoded = wire(item);
    return encoded === undefined ? [] : [[key, encoded]];
  }));
  return value;
}

function rpcFailure(error: unknown, memory = false): Error {
  if (error instanceof RpcError) return error;
  if (error instanceof RpcCallError) {
    if (error.error === "E_CORE_UNAVAILABLE") return unavailable();
    if (memory && error.reason && memoryErrors.has(error.reason)) {
      return Object.assign(new Error(error.message), { name: "MemoryOpError", code: error.reason, ...(error.ids ? { detail: error.ids } : {}) });
    }
    return new RpcError(ERROR_CODES.includes(error.error as ErrorCode) ? error.error as ErrorCode : "E_INTERNAL", error.message, {
      ...(error.reason ? { reason: error.reason } : {}), ...(error.ids ? { ids: error.ids } : {}),
    });
  }
  return unavailable();
}

const initialModels = (): E.ModelsStatus => ({
  embedder: { state: "loading", warming: false, checkedAt: null, identity: { fingerprintId: "unavailable", provider: "unavailable", model: "unavailable", dimensions: 0 } },
  reranker: { state: "loading", warming: false, checkedAt: null, provider: null },
});

/** The Core's Engine implementation over the separately supervised engine's authenticated RPC endpoint.
 * Construction and synchronous readers never connect. A missing engine leaves the Core usable; the next operation
 * retries the endpoint. Only this client's connection is closed on Core shutdown: the supervisor owns the process. */
export class EngineClient implements E.Engine {
  readonly tools: E.ToolSpec[] = [];
  readonly commands: E.CommandSpec[] = [];
  private readonly options: EngineClientOptions;
  private readonly agentScopes = new Map<string, number>();
  private connection: CoreClient | undefined;
  private bootstrapConnection: CoreClient | undefined;
  private readonly shutdown = new AbortController();
  private servedEmbedding: E.EmbeddingServeResult | undefined;
  private connecting: Promise<CoreClient> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private version: E.ContractVersion = CORE_CONTRACT;
  private advertised: E.EngineCapabilities = Object.freeze({ memoryLink: false });
  private jobSpecs: E.JobSpec[] = [];
  private embeddingIdentities: E.EmbeddingIdentity[] = [];
  private modelStatus = initialModels();
  private supplement: string[] = [];
  private readonly channelNames = new Set<string>();
  private readonly listeners = new Map<E.EngineEventName, Set<(payload: unknown) => void>>();
  private readonly captures = new Set<PendingCapture>();
  private readonly capturesByRemoteId = new Map<string, PendingCapture>();
  private readonly earlyCaptureResults = new Map<string, E.CaptureResult>();

  constructor(options: EngineClientOptions) { this.options = options; }

  /** Reverse calls cannot charge an unrelated configured agent. Scope comes only from trusted outbound Core work. */
  canCompleteFor(agentId: string): boolean { return !this.closed && (this.agentScopes.get(agentId) ?? 0) > 0; }

  private holdAgent(agentId: unknown): () => void {
    if (this.closed || typeof agentId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(agentId)) return () => {};
    this.agentScopes.set(agentId, (this.agentScopes.get(agentId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      const count = this.agentScopes.get(agentId) ?? 0;
      if (count > 1) this.agentScopes.set(agentId, count - 1); else this.agentScopes.delete(agentId);
    };
  }

  get contract(): E.ContractVersion { return this.version; }
  get capabilities(): E.EngineCapabilities { return this.advertised; }

  private async client(): Promise<CoreClient> {
    if (this.closed) throw unavailable();
    if (this.connection) return this.connection;
    if (!this.connecting) {
      this.connecting = Promise.resolve().then(async () => {
        let client: CoreClient | undefined;
        try {
          const home = this.options.home;
          const opts: ConnectOptions = {
            address: this.options.address ?? engineAddress(home),
            token: readRunToken(home, join(home, "run", "engine.token")),
            endpoint: "engine", signal: this.shutdown.signal,
            ...(this.options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: this.options.connectTimeoutMs }),
            ...(this.options.callTimeoutMs === undefined ? {} : { callTimeoutMs: this.options.callTimeoutMs }),
            ...(this.options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: this.options.handshakeTimeoutMs }),
          };
          const pid = readRecordedPid(join(home, "run", "engine.pid"));
          if (pid !== undefined) opts.expectedServerPid = pid;
          client = await connect(opts);
          this.bootstrapConnection = client;
          assertEngineContract({ contract: (client.hello.contract ?? "") as E.ContractVersion });
          if (this.closed) { await client.close(); throw unavailable(); }
          this.version = client.hello.contract as E.ContractVersion;
          const flags = (client.hello as typeof client.hello & { engineCapabilities?: { memoryLink?: boolean } }).engineCapabilities;
          this.advertised = Object.freeze({ memoryLink: typeof flags?.memoryLink === "boolean" ? flags.memoryLink : client.supports("engine.memory.link") });
          client.onNotification((method, params) => this.notification(method, params));
          const connected = client;
          client.onClose(() => {
            if (this.connection === connected) this.connection = undefined;
            this.failCaptures(unavailable());
          });
          const [status, jobs, identities, supplement] = await Promise.all([
            client.call<E.EngineStatus>("engine.status"),
            client.call<E.JobSpec[]>("engine.jobs.list"),
            client.call<E.EmbeddingIdentity[]>("engine.embedding.identities"),
            client.call<string[]>("engine.systemSupplement"),
          ]);
          if (this.closed) { await client.close(); throw unavailable(); }
          this.modelStatus = status.models;
          this.jobSpecs = jobs;
          this.embeddingIdentities = identities;
          this.supplement = supplement;
          this.connection = client;
          this.bootstrapConnection = undefined;
          return client;
        } catch (error) {
          if (client) await client.close();
          if (this.bootstrapConnection === client) this.bootstrapConnection = undefined;
          throw rpcFailure(error);
        } finally { this.connecting = undefined; }
      });
    }
    return this.connecting;
  }

  private async call<T>(method: string, params: object = {}): Promise<T> {
    const attribution = params as { agentId?: string; principal?: E.Principal; p?: E.Principal; query?: E.RecallQuery };
    const release = this.holdAgent(attribution.agentId ?? attribution.principal?.agentId ?? attribution.p?.agentId ?? attribution.query?.principal?.agentId);
    try { return await (await this.client()).call<T>(method, wire(params) as object); }
    catch (error) { throw rpcFailure(error, method.startsWith("engine.memory.") || method.startsWith("engine.admin.")); }
    finally { release(); }
  }

  private method<F extends AsyncMethod>(method: string, names: readonly string[]): F {
    return ((...args: unknown[]) => this.call(method, Object.fromEntries(names.flatMap((name, i) => args[i] === undefined ? [] : [[name, args[i]]])))) as F;
  }

  async open(agentId: E.AgentId): Promise<E.AgentStore> {
    const release = this.holdAgent(agentId);
    try { await this.call("engine.open", { agentId }); }
    catch (error) { if (!(error instanceof RpcError) || error.error !== "E_NOT_AVAILABLE" || error.reason !== "engine-unavailable") { release(); throw error; } }
    let closing: Promise<void> | undefined;
    return { agentId, close: () => closing ??= (async () => {
      release();
      if (this.closed) return;
      try { await this.call("engine.agent.close", { agentId }); }
      catch (error) { if (!(error instanceof RpcError) || error.error !== "E_NOT_AVAILABLE" || error.reason !== "engine-unavailable") throw error; }
    })() };
  }

  close(opts?: { budgetMs?: number }): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.agentScopes.clear();
      this.shutdown.abort();
      this.failCaptures(unavailable());
      const client = this.connection ?? this.bootstrapConnection;
      this.connection = undefined;
      this.bootstrapConnection = undefined;
      this.listeners.clear();
      // The lifetime signal also cancels a connection still authenticating; its own catch closes a late result.
      void this.connecting?.catch(() => {});
      const cleanup = client?.close() ?? Promise.resolve();
      const requested = opts?.budgetMs ?? 30_000;
      const budgetMs = Number.isFinite(requested) ? Math.max(0, requested) : 30_000;
      this.closing = new Promise(resolve => {
        const timer = setTimeout(resolve, budgetMs);
        cleanup.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
      });
    }
    return this.closing;
  }

  async status(): Promise<E.EngineStatus> {
    try {
      const status = await this.call<E.EngineStatus>("engine.status");
      this.modelStatus = status.models;
      return status;
    } catch (error) {
      if (!(error instanceof RpcError) || error.error !== "E_NOT_AVAILABLE" || error.reason !== "engine-unavailable") throw error;
      return {
        ready: false, degraded: { reason: "engine-unavailable", capability: "engine" }, agents: 0,
        contract: this.contract, storeSchema: { current: null, expected: "unknown" },
        jobs: { ledger: "unavailable", agents: [] }, models: structuredClone(this.modelStatus), journal: null,
        sharedMemory: { supported: false, mode: "unavailable", reason: "platform" },
      };
    }
  }
  systemSupplement(): string[] { return [...this.supplement]; }
  recall(query: E.RecallQuery, options?: E.RecallOptions): Promise<E.RecallResult> {
    const started = performance.now();
    const aborted = (): E.RecallResult => ({
      blocks: [], capChars: query.budget?.capChars ?? 0, degraded: { reason: "aborted", capability: "recall" },
      timing: { phases: null, totalMs: performance.now() - started }, deferrals: [],
    });
    if (query.signal?.aborted) return Promise.resolve(aborted());
    const pending = this.call<E.RecallResult>("engine.recall", { query, ...(options ? { options } : {}) });
    if (!query.signal) return pending;
    return new Promise((resolve, reject) => {
      const signal = query.signal;
      const onAbort = () => { signal.removeEventListener("abort", onAbort); resolve(aborted()); };
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(result => { signal.removeEventListener("abort", onAbort); resolve(result); }, error => { signal.removeEventListener("abort", onAbort); reject(error); });
      if (signal.aborted) onAbort();
    });
  }
  checkpoint(agentId: E.AgentId, reason: E.CheckpointReason): Promise<E.CheckpointResult> { return this.call("engine.checkpoint", { agentId, reason }); }

  capture(turn: E.TurnRecord, options?: E.CaptureOptions): E.CaptureHandle {
    if (turn.signal.aborted) return {
      id: randomUUID(), acceptedAt: Date.now(),
      done: Promise.resolve({ stored: 0, skipped: 1, reason: "aborted" }), abort() {},
    };
    let resolve!: (result: E.CaptureResult) => void, reject!: (error: Error) => void;
    const done = new Promise<E.CaptureResult>((res, rej) => { resolve = res; reject = rej; });
    // Abandoning a handle is supported by the Engine contract; rejection still reaches anyone awaiting the original.
    void done.catch(() => {});
    const pending: PendingCapture = { resolve, reject, removeAbort: () => {}, releaseAgent: this.holdAgent(turn.principal.agentId) };
    this.captures.add(pending);
    const abort = (reason = "aborted") => {
      if (!this.captures.has(pending)) return;
      pending.aborted = reason;
      if (pending.remoteId) void this.call("engine.capture.abort", { id: pending.remoteId, reason }).catch(error => this.finishCapture(pending, undefined, rpcFailure(error)));
    };
    const onAbort = () => abort(typeof turn.signal.reason === "string" ? turn.signal.reason : "aborted");
    turn.signal.addEventListener("abort", onAbort, { once: true });
    pending.removeAbort = () => turn.signal.removeEventListener("abort", onAbort);
    if (turn.signal.aborted) onAbort();
    const handle: E.CaptureHandle = { id: randomUUID(), acceptedAt: Date.now(), done, abort };
    const acceptance = (async () => {
      const client = await this.client();
      if (!this.captures.has(pending)) return undefined;
      if (pending.aborted !== undefined) {
        this.finishCapture(pending, { stored: 0, skipped: 1, reason: "aborted" });
        return undefined;
      }
      // Check cancellation after lazy bootstrap and dispatch in this same turn: nothing can interleave here.
      return client.call<{ id: string; acceptedAt: number }>("engine.capture", wire({ turn, ...(options ? { options } : {}) }) as object);
    })();
    void acceptance.then(accepted => {
      if (!accepted || !this.captures.has(pending)) return;
      pending.remoteId = accepted.id;
      this.capturesByRemoteId.set(accepted.id, pending);
      if (this.earlyCaptureResults.has(accepted.id)) {
        const result = this.earlyCaptureResults.get(accepted.id)!;
        this.earlyCaptureResults.delete(accepted.id);
        this.finishCapture(pending, result);
      } else if (pending.aborted !== undefined) abort(pending.aborted);
    }, error => this.finishCapture(pending, undefined, rpcFailure(error)));
    return handle;
  }

  private finishCapture(pending: PendingCapture, result?: E.CaptureResult, error?: Error): void {
    if (!this.captures.delete(pending)) return;
    pending.removeAbort();
    pending.releaseAgent?.();
    if (pending.remoteId) this.capturesByRemoteId.delete(pending.remoteId);
    if (error) pending.reject(error); else pending.resolve(result!);
  }
  private failCaptures(error: Error): void {
    for (const pending of this.captures) this.finishCapture(pending, undefined, error);
    this.earlyCaptureResults.clear();
  }
  private notification(method: string, value: unknown): void {
    if (!value || typeof value !== "object") return;
    const params = value as Record<string, unknown>;
    if (method === "engine.capture.done" && typeof params.id === "string" && params.result && typeof params.result === "object") {
      const pending = this.capturesByRemoteId.get(params.id);
      if (pending) this.finishCapture(pending, params.result as E.CaptureResult);
      // A result can precede the acceptance reply. Bound that race buffer by the number of locally pending captures.
      else if (this.earlyCaptureResults.size < this.captures.size) this.earlyCaptureResults.set(params.id, params.result as E.CaptureResult);
    } else if (method === "engine.event" && typeof params.name === "string") {
      try { this.options.onEvent?.(params.name as E.EngineEventName, params.payload); } catch { /* the host observer never breaks transport or local listeners */ }
      for (const listener of this.listeners.get(params.name as E.EngineEventName) ?? []) {
        try { listener(params.payload); } catch { /* event observers do not break the transport */ }
      }
    }
  }

  readonly jobs: E.JobRegistry = {
    list: () => this.jobSpecs.map(job => ({ ...job })),
    run: (job, agentId, options) => this.call("engine.jobs.run", { job, agentId, ...(options?.trigger === undefined ? {} : { trigger: options.trigger }), ...(options?.dryRun === undefined ? {} : { dryRun: options.dryRun }) }),
    history: (agentId, options) => this.call("engine.jobs.history", { agentId, ...options }),
  };
  readonly embedding: E.EmbeddingService & { local: Record<string, unknown> } = {
    local: {},
    embed: async (texts, options) => (await this.call<number[][]>("engine.embedding.embed", { texts, kind: options.kind, identity: options.identity })).map(vector => Float32Array.from(vector)),
    rerank: (query, docs, options) => this.call("engine.embedding.rerank", { query, docs, topN: options.topN }),
    probe: options => this.call("engine.embedding.probe", { ...(options?.refresh === undefined ? {} : { refresh: options.refresh }) }),
    identities: () => this.embeddingIdentities.map(identity => ({ ...identity })),
    serve: async address => {
      const result = await this.call<Omit<E.EmbeddingServeResult, "dispose">>("engine.embedding.serve", { ...(address === undefined ? {} : { address }) });
      if (this.servedEmbedding) {
        const { dispose: _dispose, ...previous } = this.servedEmbedding;
        if (isDeepStrictEqual(previous, result)) return this.servedEmbedding;
      }
      const served: E.EmbeddingServeResult = { ...result, dispose: () => {
        if (this.servedEmbedding !== served || result.address === null || this.closed) return;
        this.servedEmbedding = undefined;
        void this.call("engine.embedding.serve", { address: null }).catch(() => {});
      } };
      this.servedEmbedding = served;
      return served;
    },
  };
  readonly models: E.ModelsService = {
    status: () => structuredClone(this.modelStatus),
    warm: async options => {
      const status = await this.call<E.ModelsStatus>("engine.models.warm", { ...(options?.refresh === undefined ? {} : { refresh: options.refresh }) });
      this.modelStatus = status; return status;
    },
  };
  readonly events: E.EngineEvents = {
    on: (event, handler) => {
      let handlers = this.listeners.get(event);
      if (!handlers) { handlers = new Set(); this.listeners.set(event, handlers); }
      handlers.add(handler);
      return { dispose: () => { handlers.delete(handler); if (!handlers.size) this.listeners.delete(event); } };
    },
  };
  readonly channels: E.Engine["channels"] = {
    register: name => { this.channelNames.add(name); return name; },
    has: name => this.channelNames.has(name), list: () => [...this.channelNames],
  };
  runCommand: E.Engine["runCommand"] = async () => { throw new RpcError("E_NOT_AVAILABLE", "legacy engine commands are unavailable", { reason: "engine-command-unsupported" }); };

  readonly memory: RpcMemory = {
    stats: this.method<RpcMemory["stats"]>("engine.memory.stats", ["ids", "p", "a"]),
    promote: this.method<RpcMemory["promote"]>("engine.memory.promote", ["req", "p", "a"]),
    curation: {
      list: this.method<RpcMemory["curation"]["list"]>("engine.memory.curation.list", ["q", "p", "a"]),
      resolve: this.method<RpcMemory["curation"]["resolve"]>("engine.memory.curation.resolve", ["id", "action", "p", "a"]),
      keep: this.method<RpcMemory["curation"]["keep"]>("engine.memory.curation.keep", ["id", "p", "a"]),
      drop: this.method<RpcMemory["curation"]["drop"]>("engine.memory.curation.drop", ["id", "p", "a"]),
    },
    list: this.method<E.MemoryOps["list"]>("engine.memory.list", ["q", "p", "a"]),
    show: this.method<E.MemoryOps["show"]>("engine.memory.show", ["id", "p", "a"]),
    forget: this.method<E.MemoryOps["forget"]>("engine.memory.forget", ["id", "p", "a"]),
    correct: this.method<E.MemoryOps["correct"]>("engine.memory.correct", ["id", "newText", "p", "a"]),
    share: this.method<E.MemoryOps["share"]>("engine.memory.share", ["id", "target", "p", "a", "opts"]),
    state: this.method<E.MemoryOps["state"]>("engine.memory.state", ["p", "a"]),
    propose: this.method<E.MemoryOps["propose"]>("engine.memory.propose", ["sharedId", "newText", "p", "a", "opts"]),
    proposals: {
      list: this.method<E.MemoryOps["proposals"]["list"]>("engine.memory.proposals.list", ["q", "p", "a"]),
      accept: this.method<E.MemoryOps["proposals"]["accept"]>("engine.memory.proposals.accept", ["proposalId", "p", "a"]),
      reject: this.method<E.MemoryOps["proposals"]["reject"]>("engine.memory.proposals.reject", ["proposalId", "p", "a", "opts"]),
    },
    import: this.method<E.MemoryOps["import"]>("engine.memory.import", ["req", "p", "a"]),
    rebind: this.method<E.MemoryOps["rebind"]>("engine.memory.rebind", ["req", "p", "a"]),
    unbind: this.method<E.MemoryOps["unbind"]>("engine.memory.unbind", ["req", "p", "a"]),
    unimport: this.method<E.MemoryOps["unimport"]>("engine.memory.unimport", ["req", "p", "a"]),
    link: this.method<E.MemoryOps["link"]>("engine.memory.link", ["id", "req", "p", "a"]),
  };

  readonly admin: E.AdminOps = {
    share: this.method<E.AdminOps["share"]>("engine.admin.share", ["id", "target", "p", "a", "opts"]),
    forget: this.method<E.AdminOps["forget"]>("engine.admin.forget", ["id", "p", "a"]),
    reembedding: {
      plan: this.method<E.AdminOps["reembedding"]["plan"]>("engine.admin.reembedding.plan", ["request"]),
      apply: this.method<E.AdminOps["reembedding"]["apply"]>("engine.admin.reembedding.apply", ["request"]),
      resume: this.method<E.AdminOps["reembedding"]["resume"]>("engine.admin.reembedding.resume", ["request"]),
      validate: this.method<E.AdminOps["reembedding"]["validate"]>("engine.admin.reembedding.validate", ["request"]),
      rollback: this.method<E.AdminOps["reembedding"]["rollback"]>("engine.admin.reembedding.rollback", []),
      status: this.method<E.AdminOps["reembedding"]["status"]>("engine.admin.reembedding.status", ["id"]),
      switch: this.method<E.AdminOps["reembedding"]["switch"]>("engine.admin.reembedding.switch", []),
    },
    workspacePolicy: {
      get: this.method<E.AdminOps["workspacePolicy"]["get"]>("engine.admin.workspacePolicy.get", []),
      list: this.method<E.AdminOps["workspacePolicy"]["list"]>("engine.admin.workspacePolicy.list", []),
      set: this.method<E.AdminOps["workspacePolicy"]["set"]>("engine.admin.workspacePolicy.set", ["patch"]),
    },
    migrate: this.method<E.AdminOps["migrate"]>("engine.admin.migrate", ["from", "to"]),
    obsidian: {
      detect: this.method<E.AdminOps["obsidian"]["detect"]>("engine.admin.obsidian.detect", ["p", "a", "opts"]),
      prepare: this.method<E.AdminOps["obsidian"]["prepare"]>("engine.admin.obsidian.prepare", ["vaultPath", "p", "a"]),
      confirm: this.method<E.AdminOps["obsidian"]["confirm"]>("engine.admin.obsidian.confirm", ["nonce", "p", "a"]),
    },
  };

  readonly stores: E.StoreOps = {
    adopt: this.method<E.StoreOps["adopt"]>("engine.stores.adopt", ["req"]),
  };
}
