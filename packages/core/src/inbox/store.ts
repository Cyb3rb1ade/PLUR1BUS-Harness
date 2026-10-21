// Durable per-person inbox (docs/inbox.md). One synchronous writer on node:sqlite: every mutation is one statement or one
// BEGIN IMMEDIATE transaction, so a crash leaves either the old or the new state. Metadata only: no secrets, no content.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { platformCapabilities } from "../platform.ts";

export const INBOX_KINDS = ["breakglass", "approval", "job-failed", "update", "media-index", "pairing", "channel", "system"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];
export const INBOX_SEVERITIES = ["info", "warning", "critical"] as const;
export type InboxSeverity = (typeof INBOX_SEVERITIES)[number];

export const DEFAULT_MAX_AGE_MS = 90 * 86_400_000;
export const DEFAULT_MAX_ENTRIES = 1000;
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;
export const MAX_IDS = 500;

export type InboxParams = Record<string, string | number | boolean>;
export interface InboxRef { route?: string; objectId?: string }
export interface InboxDraft {
  userId: string; kind: InboxKind; severity: InboxSeverity;
  /** i18n key the client translates; `params` fill its placeholders. */
  titleKey: string; params?: InboxParams; ref?: InboxRef;
  /** `kind:objectId`-style key: publishing it again for the same person is a no-op. */
  dedupeKey: string;
}
export interface InboxEntry {
  id: string; kind: InboxKind; severity: InboxSeverity; titleKey: string; params: InboxParams; ref: InboxRef | null;
  createdAt: number; readAt: number | null; dismissedAt: number | null;
}
export interface InboxListQuery { kinds?: readonly InboxKind[]; unreadOnly?: boolean; includeDismissed?: boolean; limit?: number; cursor?: string }
export interface InboxCounts { unread: Record<InboxKind, number>; total: number }

export type InboxErrorCode = "invalid" | "cursor";
export class InboxError extends Error {
  readonly code: InboxErrorCode;
  constructor(code: InboxErrorCode, message: string) { super(message); this.name = "InboxError"; this.code = code; }
}
const invalid = (m: string): never => { throw new InboxError("invalid", m); };

export interface InboxStoreOptions { path: string; clock: () => number; maxAgeMs?: number; maxEntries?: number; idGen?: () => string }

const TITLE_KEY = /^[a-z][A-Za-z0-9._-]{0,95}$/;
interface Row { seq: number; id: string; kind: InboxKind; severity: InboxSeverity; title_key: string; params: string; ref: string | null; created_at: number; read_at: number | null; dismissed_at: number | null }
const entryOf = (r: Row): InboxEntry => ({
  id: r.id, kind: r.kind, severity: r.severity, titleKey: r.title_key, params: JSON.parse(r.params) as InboxParams,
  ref: r.ref === null ? null : JSON.parse(r.ref) as InboxRef, createdAt: r.created_at, readAt: r.read_at, dismissedAt: r.dismissed_at,
});

function validate(d: InboxDraft): void {
  if (typeof d.userId !== "string" || d.userId === "" || d.userId.length > 128) invalid("userId is required");
  if (!INBOX_KINDS.includes(d.kind)) invalid("unknown inbox kind");
  if (!INBOX_SEVERITIES.includes(d.severity)) invalid("unknown inbox severity");
  if (typeof d.titleKey !== "string" || !TITLE_KEY.test(d.titleKey)) invalid("titleKey must be an i18n key");
  if (typeof d.dedupeKey !== "string" || d.dedupeKey === "" || d.dedupeKey.length > 200) invalid("dedupeKey is required");
  if (d.params !== undefined) {
    const keys = Object.keys(d.params);
    if (keys.length > 16) invalid("too many params");
    for (const k of keys) {
      const v = d.params[k];
      if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k) || !(typeof v === "number" && Number.isFinite(v) || typeof v === "boolean" || typeof v === "string" && v.length <= 200)) invalid("params hold short scalars only");
    }
  }
  if (d.ref !== undefined) {
    if (d.ref.route !== undefined && (typeof d.ref.route !== "string" || !d.ref.route.startsWith("/") || d.ref.route.length > 200)) invalid("ref.route must be an app route");
    if (d.ref.objectId !== undefined && (typeof d.ref.objectId !== "string" || d.ref.objectId === "" || d.ref.objectId.length > 128)) invalid("ref.objectId is invalid");
  }
}
function idList(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS || ids.some(i => typeof i !== "string" || i === "" || i.length > 64)) return invalid(`ids must be 1-${MAX_IDS} entry ids`);
  return [...new Set(ids as string[])];
}
const encodeCursor = (seq: number): string => Buffer.from(String(seq)).toString("base64url");
function decodeCursor(c: string): number {
  const s = typeof c === "string" && c !== "" ? Buffer.from(c, "base64url").toString("utf8") : "";
  if (!/^[0-9]{1,15}$/.test(s)) throw new InboxError("cursor", "cursor is not valid");
  return Number(s);
}

export class InboxStore {
  readonly db: DatabaseSync;
  readonly retention: { maxAgeMs: number; maxEntries: number };
  readonly #clock: () => number;
  readonly #id: () => string;
  constructor(o: InboxStoreOptions) {
    const maxAgeMs = o.maxAgeMs ?? DEFAULT_MAX_AGE_MS, maxEntries = o.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1) invalid("maxAgeMs must be a positive integer");
    if (!Number.isInteger(maxEntries) || maxEntries < 1) invalid("maxEntries must be a positive integer");
    this.retention = { maxAgeMs, maxEntries };
    this.#clock = o.clock; this.#id = o.idGen ?? randomUUID;
    if (o.path !== ":memory:") { mkdirSync(dirname(o.path), { recursive: true, mode: 0o700 }); closeSync(openSync(o.path, "a", 0o600)); platformCapabilities.securePath(o.path); }
    this.db = new DatabaseSync(o.path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS inbox_entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, dedupe_key TEXT NOT NULL,
        kind TEXT NOT NULL, severity TEXT NOT NULL, title_key TEXT NOT NULL, params TEXT NOT NULL, ref TEXT,
        created_at INTEGER NOT NULL, read_at INTEGER, dismissed_at INTEGER, UNIQUE(user_id, dedupe_key)) STRICT;
      CREATE TABLE IF NOT EXISTS inbox_cooldowns (
        user_id TEXT NOT NULL, cause TEXT NOT NULL, published_at INTEGER NOT NULL, entry_id TEXT NOT NULL,
        PRIMARY KEY(user_id, cause)) STRICT;
      CREATE INDEX IF NOT EXISTS inbox_by_user ON inbox_entries(user_id, seq DESC);`);
  }
  close(): void { this.db.close(); }

  #tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); this.db.exec("COMMIT"); return r; } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  /** Creates the entry unless this person already has one under `dedupeKey` (then nothing changes). */
  publish(d: InboxDraft): { id: string; created: boolean } {
    validate(d);
    return this.#tx(() => {
      // Retention first: an entry past its age must not hide a repeat event behind its dedupe key (docs/inbox.md).
      this.#prune(d.userId);
      const known = this.db.prepare("SELECT id FROM inbox_entries WHERE user_id=? AND dedupe_key=?").get(d.userId, d.dedupeKey) as { id: string } | undefined;
      if (known) return { id: known.id, created: false };
      const id = this.#id();
      this.db.prepare("INSERT INTO inbox_entries(id,user_id,dedupe_key,kind,severity,title_key,params,ref,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, d.userId, d.dedupeKey, d.kind, d.severity, d.titleKey, JSON.stringify(d.params ?? {}), d.ref ? JSON.stringify(d.ref) : null, this.#clock());
      this.#prune(d.userId);
      return { id, created: true };
    });
  }

  /** A rolling cooldown committed atomically with the entry, independent of dismissal/entry retention and process lifetime. */
  publishRateLimited(d: InboxDraft, cooldownMs: number): { id: string; created: boolean } {
    validate(d);
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1) invalid("cooldownMs must be a positive safe integer");
    return this.#tx(() => {
      const now = this.#clock();
      const last = this.db.prepare("SELECT published_at, entry_id FROM inbox_cooldowns WHERE user_id=? AND cause=?")
        .get(d.userId, d.dedupeKey) as { published_at: number; entry_id: string } | undefined;
      if (last && now - last.published_at < cooldownMs) return { id: last.entry_id, created: false };
      this.#prune(d.userId);
      const id = this.#id();
      this.db.prepare("INSERT INTO inbox_entries(id,user_id,dedupe_key,kind,severity,title_key,params,ref,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, d.userId, `rate:${id}`, d.kind, d.severity, d.titleKey, JSON.stringify(d.params ?? {}), d.ref ? JSON.stringify(d.ref) : null, now);
      this.db.prepare("INSERT INTO inbox_cooldowns(user_id,cause,published_at,entry_id) VALUES (?,?,?,?) ON CONFLICT(user_id,cause) DO UPDATE SET published_at=excluded.published_at,entry_id=excluded.entry_id")
        .run(d.userId, d.dedupeKey, now, id);
      this.#prune(d.userId);
      return { id, created: true };
    });
  }

  #prune(userId: string): void {
    this.db.prepare("DELETE FROM inbox_entries WHERE user_id=? AND created_at < ?").run(userId, this.#clock() - this.retention.maxAgeMs);
    this.db.prepare("DELETE FROM inbox_entries WHERE user_id=? AND seq NOT IN (SELECT seq FROM inbox_entries WHERE user_id=? ORDER BY seq DESC LIMIT ?)").run(userId, userId, this.retention.maxEntries);
  }

  list(userId: string, q: InboxListQuery): { entries: InboxEntry[]; nextCursor?: string } {
    const limit = q.limit ?? DEFAULT_PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) invalid(`limit must be 1-${MAX_PAGE}`);
    if (q.kinds !== undefined && (!Array.isArray(q.kinds) || q.kinds.some(k => !INBOX_KINDS.includes(k)))) invalid("unknown inbox kind");
    const where = ["user_id=?"], args: (string | number)[] = [userId];
    if (q.cursor !== undefined) { where.push("seq < ?"); args.push(decodeCursor(q.cursor)); }
    if (q.kinds?.length) { where.push(`kind IN (${q.kinds.map(() => "?").join(",")})`); args.push(...q.kinds); }
    if (q.unreadOnly) where.push("read_at IS NULL");
    if (!q.includeDismissed) where.push("dismissed_at IS NULL");
    const rows = this.db.prepare(`SELECT * FROM inbox_entries WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`).all(...args, limit + 1) as unknown as Row[];
    const page = rows.slice(0, limit);
    return { entries: page.map(entryOf), ...(rows.length > limit ? { nextCursor: encodeCursor(page[page.length - 1]!.seq) } : {}) };
  }

  /** Unread, not dismissed entries per kind (every kind is present), plus the number of visible entries. */
  count(userId: string): InboxCounts {
    const unread = Object.fromEntries(INBOX_KINDS.map(k => [k, 0])) as Record<InboxKind, number>;
    for (const r of this.db.prepare("SELECT kind, COUNT(*) AS n FROM inbox_entries WHERE user_id=? AND dismissed_at IS NULL AND read_at IS NULL GROUP BY kind").all(userId) as { kind: InboxKind; n: number }[]) unread[r.kind] = Number(r.n);
    const total = Number((this.db.prepare("SELECT COUNT(*) AS n FROM inbox_entries WHERE user_id=? AND dismissed_at IS NULL").get(userId) as { n: number }).n);
    return { unread, total };
  }

  /** The kinds a `markRead` (`unread`) or `dismiss` (`open`) of these ids would touch, for the person's own entries only. No page limit. */
  kindsOf(userId: string, ids: readonly string[] | "all", what: "unread" | "open"): InboxKind[] {
    const state = what === "unread" ? "read_at IS NULL AND dismissed_at IS NULL" : "dismissed_at IS NULL";
    if (ids === "all") return (this.db.prepare(`SELECT DISTINCT kind FROM inbox_entries WHERE user_id=? AND ${state}`).all(userId) as { kind: InboxKind }[]).map(r => r.kind);
    const list = idList(ids);
    return (this.db.prepare(`SELECT DISTINCT kind FROM inbox_entries WHERE user_id=? AND ${state} AND id IN (${list.map(() => "?").join(",")})`).all(userId, ...list) as { kind: InboxKind }[]).map(r => r.kind);
  }

  /** Marks the person's own entries read (the first read time is kept); returns how many changed. */
  markRead(userId: string, ids: readonly string[] | "all"): number {
    const now = this.#clock();
    if (ids === "all") return Number(this.db.prepare("UPDATE inbox_entries SET read_at=? WHERE user_id=? AND read_at IS NULL AND dismissed_at IS NULL").run(now, userId).changes);
    const list = idList(ids);
    return this.#tx(() => list.reduce((n, id) => n + Number(this.db.prepare("UPDATE inbox_entries SET read_at=? WHERE user_id=? AND id=? AND read_at IS NULL").run(now, userId, id).changes), 0));
  }

  /** Hides the person's own entries (read as well); the row stays until retention so a repeat event does not bring it back. */
  dismiss(userId: string, ids: readonly string[]): number {
    const list = idList(ids), now = this.#clock();
    return this.#tx(() => list.reduce((n, id) => n + Number(this.db.prepare("UPDATE inbox_entries SET dismissed_at=?, read_at=COALESCE(read_at,?) WHERE user_id=? AND id=? AND dismissed_at IS NULL").run(now, now, userId, id).changes), 0));
  }

  /** Like `settle` for everyone who has the entry; returns the people whose entry was closed. */
  settleEverywhere(dedupeKey: string): string[] {
    const now = this.#clock();
    return (this.db.prepare("UPDATE inbox_entries SET dismissed_at=?, read_at=COALESCE(read_at,?) WHERE dedupe_key=? AND dismissed_at IS NULL RETURNING user_id").all(now, now, dedupeKey) as { user_id: string }[]).map(r => r.user_id);
  }

  /** Producer side: the thing the entry was about is settled, so close it. True when an open entry was closed. */
  settle(userId: string, dedupeKey: string): boolean {
    const now = this.#clock();
    return Number(this.db.prepare("UPDATE inbox_entries SET dismissed_at=?, read_at=COALESCE(read_at,?) WHERE user_id=? AND dedupe_key=? AND dismissed_at IS NULL").run(now, now, userId, dedupeKey).changes) > 0;
  }
}
