// RPC surface of the media index (image, video, audio search): media.search, media.index.status|pause|resume|reindex, media.caption.set.
// Contract: ~/plur1bus-merge/briefs/media-search-contract.md ("RPC"). The engine work sits behind the host port `MediaIndexPort`.
//
// Dependencies (all injected; the composition module supplies them, tests use fakes):
//   index        the running media index, or null while the engine has none (every method then answers E_MEDIA_UNAVAILABLE).
//   config       the effective configuration; `memory.mediaEmbedding.enabled === false` or provider "off" makes search unavailable.
//   backfill     pause / resume / reindex of the background backfill (the host owns budget and persistence around the port).
//   scopeOf      the engine scope a principal searches in (an agent searches its own scope).
//   readable     may this principal read the medium? Hits it may not read are dropped, `likeMediaId` needs it.
//   editable     may this principal edit the medium? Guards media.caption.set. Agents never pass (the RBAC rule is human-only).
//   captionOf    optional: caption text of a hit from its caption memory id (omitted from the hit when it returns nothing).
//   thumbnailUrl optional: URL the web UI loads for a medium.
//   audit        optional sink; operate and caption actions are recorded, searches are not.
// `createMediaOwnerAcl` is the ready-made readable/editable pair over the media surface's owner files (<home>/media/owners).
//
// RBAC lives in rbac/guard.ts (RPC_RULES): search/status are `media.index.read` (every role, agents included), pause/resume/
// reindex are `media.index.operate` (Owner/Admin, people only), caption.set is `media.caption.write` (people only) plus the
// `editable` check here. Index errors carrying an `E_MEDIA_*` code reach the client through ./surface-errors.ts.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessConfig } from "@plur1bus/config-schema";
import { safeId } from "../../../media/src/files.ts";
import type { MediaHit, MediaIndexPort, MediaIndexStatus, MediaKind, Scope } from "../media-search/types.ts";
import type { AuditSink } from "../rbac/audit.ts";
import { authorize } from "../rbac/authorize.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import type { Principal } from "../rbac/types.ts";
import { RpcError } from "./errors.ts";
import type { CallContext, Handler } from "./server.ts";
import { surfaceError } from "./surface-errors.ts";

export interface MediaSearchSurfaceDeps {
  index: () => MediaIndexPort | null;
  config: () => HarnessConfig;
  backfill: { pause(): Promise<void>; resume(): Promise<void>; reindex(): Promise<void> };
  scopeOf: (principal: Principal, ctx: CallContext) => Scope;
  readable: (principal: Principal, mediaId: string) => Promise<boolean>;
  editable: (principal: Principal, mediaId: string) => Promise<boolean>;
  captionOf?: (captionMemoryId: string | undefined) => Promise<string | undefined>;
  thumbnailUrl?: (mediaId: string) => string | undefined;
  audit?: AuditSink;
  clock?: () => number;
}

export const MEDIA_SEARCH_METHODS = ["media.search", "media.index.status", "media.index.pause", "media.index.resume", "media.index.reindex", "media.caption.set"] as const;

const KINDS: readonly MediaKind[] = ["image", "video", "audio"];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_TEXT = 4096;
const MAX_ID = 256;
const OVERFETCH = 2; // hits the caller may not read are dropped afterwards; ask the index for more than `limit`
const MAX_FETCH = 200;

const invalid = (reason: string): never => { throw new RpcError("E_INVALID_PARAMS", "invalid parameters", { reason }); };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function closed(p: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (p === undefined || p === null) return {};
  if (!isObj(p)) return invalid("params-not-object");
  for (const k of Object.keys(p)) if (!allowed.includes(k)) invalid("unknown-param");
  return p;
}
function str(v: unknown, name: string, max: number): string {
  if (typeof v !== "string" || v.trim() === "" || v.length > max) return invalid(`invalid-${name}`);
  return v;
}

interface SearchParams { text?: string; likeMediaId?: string; kinds?: MediaKind[]; limit: number; fuseCaptions: boolean }
function searchParams(raw: unknown): SearchParams {
  const p = closed(raw, ["text", "likeMediaId", "kinds", "limit", "fuseCaptions"]);
  const hasText = p.text !== undefined, hasLike = p.likeMediaId !== undefined;
  if (!hasText && !hasLike) invalid("text-or-like-required");
  if (hasText && hasLike) invalid("text-and-like-exclusive");
  const out: SearchParams = { limit: DEFAULT_LIMIT, fuseCaptions: false };
  if (hasText) out.text = str(p.text, "text", MAX_TEXT);
  if (hasLike) out.likeMediaId = str(p.likeMediaId, "like-media-id", MAX_ID);
  if (p.kinds !== undefined) {
    const k = p.kinds;
    if (!Array.isArray(k) || k.length < 1 || k.length > KINDS.length || new Set(k).size !== k.length || !k.every((x) => KINDS.includes(x as MediaKind))) invalid("invalid-kinds");
    out.kinds = k as MediaKind[];
  }
  if (p.limit !== undefined) {
    if (typeof p.limit !== "number" || !Number.isInteger(p.limit) || p.limit < 1 || p.limit > MAX_LIMIT) invalid("invalid-limit");
    out.limit = p.limit as number;
  }
  if (p.fuseCaptions !== undefined) {
    if (typeof p.fuseCaptions !== "boolean") invalid("invalid-fuse-captions");
    out.fuseCaptions = p.fuseCaptions as boolean;
  }
  return out;
}

/** The status projected field by field onto the schema (nothing the port adds leaks). */
function projectStatus(s: MediaIndexStatus) {
  return {
    enabled: s.enabled === true, provider: String(s.provider), model: String(s.model), ...(s.variant !== undefined ? { variant: String(s.variant) } : {}),
    dim: s.dim, fingerprint: String(s.fingerprint),
    counts: { indexed: s.counts.indexed, pending: s.counts.pending, failed: s.counts.failed, unsupported: s.counts.unsupported },
    backfill: {
      state: s.backfill.state, done: s.backfill.done, total: s.backfill.total,
      ...(s.backfill.startedAt !== undefined ? { startedAt: s.backfill.startedAt } : {}),
      ...(s.backfill.pausedReason !== undefined ? { pausedReason: s.backfill.pausedReason } : {}),
    },
  };
}

export function createMediaSearchSurface(d: MediaSearchSurfaceDeps): { methods: Record<string, Handler> } {
  const clock = d.clock ?? Date.now;
  const audit = (who: string, action: string, target: string, detail: Record<string, unknown>): void => {
    try { d.audit?.append({ at: clock(), actor: { user: who, host: "rpc" }, action, target, detail }); } catch { /* the change stands */ }
  };
  const unavailable = (reason: string): never => { throw new RpcError("E_MEDIA_UNAVAILABLE", "the media index is not available", { reason }); };
  const port = (): MediaIndexPort => d.index() ?? unavailable("no-media-index");
  const searchEnabled = (): void => {
    const m = (d.config() as unknown as { memory?: { mediaEmbedding?: { enabled?: unknown; provider?: unknown } } }).memory?.mediaEmbedding;
    if (m?.enabled === false || m?.provider === "off") unavailable("media-index-disabled");
  };
  const bind = (fn: (p: unknown, who: Principal, ctx: CallContext) => Promise<unknown>): Handler => async (p, ctx) => {
    try { return await fn(p, authenticatedPrincipal(ctx), ctx); }
    catch (e) { return surfaceError(e); }
  };
  const status = async () => projectStatus(await port().status());

  const hitOf = async (h: MediaHit) => {
    const caption = d.captionOf ? await d.captionOf(h.captionMemoryId).catch(() => undefined) : undefined;
    const thumbnailUrl = d.thumbnailUrl?.(h.mediaId);
    return {
      mediaId: h.mediaId, kind: h.kind, score: h.score,
      ...(h.segment ? { segment: { idx: h.segment.idx, startMs: h.segment.startMs, endMs: h.segment.endMs } } : {}),
      ...(caption ? { caption } : {}), ...(thumbnailUrl ? { thumbnailUrl } : {}),
    };
  };

  const methods: Record<string, Handler> = {
    "media.search": bind(async (raw, who, ctx) => {
      const q = searchParams(raw);
      const index = port();
      searchEnabled();
      // A seed medium the caller may not read is indistinguishable from an unknown one.
      if (q.likeMediaId !== undefined && !(await d.readable(who, q.likeMediaId))) throw new RpcError("E_NOT_FOUND", "media object not found", { reason: "unknown-media" });
      const hits = await index.search({
        ...(q.text !== undefined ? { text: q.text } : {}), ...(q.likeMediaId !== undefined ? { likeMediaId: q.likeMediaId } : {}),
        ...(q.kinds ? { kinds: q.kinds } : {}), limit: Math.min(q.limit * OVERFETCH, MAX_FETCH), fuseCaptions: q.fuseCaptions, scope: d.scopeOf(who, ctx),
      });
      const out = [];
      for (const h of hits) {
        if (out.length >= q.limit) break;
        if (q.kinds && !q.kinds.includes(h.kind)) continue;
        if (!(await d.readable(who, h.mediaId))) continue;
        out.push(await hitOf(h));
      }
      return { hits: out };
    }),

    "media.index.status": bind(async (raw) => { closed(raw, []); return status(); }),

    "media.index.pause": bind(async (raw, who) => {
      closed(raw, []);
      port();
      await d.backfill.pause();
      audit(who.userId, "media.index.pause", "media-index", {});
      return status();
    }),

    "media.index.resume": bind(async (raw, who) => {
      closed(raw, []);
      port();
      await d.backfill.resume();
      audit(who.userId, "media.index.resume", "media-index", {});
      return status();
    }),

    "media.index.reindex": bind(async (raw, who) => {
      const p = closed(raw, ["confirm"]);
      if (p.confirm !== true) invalid("confirmation-required");
      port();
      await d.backfill.reindex();
      audit(who.userId, "media.index.reindex", "media-index", {});
      return status();
    }),

    "media.caption.set": bind(async (raw, who) => {
      const p = closed(raw, ["mediaId", "text"]);
      const mediaId = str(p.mediaId, "media-id", MAX_ID), text = str(p.text, "text", MAX_TEXT).trim();
      if (who.kind !== "person") throw new RpcError("E_DENIED", "not permitted: media.caption.write", { reason: "agent-principal" });
      const index = port();
      if (!(await d.readable(who, mediaId))) throw new RpcError("E_NOT_FOUND", "media object not found", { reason: "unknown-media" });
      if (!(await d.editable(who, mediaId))) throw new RpcError("E_DENIED", "not permitted: this medium cannot be edited", { reason: "not-editable" });
      await index.setCaption(mediaId, text, "user");
      audit(who.userId, "media.caption.set", mediaId, { chars: text.length });
      return { ok: true };
    }),
  };
  return { methods };
}

interface MediaOwner { agentId: string; userId: string }

/**
 * Read/edit rights over the media surface's owner files (`<home>/media/owners/<id>.json`, written by media.generate/edit):
 * the same rule as media.output.get (read) and media.output.delete (edit): `agent.read` / `agent.use` on the agent that made
 * the medium. A medium without an owner file is neither readable nor editable (deny by default).
 */
export function createMediaOwnerAcl(d: { home: string }): Pick<MediaSearchSurfaceDeps, "readable" | "editable"> {
  const ownerOf = async (mediaId: string): Promise<MediaOwner | null> => {
    try {
      const o = JSON.parse(await readFile(join(d.home, "media", "owners", `${safeId(mediaId)}.json`), "utf8")) as unknown;
      return isObj(o) && typeof o.agentId === "string" && o.agentId !== "" ? { agentId: o.agentId, userId: typeof o.userId === "string" ? o.userId : "" } : null;
    } catch { return null; }
  };
  const allowed = (action: "agent.read" | "agent.use") => async (who: Principal, mediaId: string): Promise<boolean> => {
    const o = await ownerOf(mediaId);
    return o !== null && authorize(who, action, { kind: "agent", agentId: o.agentId }).effect === "allow";
  };
  return { readable: allowed("agent.read"), editable: allowed("agent.use") };
}
