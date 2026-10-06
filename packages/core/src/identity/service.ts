import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { generateCode, hashCode, hashesEqual, newSalt, normalizeCode, uuidv7, CODE_LENGTH } from "./codes.ts";
import { createLimiter, GLOBAL_KEY, GLOBAL_LIMIT, SOURCE_LIMIT } from "./ratelimit.ts";
import { IdentityError, openStore } from "./store.ts";

export { IdentityError } from "./store.ts";
export type { IdentityErrorCode } from "./store.ts";

/** Who performed an owner-side action: the audit's `actor` (the CLI's own caller identity). */
export interface Actor { user: string; host: string }
/** A channel handle. `displayName` is a label for people to read; it is never matched on (ADR-007 Q4: no heuristic link). */
export interface ChannelIdentity { channel: string; accountId: string; userId: string; displayName?: string }
export type ProofMethod = "pairing_code" | "owner_manual" | "signed_challenge";
export interface Human { id: string; displayName: string; createdAt: number }
export interface Link {
  id: string; humanId: string; channel: string; accountId: string; userId: string; displayName?: string;
  /** The engine's v1 principal of this handle (ADR-007): kept so recall can read the union; the harness never writes it. */
  v1Principal: string;
  proofMethod: ProofMethod; linkedAt: number; linkedBy: string; revokedAt: number | null; revokedBy: string | null;
}
export type PairingState = "pending" | "claimed" | "confirmed" | "declined" | "expired";
export interface Pairing {
  id: string; humanId: string; channel: string; state: PairingState; createdAt: number; expiresAt: number;
  claimedBy?: ChannelIdentity; confirmBy?: number;
}
export interface AuditEvent { action: string; target: string; detail: Record<string, unknown>; actor?: Actor }

export interface IdentityOptions {
  dbPath: string; clock: () => number; audit: (e: AuditEvent) => void;
  /** Lifetime of a code and of a claim waiting for the owner. Default 10 minutes (ADR-007 caps it at 1 hour). */
  codeTtlMs?: number;
}

export const DEFAULT_CODE_TTL_MS = 10 * 60_000;
export const MAX_PENDING_PER_HUMAN_CHANNEL = 3;
const MAX_FIELD = 128; // INPUT_LIMITS.ACCOUNT_ID / USER_ID in the engine, as in principal.ts
const CONTROL = /[\u0000-\u001f\u007f]/;
const CHANNEL = /^[a-z][a-z0-9._-]{0,31}$/;
const PRUNE_AFTER_MS = 30 * 24 * 3_600_000;

const bad = (field: string, message: string) => new IdentityError("invalid-params", message, { field });
function text(v: unknown, field: string, max = MAX_FIELD): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max || CONTROL.test(v)) throw bad(field, `${field} must be a non-empty string of at most ${max} characters without control characters`);
  return v;
}
function channelOf(v: unknown, field = "channel"): string {
  if (typeof v !== "string" || !CHANNEL.test(v)) throw bad(field, `${field} must match ${CHANNEL}`);
  return v;
}
function identityOf(i: ChannelIdentity): ChannelIdentity {
  const out: ChannelIdentity = { channel: channelOf(i?.channel), accountId: text(i?.accountId, "accountId"), userId: text(i?.userId, "userId") };
  if (i.displayName !== undefined) out.displayName = text(i.displayName, "displayName");
  return out;
}

/** Exactly principal.ts's `userPrincipalHash` formula, for a handle of any channel (the engine owns the derivation; this is the stored v1 side). */
export function v1PrincipalOf(i: { channel: string; accountId: string; userId: string }): string {
  return `user:v1:${createHash("sha256").update(JSON.stringify([i.channel, i.accountId, i.userId]), "utf8").digest("hex")}`;
}

type Row = Record<string, string | number | null>;
const linkOf = (r: Row): Link => ({
  id: r.id as string, humanId: r.human_id as string, channel: r.channel as string, accountId: r.account_id as string, userId: r.channel_user_id as string,
  ...(r.display_name !== null ? { displayName: r.display_name as string } : {}),
  v1Principal: r.v1_principal as string, proofMethod: r.proof_method as ProofMethod, linkedAt: r.linked_at as number, linkedBy: r.linked_by as string,
  revokedAt: (r.revoked_at as number | null) ?? null, revokedBy: (r.revoked_by as string | null) ?? null,
});
const pairingOf = (r: Row): Pairing => ({
  id: r.id as string, humanId: r.human_id as string, channel: r.channel as string, state: r.state as PairingState, createdAt: r.created_at as number, expiresAt: r.expires_at as number,
  ...(r.claim_user_id !== null ? { claimedBy: { channel: r.channel as string, accountId: r.claim_account_id as string, userId: r.claim_user_id as string, ...(r.claim_display_name !== null ? { displayName: r.claim_display_name as string } : {}) } } : {}),
  ...(r.confirm_by !== null ? { confirmBy: r.confirm_by as number } : {}),
});

export function createIdentityService(o: IdentityOptions) {
  const db: DatabaseSync = openStore(o.dbPath);
  const ttl = o.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
  const limiter = createLimiter(db, o.clock);
  const now = () => o.clock();
  // A failing audit sink must never decide an outcome; the store's own state is the record of truth.
  const audit = (e: AuditEvent) => { try { o.audit(e); } catch { /* the sink logs its own failure */ } };

  /** BEGIN IMMEDIATE … COMMIT. The callback's return value is committed; to commit state and then refuse, return the refusal and throw outside. */
  function tx<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); db.exec("COMMIT"); return r; }
    catch (e) { try { db.exec("ROLLBACK"); } catch { /* already closed by the failure */ } throw e; }
  }
  const one = (sql: string, ...p: Array<string | number | null>): Row | undefined => db.prepare(sql).get(...p) as Row | undefined;
  const all = (sql: string, ...p: Array<string | number | null>): Row[] => db.prepare(sql).all(...p) as Row[];
  const run = (sql: string, ...p: Array<string | number | null>) => { db.prepare(sql).run(...p); };

  tx(() => {
    // Old finished pairings carry only hashes and handles; they are dropped after 30 days.
    run("DELETE FROM pairings WHERE state != 'pending' AND created_at < ?", now() - PRUNE_AFTER_MS);
    run("DELETE FROM pairings WHERE state = 'pending' AND expires_at < ?", now() - PRUNE_AFTER_MS);
    limiter.prune();
  });

  const requireHuman = (id: unknown): Row => {
    const h = one("SELECT * FROM humans WHERE id = ?", text(id, "humanId", 64));
    if (!h) throw new IdentityError("not-found", `no such human: ${String(id)}`);
    return h;
  };
  const activeLink = (i: { channel: string; accountId: string; userId: string }): Row | undefined =>
    one("SELECT * FROM identities WHERE channel = ? AND account_id = ? AND channel_user_id = ? AND revoked_at IS NULL", i.channel, i.accountId, i.userId);

  function insertLink(humanId: string, i: ChannelIdentity, proof: ProofMethod, by: string): Link {
    const id = uuidv7(now());
    run("INSERT INTO identities(id, human_id, channel, account_id, channel_user_id, display_name, v1_principal, proof_method, linked_at, linked_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
      id, humanId, i.channel, i.accountId, i.userId, i.displayName ?? null, v1PrincipalOf(i), proof, now(), by);
    return linkOf(one("SELECT * FROM identities WHERE id = ?", id)!);
  }

  const conflict = (i: ChannelIdentity) => new IdentityError("conflict", `${i.channel} identity is already linked to a human; unlink it first`);

  return {
    createHuman(p: { displayName: string }, actor: Actor): Human {
      const displayName = text(p?.displayName, "displayName"); const id = uuidv7(now()); const t = now();
      run("INSERT INTO humans(id, display_name, created_at, created_by) VALUES (?,?,?,?)", id, displayName, t, actor.user);
      audit({ action: "identity.human.create", target: id, detail: { displayName }, actor });
      return { id, displayName, createdAt: t };
    },

    /** The owner's manual, deliberate link (ADR-007 Q4): no code, immediate, audited. */
    link(p: { humanId: string; identity: ChannelIdentity }, actor: Actor): Link {
      const i = identityOf(p?.identity);
      const l = tx(() => {
        requireHuman(p.humanId);
        if (activeLink(i)) throw conflict(i);
        return insertLink(p.humanId, i, "owner_manual", actor.user);
      });
      audit({ action: "identity.link", target: l.id, detail: { humanId: l.humanId, channel: i.channel, accountId: i.accountId, userId: i.userId, proof: l.proofMethod }, actor });
      return l;
    },

    /** Mints a code for `humanId` on `channel`. The code is returned here once and exists nowhere else but as a salted hash. */
    startPairing(p: { humanId: string; channel: string }, actor: Actor): { pairingId: string; code: string; channel: string; expiresAt: number } {
      const channel = channelOf(p?.channel);
      const out = tx(() => {
        requireHuman(p.humanId);
        const t = now();
        const pending = one("SELECT COUNT(*) AS n FROM pairings WHERE human_id = ? AND channel = ? AND state = 'pending' AND expires_at > ?", p.humanId, channel, t)!.n as number;
        if (pending >= MAX_PENDING_PER_HUMAN_CHANNEL) throw new IdentityError("limit", `at most ${MAX_PENDING_PER_HUMAN_CHANNEL} pending codes per human and channel`);
        const code = generateCode(); const salt = newSalt(); const id = uuidv7(t);
        run("INSERT INTO pairings(id, human_id, channel, salt, code_hash, state, created_at, created_by, expires_at) VALUES (?,?,?,?,?,'pending',?,?,?)",
          id, p.humanId, channel, salt, hashCode(salt, code), t, actor.user, t + ttl);
        return { pairingId: id, code, channel, expiresAt: t + ttl };
      });
      audit({ action: "identity.pair.start", target: out.pairingId, detail: { humanId: p.humanId, channel, expiresAt: out.expiresAt }, actor });
      return out;
    },

    /**
     * The claimant (a channel adapter relaying what the person sent) presents a code from their handle. A match consumes
     * the code (single use) and parks the claim until the owner confirms; it links nothing by itself. Wrong, expired,
     * reused and wrong-channel codes all answer the same `invalid-code`, and failures are counted per handle and overall.
     */
    claim(p: { code: string; identity: ChannelIdentity }): { pairingId: string; state: "awaiting-confirmation"; confirmBy: number } {
      const i = identityOf(p?.identity);
      const srcKey = `src:${i.channel}:${i.accountId}:${i.userId}`;
      type Outcome = { ok: Pairing } | { fail: string } | { locked: number } | { taken: true };
      const outcome = tx((): Outcome => {
        const wait = limiter.lockedFor([srcKey, GLOBAL_KEY]);
        if (wait > 0) return { locked: wait };
        const t = now();
        const code = typeof p.code === "string" ? normalizeCode(p.code) : "";
        const shaped = code.length === CODE_LENGTH;
        let hit: Row | undefined; let why = "wrong";
        for (const r of all("SELECT * FROM pairings WHERE channel = ?", i.channel)) { // every row, so the work does not depend on where a match sits
          const eq = shaped && hashesEqual(hashCode(r.salt as string, code), r.code_hash as string);
          if (!eq) continue;
          if (r.state === "pending" && (r.expires_at as number) > t) hit = r;
          else why = r.state === "pending" ? "expired" : "reused";
        }
        if (!hit) { limiter.failure(srcKey, SOURCE_LIMIT); limiter.failure(GLOBAL_KEY, GLOBAL_LIMIT); return { fail: why }; }
        if (activeLink(i)) return { taken: true }; // not the claimant's guess failing: nothing counted, the code stays usable
        run("UPDATE pairings SET state = 'claimed', claim_account_id = ?, claim_user_id = ?, claim_display_name = ?, claimed_at = ?, confirm_by = ? WHERE id = ?",
          i.accountId, i.userId, i.displayName ?? null, t, t + ttl, hit.id as string);
        limiter.success(srcKey);
        return { ok: pairingOf(one("SELECT * FROM pairings WHERE id = ?", hit.id as string)!) };
      });
      const handle = { channel: i.channel, accountId: i.accountId, userId: i.userId };
      if ("locked" in outcome) {
        audit({ action: "identity.pair.rate-limited", target: srcKey, detail: { ...handle, retryAfterMs: outcome.locked } });
        throw new IdentityError("rate-limited", "too many failed attempts; try again later", { retryAfterMs: outcome.locked });
      }
      if ("fail" in outcome) {
        audit({ action: "identity.pair.claim", target: srcKey, detail: { ...handle, result: "refused", reason: outcome.fail } });
        throw new IdentityError("invalid-code", "invalid or expired code");
      }
      if ("taken" in outcome) throw conflict(i);
      audit({ action: "identity.pair.claim", target: outcome.ok.id, detail: { ...handle, result: "awaiting-confirmation", humanId: outcome.ok.humanId } });
      return { pairingId: outcome.ok.id, state: "awaiting-confirmation", confirmBy: outcome.ok.confirmBy! };
    },

    /** The owner's side: approve links the claimed handle (proof `pairing_code`); decline discards the claim. */
    confirm(p: { pairingId: string; approve: boolean }, actor: Actor): { pairingId: string; state: PairingState; link?: Link } {
      type Outcome = { state: PairingState; link?: Link; refuse?: IdentityError };
      const id = text(p?.pairingId, "pairingId", 64);
      const out = tx((): Outcome => {
        const r = one("SELECT * FROM pairings WHERE id = ?", id);
        if (!r) throw new IdentityError("not-found", `no such pairing: ${id}`);
        if (r.state !== "claimed") throw new IdentityError("conflict", `pairing is ${String(r.state)}, not waiting for confirmation`);
        const t = now();
        if (t > (r.confirm_by as number)) { run("UPDATE pairings SET state = 'expired', resolved_at = ? WHERE id = ?", t, id); return { state: "expired", refuse: new IdentityError("expired", "the claim was not confirmed in time") }; }
        const i: ChannelIdentity = { channel: r.channel as string, accountId: r.claim_account_id as string, userId: r.claim_user_id as string, ...(r.claim_display_name !== null ? { displayName: r.claim_display_name as string } : {}) };
        if (p.approve !== true) { run("UPDATE pairings SET state = 'declined', resolved_at = ? WHERE id = ?", t, id); return { state: "declined" }; }
        if (activeLink(i)) { run("UPDATE pairings SET state = 'declined', resolved_at = ? WHERE id = ?", t, id); return { state: "declined", refuse: conflict(i) }; }
        requireHuman(r.human_id);
        const link = insertLink(r.human_id as string, i, "pairing_code", actor.user);
        run("UPDATE pairings SET state = 'confirmed', resolved_at = ?, link_id = ? WHERE id = ?", t, link.id, id);
        return { state: "confirmed", link };
      });
      audit({ action: "identity.pair.confirm", target: id, detail: { result: out.state, ...(out.link ? { linkId: out.link.id, humanId: out.link.humanId, channel: out.link.channel, accountId: out.link.accountId, userId: out.link.userId } : {}) }, actor });
      if (out.refuse) throw out.refuse;
      return { pairingId: id, state: out.state, ...(out.link ? { link: out.link } : {}) };
    },

    /** Revokes at once (detaches, never deletes: the record stays for the audit trail). Rows written under its v1 principal become unreadable to the human. */
    unlink(p: { linkId: string }, actor: Actor): Link {
      const id = text(p?.linkId, "linkId", 64);
      const l = tx(() => {
        const r = one("SELECT * FROM identities WHERE id = ?", id);
        if (!r) throw new IdentityError("not-found", `no such link: ${id}`);
        if (r.revoked_at !== null) throw new IdentityError("conflict", "link is already revoked");
        run("UPDATE identities SET revoked_at = ?, revoked_by = ? WHERE id = ?", now(), actor.user, id);
        return linkOf(one("SELECT * FROM identities WHERE id = ?", id)!);
      });
      audit({ action: "identity.unlink", target: id, detail: { humanId: l.humanId, channel: l.channel, accountId: l.accountId, userId: l.userId }, actor });
      return l;
    },

    list(p: { includeRevoked?: boolean }): { humans: Array<Human & { identities: Link[] }>; pairings: Pairing[] } {
      const links = all(p?.includeRevoked ? "SELECT * FROM identities ORDER BY linked_at, id" : "SELECT * FROM identities WHERE revoked_at IS NULL ORDER BY linked_at, id").map(linkOf);
      const humans = all("SELECT * FROM humans ORDER BY created_at, id").map((h) => ({
        id: h.id as string, displayName: h.display_name as string, createdAt: h.created_at as number, identities: links.filter((l) => l.humanId === h.id),
      }));
      const t = now();
      const pairings = all("SELECT * FROM pairings WHERE (state = 'pending' AND expires_at > ?) OR (state = 'claimed' AND confirm_by >= ?) ORDER BY created_at, id", t, t).map(pairingOf);
      return { humans, pairings };
    },

    /** The harness user a channel handle belongs to, by an active link only; never by name or any other similarity. */
    resolve(i: { channel: string; accountId: string; userId: string }): { humanId: string; linkId: string } | null {
      const r = activeLink(i);
      return r ? { humanId: r.human_id as string, linkId: r.id as string } : null;
    },

    /** The v1 principals of every currently linked handle of `humanId`: the read side of the union recall (ADR-007). */
    linkedV1Principals(humanId: string): string[] {
      return all("SELECT v1_principal FROM identities WHERE human_id = ? AND revoked_at IS NULL ORDER BY linked_at, id", humanId).map((r) => r.v1_principal as string);
    },

    close(): void { try { db.close(); } catch { /* closed */ } },
  };
}

export type IdentityService = ReturnType<typeof createIdentityService>;
