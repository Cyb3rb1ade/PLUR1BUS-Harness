import { readFile } from "node:fs/promises";
import { atomicJson } from "../../../media/src/files.ts";
import type { CallBudget } from "../budget/index.ts";
import type { MediaEvents, MediaHookLogger } from "./hook.ts";
import type { BudgetCallback, MediaIndexPort, MediaIndexStatus } from "./types.ts";

export const STATUS_EVENT = "media.index.status";

export interface BackfillConfig { enabled: boolean; provider?: string; backfill: "auto" | "manual" }

/** The engine asks this before every backfill step; false pauses it with pausedReason "budget". Null budget: never limits. */
export function createBudgetCallback(budget: CallBudget | null, who: { principal: string; agent: string; model?: string } = { principal: "media-backfill", agent: "media-backfill" }): BudgetCallback {
  return {
    async canContinue() {
      if (!budget) return true;
      const admitted = budget.checkBeforeCall({ principal: who.principal, agent: who.agent, project: "media-backfill", model: who.model ?? "media-index", estimatedInputTokens: 1, maxOutputTokens: 0 });
      if (admitted.kind === "refuse") return false;
      budget.releaseUnused(admitted.reservationId);
      return true;
    },
  };
}

export interface BackfillJobOptions {
  port: () => MediaIndexPort;
  config: () => BackfillConfig;
  /** The callback the port was built with (see `createBudgetCallback`); exposed as `budgetCallback`. Built here when omitted. */
  budgetCallback?: BudgetCallback;
  budget?: CallBudget | null;
  events: MediaEvents;
  logger: MediaHookLogger;
  /** `<home>/state/media-search.json`: the last fingerprint a backfill was started for. */
  stateFile: string;
  /** Status poll period; the timer is injectable so tests need no real clock. */
  pollMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
}
export interface BackfillJob {
  budgetCallback: BudgetCallback;
  /** At composition: resume an interrupted backfill, else start one for first enable or a changed fingerprint. */
  init(): Promise<"resumed" | "started" | "idle">;
  pause(): Promise<MediaIndexStatus>;
  resume(): Promise<MediaIndexStatus>;
  cancel(): Promise<MediaIndexStatus>;
  reindex(): Promise<MediaIndexStatus>;
  /** One status comparison; emits `media.index.status` when something changed. */
  poll(): Promise<MediaIndexStatus | null>;
  /** Start periodic polling; returns the stopper. */
  watch(): () => void;
  close(): void;
}

const defaultSchedule = (fn: () => void, ms: number) => { const t = setInterval(fn, ms); t.unref?.(); return () => clearInterval(t); };

export function createBackfillJob(o: BackfillJobOptions): BackfillJob {
  const budgetCallback = o.budgetCallback ?? createBudgetCallback(o.budget ?? null);
  let lastSeen = "";
  let stop: (() => void) | undefined;

  const readState = async (): Promise<{ fingerprint?: string }> => {
    try { const v = JSON.parse(await readFile(o.stateFile, "utf8")); return v && typeof v === "object" ? v : {}; } catch { return {}; }
  };
  const poll = async () => {
    try {
      const s = await o.port().status();
      const key = JSON.stringify([s.backfill.state, s.backfill.done, s.backfill.total, s.backfill.pausedReason, s.counts, s.fingerprint, s.enabled]);
      if (key !== lastSeen) { lastSeen = key; o.events.emit(STATUS_EVENT, { ...s }); }
      return s;
    } catch (e) { o.logger.warn("media index status poll failed", { message: e instanceof Error ? e.message : String(e) }); return null; }
  };
  const start = async (reason: "enable" | "model-change" | "manual", fingerprint: string) => {
    await o.port().backfill.start({ reason });
    await atomicJson(o.stateFile, { fingerprint });
  };
  const after = async (fn: () => Promise<void>) => { await fn(); return (await poll()) ?? o.port().status(); };

  return {
    budgetCallback,
    poll,
    async init() {
      const cfg = o.config();
      if (!cfg.enabled || cfg.provider === "off") return "idle";
      const status = await o.port().status();
      const bf = status.backfill;
      if (bf.state === "running" || (bf.state === "paused" && (bf.pausedReason === "budget" || bf.pausedReason === "error"))) {
        await o.port().backfill.resume();
        await poll();
        return "resumed";
      }
      if (bf.state === "paused") return "idle"; // user-paused stays paused
      if (cfg.backfill !== "auto") return "idle";
      const last = (await readState()).fingerprint;
      if (last === status.fingerprint) return "idle";
      if (last === undefined && bf.state === "done") { await atomicJson(o.stateFile, { fingerprint: status.fingerprint }); return "idle"; }
      await start(last === undefined ? "enable" : "model-change", status.fingerprint);
      await poll();
      return "started";
    },
    pause: () => after(() => o.port().backfill.pause()),
    resume: () => after(() => o.port().backfill.resume()),
    cancel: () => after(() => o.port().backfill.cancel()),
    reindex: () => after(async () => {
      await o.port().backfill.cancel();
      await start("manual", (await o.port().status()).fingerprint);
    }),
    watch() {
      stop?.();
      stop = (o.schedule ?? defaultSchedule)(() => { void poll(); }, o.pollMs ?? 2000);
      return () => { stop?.(); stop = undefined; };
    },
    close() { stop?.(); stop = undefined; },
  };
}
