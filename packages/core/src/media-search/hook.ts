import { isDisabledMediaIndex } from "./disabled.ts";
import type { CaptionService } from "./caption/service.ts";
import type { MediaIndexPort, MediaKind, MediaSource, Scope } from "./types.ts";

/** A medium that entered (or left) the store. `prompt` is the generation/edit prompt, `userCaption` the upload's alt text. */
export interface MediaRecord {
  mediaId: string; kind: MediaKind; mime: string; source: MediaSource;
  agentId?: string; prompt?: string; userCaption?: string;
}
export interface MediaEvents { emit(name: string, payload: Record<string, unknown>): void }
export interface MediaCounters { indexFailed(stage: "caption" | "index" | "remove"): void }
export interface MediaHookLogger { warn(msg: string, fields?: Record<string, unknown>): void }
export interface MediaHookConfig { enabled: boolean; provider?: string }

export const INDEX_FAILED_EVENT = "media.index.failed";

export interface MediaIndexHookOptions {
  port: () => MediaIndexPort;
  captions: CaptionService;
  config: () => MediaHookConfig;
  scopeOf: (record: MediaRecord) => Scope | Promise<Scope>;
  events: MediaEvents;
  counters: MediaCounters;
  logger: MediaHookLogger;
  /** Parallel index jobs (default 2). */
  concurrency?: number;
  /** One job gives up waiting after this long (default 15 minutes); 0 disables. */
  timeoutMs?: number;
}
export interface MediaIndexHook {
  onStored(record: MediaRecord): void;
  onUploaded(record: MediaRecord): void;
  onDeleted(mediaId: string): void;
  /** Resolves when the queue is drained (tests, shutdown). */
  idle(): Promise<void>;
}

export function createMediaIndexHook(o: MediaIndexHookOptions): MediaIndexHook {
  const limit = Math.max(1, o.concurrency ?? 2);
  const timeoutMs = o.timeoutMs ?? 15 * 60_000;
  const queue: (() => Promise<void>)[] = [];
  let active = 0;
  let waiters: (() => void)[] = [];

  const usablePort = () => {
    const cfg = o.config();
    if (!cfg.enabled || cfg.provider === "off") return undefined;
    const port = o.port();
    return isDisabledMediaIndex(port) ? undefined : port;
  };
  const fail = (stage: "caption" | "index" | "remove", mediaId: string, kind: MediaKind | undefined, e: unknown) => {
    const code = (e as { code?: unknown })?.code;
    const message = e instanceof Error ? e.message : String(e);
    try {
      o.counters.indexFailed(stage);
      o.events.emit(INDEX_FAILED_EVENT, { mediaId, stage, ...(kind ? { kind } : {}), ...(typeof code === "string" ? { code } : {}), message });
      o.logger.warn("media index failed", { mediaId, stage, message });
    } catch { /* reporting must not throw into the queue */ }
  };
  const withTimeout = <T>(p: Promise<T>): Promise<T> => {
    if (!timeoutMs) return p;
    let t: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("media index timed out")), timeoutMs); t.unref?.(); });
    return Promise.race([p, timeout]).finally(() => clearTimeout(t));
  };

  const pump = () => {
    while (active < limit && queue.length) {
      const job = queue.shift()!;
      active++;
      void job().finally(() => {
        active--;
        pump();
        if (!active && !queue.length) { const w = waiters; waiters = []; w.forEach(r => r()); }
      });
    }
  };
  const enqueue = (job: () => Promise<void>) => { queue.push(job); queueMicrotask(pump); };

  const index = (record: MediaRecord, withPrompt: boolean) => enqueue(async () => {
    try {
      const port = usablePort();
      if (!port) return;
      let caption: { text: string; source: "prompt" | "user" | "auto" } | null = null;
      try {
        caption = await o.captions.resolve({ kind: record.kind, mime: record.mime, source: record.source, ...(withPrompt && record.prompt ? { prompt: record.prompt } : {}), ...(record.userCaption ? { userCaption: record.userCaption } : {}) });
      } catch (e) { fail("caption", record.mediaId, record.kind, e); }
      const scope = await o.scopeOf(record);
      const res = await withTimeout(port.index({ mediaId: record.mediaId, kind: record.kind, mime: record.mime, source: record.source, scope, ...(caption ? { caption: caption.text, captionSource: caption.source } : {}) }));
      if (res.state === "failed") fail("index", record.mediaId, record.kind, new Error("index state failed"));
    } catch (e) { fail("index", record.mediaId, record.kind, e); }
  });

  return {
    onStored: record => index(record, true),
    onUploaded: record => index(record, false),
    onDeleted: mediaId => enqueue(async () => {
      try {
        const port = usablePort();
        if (port) await withTimeout(port.remove(mediaId));
      } catch (e) { fail("remove", mediaId, undefined, e); }
    }),
    idle: () => (!active && !queue.length ? Promise.resolve() : new Promise<void>(r => waiters.push(r))),
  };
}
