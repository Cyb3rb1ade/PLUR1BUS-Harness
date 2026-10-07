// D109 §6: the append-only event log with an HMAC-SHA256 chain. Every entry stores the MAC of its predecessor and its
// own MAC over (prev, seq, ts, kind, refId, nonce, payload), keyed by the per-installation key. A keyed head row
// (seq, mac, tag) pins the newest entry so cutting the tail is caught too. Style follows audit/chain.ts (B5).
// Not protected (stated in the spec): code with the person's OS rights that can read the secret store can forge it,
// and an attacker can roll back to an older, fully consistent copy of the file.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../policy/decide.ts";
import { transaction } from "./db.ts";
import { assertKey } from "./keys.ts";

export const GENESIS_MAC = "0".repeat(64);

export interface ChainEntry {
  seq: number; ts: number; kind: string; refId: string; nonce: string | null; payload: string; prevMac: string; mac: string;
}

export type VerifyFailure =
  | "seq-gap" | "prev-mismatch" | "mac-mismatch" | "truncated" | "head-mismatch"
  | "malformed" | "nonce-reuse" | "binding-mismatch" | "duplicate";

export type VerifyResult =
  | { ok: true; entries: number; head: { seq: number; mac: string } | null }
  | { ok: false; entries: number; /** First position (seq) at which the chain does not hold. */ brokenAt: number; reason: VerifyFailure; detail: string };

export interface ChainSnapshot {
  result: VerifyResult;
  entries: readonly ChainEntry[];
  byRef: ReadonlyMap<string, readonly ChainEntry[]>;
  /** Entries with seq below this are proven; `Infinity` when the whole chain verifies. */
  trustedBelow: number;
}

export class ApprovalChainError extends Error {
  readonly code = "chain-broken" as const;
  readonly brokenAt: number;
  readonly reason: VerifyFailure;
  constructor(r: Extract<VerifyResult, { ok: false }>) {
    super(`approval chain is broken at ${r.brokenAt} (${r.reason}): ${r.detail}`);
    this.name = "ApprovalChainError";
    this.brokenAt = r.brokenAt;
    this.reason = r.reason;
  }
}

interface Row { seq: number; ts: number; kind: string; ref_id: string; nonce: string | null; payload: string; prev_mac: string; mac: string }
const toEntry = (r: Row): ChainEntry => ({ seq: Number(r.seq), ts: Number(r.ts), kind: r.kind, refId: r.ref_id, nonce: r.nonce, payload: r.payload, prevMac: r.prev_mac, mac: r.mac });

const eq = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The binding every approval is tied to (§6). Compared as one canonical tuple. */
export function bindingTuple(b: unknown): string | null {
  if (typeof b !== "object" || b === null) return null;
  const o = b as Record<string, unknown>;
  const s = o.subject as Record<string, unknown> | undefined;
  const parts = [o.actionHash, o.principal, s?.kind, s?.id, o.turnId, o.taskId, o.sessionId];
  return parts.every((p) => typeof p === "string") ? JSON.stringify(parts) : null;
}

export class ApprovalChain {
  readonly #db: DatabaseSync;
  readonly #key: Buffer;
  readonly #clock: Clock;
  #gen = 0;
  #cache: { dv: number; gen: number; snap: ChainSnapshot } | null = null;

  constructor(db: DatabaseSync, key: Uint8Array, clock: Clock) {
    this.#db = db;
    this.#key = Buffer.from(assertKey(key));
    this.#clock = clock;
  }

  #mac(prev: string, e: Pick<ChainEntry, "seq" | "ts" | "kind" | "refId" | "nonce" | "payload">): string {
    return createHmac("sha256", this.#key).update(JSON.stringify([prev, e.seq, e.ts, e.kind, e.refId, e.nonce, e.payload])).digest("hex");
  }
  #tag(seq: number, mac: string): string {
    return createHmac("sha256", this.#key).update(JSON.stringify(["head", seq, mac])).digest("hex");
  }
  #dataVersion(): number {
    return Number((this.#db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version);
  }

  /** Verified view of the whole chain; cached until this connection appends or another one commits. */
  snapshot(): ChainSnapshot {
    const dv = this.#dataVersion();
    if (this.#cache && this.#cache.dv === dv && this.#cache.gen === this.#gen) return this.#cache.snap;
    const snap = this.#build();
    this.#cache = { dv, gen: this.#gen, snap };
    return snap;
  }

  verify(): VerifyResult {
    return this.snapshot().result;
  }

  #build(): ChainSnapshot {
    const rows = (this.#db.prepare("SELECT seq, ts, kind, ref_id, nonce, payload, prev_mac, mac FROM approval_chain ORDER BY seq").all() as unknown as Row[]).map(toEntry);
    const byRef = new Map<string, ChainEntry[]>();
    for (const e of rows) { const l = byRef.get(e.refId); if (l) l.push(e); else byRef.set(e.refId, [e]); }
    const fail = (brokenAt: number, reason: VerifyFailure, detail: string): ChainSnapshot => ({
      result: { ok: false, entries: rows.length, brokenAt, reason, detail }, entries: rows, byRef, trustedBelow: brokenAt,
    });

    let expected = 1;
    let prev = GENESIS_MAC;
    for (const e of rows) {
      if (e.seq !== expected) return fail(expected, "seq-gap", `expected entry ${expected}, found ${e.seq}`);
      if (!eq(e.prevMac, prev)) return fail(e.seq, "prev-mismatch", "the entry does not chain to its predecessor");
      if (!eq(e.mac, this.#mac(prev, e))) return fail(e.seq, "mac-mismatch", "the entry's MAC does not verify");
      prev = e.mac;
      expected += 1;
    }

    const head = this.#db.prepare("SELECT seq, mac, tag FROM chain_head WHERE id = 1").get() as { seq: number; mac: string; tag: string } | undefined;
    const n = rows.length;
    if (n === 0) {
      if (head) return fail(1, "truncated", "the head points at entries that are gone");
    } else {
      if (!head || !eq(head.tag, this.#tag(Number(head.seq), head.mac))) return fail(n, "head-mismatch", "the chain head is missing or its tag does not verify");
      if (Number(head.seq) > n) return fail(n + 1, "truncated", `the head pins entry ${head.seq}, the chain ends at ${n}`);
      if (Number(head.seq) < n) return fail(Number(head.seq) + 1, "head-mismatch", "entries exist beyond the pinned head");
      if (!eq(head.mac, rows[n - 1]!.mac)) return fail(n, "head-mismatch", "the pinned head does not match the last entry");
    }

    const semantic = this.#semantic(rows);
    if (semantic) return fail(semantic.at, semantic.reason, semantic.detail);
    return {
      result: { ok: true, entries: n, head: n === 0 ? null : { seq: n, mac: rows[n - 1]!.mac } },
      entries: rows, byRef, trustedBelow: Number.POSITIVE_INFINITY,
    };
  }

  /** Binding and replay rules over MAC-valid entries: defence in depth against a buggy or key-holding writer. */
  #semantic(rows: readonly ChainEntry[]): { at: number; reason: VerifyFailure; detail: string } | null {
    const requested = new Map<string, { tuple: string; nonce: string | null }>();
    const decided = new Map<string, string>();
    const used = new Set<string>();
    const nonces = new Set<string>();
    for (const e of rows) {
      if (!e.kind.startsWith("approval.")) continue;
      let p: Record<string, unknown>;
      try { p = JSON.parse(e.payload) as Record<string, unknown>; } catch { return { at: e.seq, reason: "malformed", detail: "payload is not JSON" }; }
      if (typeof p !== "object" || p === null) return { at: e.seq, reason: "malformed", detail: "payload is not an object" };
      const tuple = bindingTuple(p.bound);
      if (e.kind === "approval.requested") {
        if (tuple === null || requested.has(e.refId)) return { at: e.seq, reason: tuple === null ? "malformed" : "duplicate", detail: "request entry" };
        requested.set(e.refId, { tuple, nonce: e.nonce });
      } else if (e.kind === "approval.decided") {
        if (e.nonce === null || nonces.has(e.nonce)) return { at: e.seq, reason: "nonce-reuse", detail: "a nonce is single-use" };
        nonces.add(e.nonce);
        const r = requested.get(e.refId);
        if (!r || tuple !== r.tuple || r.nonce !== e.nonce) return { at: e.seq, reason: "binding-mismatch", detail: "decision does not match its request" };
        if (decided.has(e.refId)) return { at: e.seq, reason: "duplicate", detail: "request decided twice" };
        if (p.decision !== "approve" && p.decision !== "deny") return { at: e.seq, reason: "malformed", detail: "decision" };
        decided.set(e.refId, p.decision);
      } else if (e.kind === "approval.used") {
        const r = requested.get(e.refId);
        if (!r || tuple !== r.tuple || decided.get(e.refId) !== "approve") return { at: e.seq, reason: "binding-mismatch", detail: "use does not match an approved request" };
        if (used.has(e.refId)) return { at: e.seq, reason: "duplicate", detail: "approval used twice" };
        used.add(e.refId);
      }
    }
    return null;
  }

  /** Appends one entry. Runs in the caller's transaction when one is open, else in its own. Refuses a broken chain. */
  append(kind: string, refId: string, payload: unknown, nonce: string | null = null): ChainEntry {
    const run = (): ChainEntry => {
      const snap = this.snapshot();
      if (!snap.result.ok) throw new ApprovalChainError(snap.result);
      const last = snap.entries[snap.entries.length - 1];
      const prev = last ? last.mac : GENESIS_MAC;
      const base = { seq: (last?.seq ?? 0) + 1, ts: this.#clock.now(), kind, refId, nonce, payload: JSON.stringify(payload) };
      const mac = this.#mac(prev, base);
      this.#gen += 1; // the cache is stale from here on, whether or not the statements below succeed
      this.#db.prepare("INSERT INTO approval_chain (seq, ts, kind, ref_id, nonce, payload, prev_mac, mac) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(base.seq, base.ts, kind, refId, nonce, base.payload, prev, mac);
      this.#db.prepare("INSERT INTO chain_head (id, seq, mac, tag) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, mac = excluded.mac, tag = excluded.tag")
        .run(base.seq, mac, this.#tag(base.seq, mac));
      return { ...base, prevMac: prev, mac };
    };
    try {
      return this.#db.isTransaction ? run() : transaction(this.#db, run);
    } finally {
      this.#gen += 1;
    }
  }
}
