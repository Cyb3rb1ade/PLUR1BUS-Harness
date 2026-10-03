// Discovery service: orchestration, single-flight, error handling, events, state (spec §2.2, §2.9, R6, R12, R13, R16; plan Task 6).
import { randomUUID } from "node:crypto";
import type {
  CatalogFile,
  CatalogModel,
  ModelKind,
  ModelStatus,
  ProviderScanState,
  RunTrigger,
  ScanErrorInfo,
  ScanOutcomeCode,
  ScanResultCode,
  ScanWarning,
} from "./types.ts";
import type { Clock, CredentialLease, CredentialResolver, DiscoveryEvents, ProfileInfo, ProfileSource, Rng } from "./ports.ts";
import { CredentialUnavailableError } from "./ports.ts";
import type { CatalogStore } from "./catalog-store.ts";
import type { CompiledTable } from "./metadata.ts";
import { createPinnedClient, ScanError } from "./http.ts";
import { SCANNERS } from "./scanners/index.ts";
import { reconcile } from "./reconcile.ts";
import { applyOverride, CatalogError, removeManualEntry, type SetOverride } from "./overrides.ts";
import { roleWarnings } from "./roles.ts";
import { nextRegularAt, retryDelayMs } from "./schedule.ts";

export interface ScanSettings {
  enabled: boolean;
  intervalHours: number;
}

export interface DiscoveryServiceDeps {
  store: CatalogStore;
  profiles: ProfileSource;
  credentials: CredentialResolver;
  events: DiscoveryEvents;
  clock: Clock;
  rng: Rng;
  table: CompiledTable;
  roles: () => Readonly<Record<string, string>>;
  settings: () => ScanSettings;
  logger: {
    debug(m: string, f?: object): void;
    info(m: string, f?: object): void;
    warn(m: string, f?: object): void;
  };
  scanners?: Partial<typeof SCANNERS>;
  makeClient?: typeof createPinnedClient;
  traceId?: () => string;
  runId?: () => string;
  userAgent?: string;
  maxParallel?: number;
}

export interface ScanRequest {
  trigger: RunTrigger;
  signal?: AbortSignal;
  runId?: string;
}

export interface ProviderScanResult {
  provider: string;
  result: ScanOutcomeCode;
  runningRunId?: string;
  new: string[];
  reappeared: string[];
  unavailable: string[];
  unchanged: number;
  duplicates: number;
  warnings: ScanWarning[];
  nextScanAt: string | null;
  error?: ScanErrorInfo;
}

export interface ModelEntry extends Omit<CatalogModel, "api"> {}

export interface ListQuery {
  provider?: string;
  kind?: ModelKind;
  status?: ModelStatus;
  newOnly?: boolean;
}

export interface ModelsList {
  models: ModelEntry[];
  providers: (ProviderScanState & { provider: string })[];
  newCount: number;
  warnings: ScanWarning[];
}

export interface ModelsChanged {
  provider: string;
  discovered: string[];
  reappeared: string[];
  unavailable: string[];
  at: string;
}

export interface DiscoveryService {
  scanProvider(provider: string, r: ScanRequest): Promise<ProviderScanResult>;
  scanAll(r: ScanRequest, only?: string): Promise<ProviderScanResult[]>;
  list(q: ListQuery): ModelsList;
  setOverride(p: SetOverride): Promise<ModelEntry>;
  removeManual(provider: string, id: string): Promise<{ removed: true }>;
  acknowledge(): Promise<{ acknowledgedAt: string }>;
  onChanged(cb: (e: ModelsChanged) => void): () => void;
  nextRunAt(): number | null;
  scannable(): ProfileInfo[];
}

export function createDiscoveryService(deps: DiscoveryServiceDeps): DiscoveryService {
  const inFlight = new Map<string, { runId: string }>();
  const changeListeners = new Set<(e: ModelsChanged) => void>();

  function scannable(): ProfileInfo[] {
    return deps.profiles.list().filter((p) => p.discovery !== "manual");
  }

  async function scanProvider(provider: string, r: ScanRequest): Promise<ProviderScanResult> {
    const profile = deps.profiles.list().find((p) => p.id === provider);
    if (!profile) {
      throw new CatalogError("not-found");
    }

    const catBefore = deps.store.read();
    const existingSt = catBefore.providers[provider];

    if (inFlight.has(provider)) {
      return {
        provider,
        result: "already_running",
        runningRunId: inFlight.get(provider)!.runId,
        new: [],
        reappeared: [],
        unavailable: [],
        unchanged: 0,
        duplicates: 0,
        warnings: [],
        nextScanAt: existingSt?.nextScanAt ?? null,
      };
    }

    const settings = deps.settings();
    if (!settings.enabled) {
      return {
        provider,
        result: "disabled",
        new: [],
        reappeared: [],
        unavailable: [],
        unchanged: 0,
        duplicates: 0,
        warnings: [],
        nextScanAt: existingSt?.nextScanAt ?? null,
      };
    }

    if (profile.discovery === "manual") {
      return {
        provider,
        result: "no-scanner",
        new: [],
        reappeared: [],
        unavailable: [],
        unchanged: 0,
        duplicates: 0,
        warnings: [],
        nextScanAt: existingSt?.nextScanAt ?? null,
      };
    }

    const scanners = deps.scanners ?? SCANNERS;
    const scanner = scanners[profile.discovery];
    if (!scanner) {
      return {
        provider,
        result: "no-scanner",
        new: [],
        reappeared: [],
        unavailable: [],
        unchanged: 0,
        duplicates: 0,
        warnings: [],
        nextScanAt: existingSt?.nextScanAt ?? null,
      };
    }

    const runId = r.runId ?? deps.runId?.() ?? randomUUID();
    const traceId = deps.traceId?.() ?? randomUUID();
    inFlight.set(provider, { runId });

    try {
      const nowMs = deps.clock.now();
      const nowIso = new Date(nowMs).toISOString();
      const startMs = nowMs;

      const prevConsecutive = r.trigger === "manual" ? 0 : (existingSt?.consecutiveFailures ?? 0);

      let lease: CredentialLease | null = null;
      try {
        const origin = new URL(profile.baseUrl).origin;
        lease = await deps.credentials.resolve(profile.id, origin);
      } catch (err: unknown) {
        if (err instanceof CredentialUnavailableError) {
          throw new ScanError("failed:auth", err.reason, { httpStatus: 401 });
        }
        throw err;
      }

      const client = (deps.makeClient ?? createPinnedClient)({
        baseUrl: profile.baseUrl,
        lease,
        userAgent: deps.userAgent ?? "plur1bus/0.1.0",
        ...(r.signal !== undefined ? { signal: r.signal } : {}),
      });

      const output = await scanner(profile, client);

      if (output.entries.length === 0) {
        throw new ScanError("failed:empty" as unknown as ScanError["result"], "empty_list");
      }

      const rec = reconcile({
        catalog: deps.store.read(),
        provider,
        raw: output.entries,
        now: nowIso,
        table: deps.table,
        roles: deps.roles(),
        ...(profile.vendor !== undefined ? { vendor: profile.vendor } : {}),
      });

      const nextScanAtMs = nextRegularAt(nowMs, settings.intervalHours, deps.rng);
      const nextScanAtIso = new Date(nextScanAtMs).toISOString();

      try {
        await deps.store.mutate((c) => {
          const updatedState: ProviderScanState = {
            ...c.providers[provider],
            lastScanAt: nowIso,
            lastResult: "ok",
            nextScanAt: nextScanAtIso,
          };
          delete updatedState.consecutiveFailures;

          const nextProviders: Record<string, ProviderScanState> = {
            ...c.providers,
            [provider]: updatedState,
          };
          return {
            next: {
              ...rec.catalog,
              providers: nextProviders,
            },
            result: null,
          };
        });
      } catch (writeErr) {
        deps.logger.warn("failed to persist catalog after scan", { error: String(writeErr) });
        return {
          provider,
          result: "ok",
          new: rec.new,
          reappeared: rec.reappeared,
          unavailable: rec.unavailable,
          unchanged: rec.unchanged,
          duplicates: output.duplicates,
          warnings: rec.warnings,
          nextScanAt: new Date(nowMs + 300_000).toISOString(),
        };
      }

      const discoveredCount = rec.new.length + rec.reappeared.length;
      if (discoveredCount > 0) {
        deps.events.discovered({
          provider,
          count: discoveredCount,
          models: rec.new.slice(0, 20),
          reappeared: rec.reappeared.slice(0, 20),
          truncated: rec.new.length > 20 || rec.reappeared.length > 20,
          traceId,
        });
      }

      if (rec.unavailable.length > 0) {
        const affectedRoles = rec.warnings
          .filter((w) => w.code === "role_unavailable")
          .map((w) => (w as { role: string }).role);
        deps.events.unavailable({
          provider,
          count: rec.unavailable.length,
          models: rec.unavailable.slice(0, 20),
          roles: affectedRoles,
          truncated: rec.unavailable.length > 20,
          traceId,
        });
      }

      deps.events.scanCompleted({
        provider,
        result: "ok",
        durationMs: deps.clock.now() - startMs,
        counts: {
          new: rec.new.length,
          reappeared: rec.reappeared.length,
          unavailable: rec.unavailable.length,
          unchanged: rec.unchanged,
          duplicates: output.duplicates,
        },
        traceId,
      });

      if (rec.new.length > 0 || rec.reappeared.length > 0 || rec.unavailable.length > 0) {
        const changeEvent: ModelsChanged = {
          provider,
          discovered: rec.new,
          reappeared: rec.reappeared,
          unavailable: rec.unavailable,
          at: nowIso,
        };
        for (const listener of changeListeners) {
          try {
            listener(changeEvent);
          } catch {
            /* ignore */
          }
        }
      }

      return {
        provider,
        result: "ok",
        new: rec.new,
        reappeared: rec.reappeared,
        unavailable: rec.unavailable,
        unchanged: rec.unchanged,
        duplicates: output.duplicates,
        warnings: rec.warnings,
        nextScanAt: nextScanAtIso,
      };
    } catch (err: unknown) {
      let scanResult: ScanResultCode = "failed:network";
      let httpStatus: number | undefined;
      let retryAfterMs: number | undefined;
      let reason = "unknown";
      let retryable = false;
      let hint = "";
      let scanCode: ScanErrorInfo["code"] = "network";

      if (err instanceof ScanError) {
        scanResult = err.result;
        reason = err.reason;
        httpStatus = err.httpStatus;
        retryAfterMs = err.retryAfterMs;
      } else if ((err as { result?: ScanResultCode })?.result === "failed:empty") {
        scanResult = "failed:empty";
        reason = "empty_list";
      } else {
        reason = err instanceof Error ? err.message : String(err);
      }

      if (scanResult === "failed:auth") {
        scanCode = "auth";
        retryable = false;
        hint = `renew sign-in: plur1bus login ${provider}`;
      } else if (scanResult === "failed:invalid") {
        scanCode = "invalid-request";
        retryable = false;
        hint = reason;
      } else if (scanResult === "failed:empty") {
        scanCode = "invalid-request";
        retryable = false;
        hint = "empty list";
      } else if (scanResult === "failed:server") {
        scanCode = reason === "rate_limited" ? "rate-limited" : "server";
        retryable = true;
        hint = reason;
      } else {
        scanCode = reason.includes("timeout") ? "timeout" : "network";
        retryable = true;
        hint = reason;
      }

      const prevConsecutive = r.trigger === "manual" ? 0 : (existingSt?.consecutiveFailures ?? 0);
      let newFailures = prevConsecutive;
      let nextScanAtIso: string;

      if (retryable) {
        newFailures = prevConsecutive + 1;
        const delay = retryDelayMs(newFailures, retryAfterMs, deps.rng);
        nextScanAtIso = new Date(deps.clock.now() + delay).toISOString();
      } else {
        const nextAt = nextRegularAt(deps.clock.now(), settings.intervalHours, deps.rng);
        nextScanAtIso = new Date(nextAt).toISOString();
      }

      const scanErrorInfo: ScanErrorInfo = {
        code: scanCode,
        reason,
        retryable,
        hint,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterS: Math.round(retryAfterMs / 1000) } : {}),
      };

      try {
        await deps.store.mutate((c) => {
          const prevSt = c.providers[provider];
          const updatedState: ProviderScanState = {
            ...prevSt,
            lastResult: scanResult,
            nextScanAt: nextScanAtIso,
            ...(newFailures > 0 ? { consecutiveFailures: newFailures } : {}),
          };
          if (newFailures === 0 && "consecutiveFailures" in updatedState) {
            delete updatedState.consecutiveFailures;
          }
          const nextProviders: Record<string, ProviderScanState> = {
            ...c.providers,
            [provider]: updatedState,
          };
          return {
            next: {
              ...c,
              providers: nextProviders,
            },
            result: null,
          };
        });
      } catch (_writeErr) {
        return {
          provider,
          result: scanResult,
          new: [],
          reappeared: [],
          unavailable: [],
          unchanged: 0,
          duplicates: 0,
          warnings: [],
          nextScanAt: new Date(deps.clock.now() + 300_000).toISOString(),
          error: scanErrorInfo,
        };
      }

      deps.events.scanFailed({
        provider,
        result: scanResult,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterS: Math.round(retryAfterMs / 1000) } : {}),
        nextScanAt: nextScanAtIso,
        consecutiveFailures: newFailures,
        err: scanErrorInfo,
        traceId,
      });

      return {
        provider,
        result: scanResult,
        new: [],
        reappeared: [],
        unavailable: [],
        unchanged: 0,
        duplicates: 0,
        warnings: [],
        nextScanAt: nextScanAtIso,
        error: scanErrorInfo,
      };
    } finally {
      inFlight.delete(provider);
    }
  }

  async function scanAll(r: ScanRequest, only?: string): Promise<ProviderScanResult[]> {
    if (only !== undefined) {
      return [await scanProvider(only, r)];
    }
    const targets = scannable().map((p) => p.id);
    const results: ProviderScanResult[] = [];
    const limit = deps.maxParallel ?? 4;
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, targets.length) }, async () => {
      while (idx < targets.length) {
        const p = targets[idx++]!;
        const res = await scanProvider(p, r);
        results.push(res);
      }
    });
    await Promise.all(workers);
    return results;
  }

  function list(q: ListQuery): ModelsList {
    const cat = deps.store.read();
    let models = cat.models;

    if (q.provider !== undefined) {
      models = models.filter((m) => m.provider === q.provider);
    }
    if (q.kind !== undefined) {
      models = models.filter((m) => m.kind === q.kind);
    }
    if (q.status !== undefined) {
      models = models.filter((m) => m.status === q.status);
    }
    if (q.newOnly) {
      models = models.filter(
        (m) =>
          m.status === "available" &&
          m.source !== "manual" &&
          (cat.acknowledgedAt === undefined || m.firstSeen > cat.acknowledgedAt),
      );
    }

    const cleanModels: ModelEntry[] = models.map((m) => {
      const { api: _api, ...rest } = m;
      void _api;
      return rest;
    });

    const newCount = cat.models.filter(
      (m) =>
        m.status === "available" &&
        m.source !== "manual" &&
        (cat.acknowledgedAt === undefined || m.firstSeen > cat.acknowledgedAt),
    ).length;

    const providers = Object.entries(cat.providers).map(([provider, st]) => ({
      provider,
      ...st,
    }));

    const warnings = roleWarnings(cat, deps.roles(), q.provider);

    return {
      models: cleanModels,
      providers,
      newCount,
      warnings,
    };
  }

  async function setOverride(p: SetOverride): Promise<ModelEntry> {
    const nowIso = new Date(deps.clock.now()).toISOString();
    const profile = deps.profiles.list().find((x) => x.id === p.provider);
    return await deps.store.mutate((c) => {
      const res = applyOverride(c, p, nowIso, deps.table, profile?.vendor);
      const { api: _api, ...clean } = res.entry;
      void _api;
      return { next: res.catalog, result: clean };
    });
  }

  async function removeManual(provider: string, id: string): Promise<{ removed: true }> {
    return await deps.store.mutate((c) => {
      const next = removeManualEntry(c, provider, id);
      return { next, result: { removed: true as const } };
    });
  }

  async function acknowledge(): Promise<{ acknowledgedAt: string }> {
    const nowIso = new Date(deps.clock.now()).toISOString();
    return await deps.store.mutate((c) => {
      const next = { ...c, acknowledgedAt: nowIso };
      return { next, result: { acknowledgedAt: nowIso } };
    });
  }

  function onChanged(cb: (e: ModelsChanged) => void): () => void {
    changeListeners.add(cb);
    return () => {
      changeListeners.delete(cb);
    };
  }

  function nextRunAt(): number | null {
    const scannableIds = new Set(scannable().map((p) => p.id));
    const cat = deps.store.read();
    const dates: number[] = [];
    for (const [id, st] of Object.entries(cat.providers)) {
      if (scannableIds.has(id) && st.nextScanAt) {
        const t = Date.parse(st.nextScanAt);
        if (Number.isFinite(t)) dates.push(t);
      }
    }
    if (dates.length === 0) return null;
    return Math.min(...dates);
  }

  return {
    scanProvider,
    scanAll,
    list,
    setOverride,
    removeManual,
    acknowledge,
    onChanged,
    nextRunAt,
    scannable,
  };
}
