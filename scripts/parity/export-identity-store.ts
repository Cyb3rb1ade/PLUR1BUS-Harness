// Parity sequences (ruling R9 of P4-12, "sequences for stateful code") for the identity store and service (task 4):
// `openStore` and every method of `createIdentityService`, driven against a temporary `identity.sqlite` with a scripted clock
// and a scripted random source. `crates/plur1bus-core/src/identity/service_vectors.rs` replays every step and compares the
// result or error, the audit events, the random draws and a dump of every table. Recorded, never edited by hand.
//
// RANDOMNESS. `codes.ts` draws from `node:crypto` (`randomInt(32)` per code symbol, `randomBytes(16)` per salt and per id). The
// exporter replaces both for the time of the build with a deterministic stream (SHA-256 over `<scenario>:<counter>`), restores
// them afterwards, and records every draw of a step in order: `{ below, int }` for `randomInt`, `{ bytes }` for `randomBytes`.
// The replay hands the recorded draws to the Rust code and fails when a draw is missing, left over or of the other kind.
//
// CLOCK. Every step carries `at`, the value the clock returns during that step.
//
// FORMAT. `scenarios.json`: `{ scenarios: [{ name, steps }] }`. A step is one JSON text (one line of the fixture):
// `{ op, args, at, out: { ok } | { err }, audit, draws, tables? }`. `tables` holds the full content (`SELECT * ... ORDER BY 1`,
// rows as arrays in column order) of each table whose content differs from the step before; a table not named is unchanged.
// `err` is `{ code, message, field?, retryAfterMs? }` for an `IdentityError` and `{ sqlite: <extended result code> }` for an
// error SQLite raised that the service lets through.
// `schema.json`: `sqlite_master`, `sqlite_temp_master`, the pragmas and the column names (the order of a dumped row) of a store
// `openStore` has just created.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-identity-store.ts [--check]
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { createIdentityService, IdentityError, type Actor, type AuditEvent, type IdentityService } from "../../packages/core/src/identity/service.ts";
import { deriveUserPrincipal } from "../../packages/core/src/identity/principals.ts";
import { openStore } from "../../packages/core/src/identity/store.ts";
import { exporterMain } from "./lib.mjs";

type Json = any;
const TABLES = ["humans", "identities", "backfills", "attempts", "pairings"] as const;
const T0 = 1_760_000_000_000;
const MIN = 60_000;

/** Replaces `randomInt` and `randomBytes` of `node:crypto` until `restore()`. */
export function scriptRandom() {
  const real = { randomBytes: crypto.randomBytes, randomInt: crypto.randomInt };
  let seed = ""; let n = 0; let log: Json[] = [];
  const next = (len: number): Buffer => {
    const out = Buffer.alloc(len);
    for (let off = 0; off < len;) off += createHash("sha256").update(`${seed}:${n++}`).digest().copy(out, off, 0, Math.min(32, len - off));
    return out;
  };
  (crypto as Json).randomBytes = (len: number) => { const b = next(len); log.push({ bytes: b.toString("hex") }); return b; };
  (crypto as Json).randomInt = (max: number) => { const int = next(4).readUInt32BE(0) % max; log.push({ below: max, int }); return int; };
  syncBuiltinESMExports();
  return {
    reseed(name: string) { seed = name; n = 0; log = []; },
    take(): Json[] { const l = log; log = []; return l; },
    restore() { (crypto as Json).randomBytes = real.randomBytes; (crypto as Json).randomInt = real.randomInt; syncBuiltinESMExports(); },
  };
}
export type Random = ReturnType<typeof scriptRandom>;

function errorOf(e: unknown): Json {
  if (e instanceof IdentityError) return { code: e.code, message: e.message, ...(e.field !== undefined ? { field: e.field } : {}), ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) };
  const errcode = (e as { errcode?: unknown })?.errcode;
  if (typeof errcode === "number") return { sqlite: errcode };
  throw e; // a scenario that makes the service throw anything else is a scenario the typed Rust API cannot express
}
const clone = (v: unknown): Json => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

class World {
  readonly steps: string[] = [];
  t = T0; svc: IdentityService | null = null; db: DatabaseSync | null = null;
  private events: AuditEvent[] = []; private sinkDown = false; private last: Record<string, string> = {};
  private readonly file: string; private readonly rnd: Random;
  constructor(file: string, rnd: Random) { this.file = file; this.rnd = rnd; }

  private dump(): Record<string, Json[][]> {
    const out: Record<string, Json[][]> = {};
    if (!this.db?.isOpen) return out;
    for (const t of TABLES) {
      const rows = (this.db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all() as Record<string, unknown>[]).map((r) => Object.values(r));
      const text = JSON.stringify(rows);
      if (text !== (this.last[t] ?? "[]")) { out[t] = rows; this.last[t] = text; }
    }
    return out;
  }

  private call(op: string, a: Json): unknown {
    if (op === "open") {
      this.last.pairings = "?"; // a new connection has a new, empty TEMP table: the step after an open always names it
      this.svc = createIdentityService({
        dbPath: this.file, clock: () => this.t,
        audit: (e) => { if (this.sinkDown) throw new Error("audit sink down"); this.events.push(e); },
        store: { open: (f) => (this.db = openStore(f)) },
        ...(a.codeTtlMs !== undefined ? { codeTtlMs: a.codeTtlMs } : {}),
      });
      return undefined;
    }
    if (op === "sql") { this.db!.exec(a.text); return undefined; }
    if (op === "sink") { this.sinkDown = a.down; return undefined; }
    const s = this.svc!;
    switch (op) {
      case "close": s.close(); this.svc = null; return undefined;
      case "createHuman": return s.createHuman({ displayName: a.displayName }, a.actor);
      case "link": return s.link({ humanId: a.humanId, identity: a.identity }, a.actor);
      case "revokePairing": return s.revokePairing(a.id, a.actor);
      case "startPairing": return s.startPairing({ humanId: a.humanId, channel: a.channel, ...(a.ttlMs !== undefined ? { ttlMs: a.ttlMs } : {}) }, a.actor);
      case "claim": return s.claim({ code: a.code, identity: a.identity });
      case "confirm": return s.confirm({ pairingId: a.pairingId, approve: a.approve }, a.actor);
      case "unlink": return s.unlink({ linkId: a.linkId }, a.actor);
      case "list": return s.list({ ...(a.includeRevoked !== undefined ? { includeRevoked: a.includeRevoked } : {}), ...(a.includeResolvedPairings !== undefined ? { includeResolvedPairings: a.includeResolvedPairings } : {}) });
      case "resolve": return s.resolve(a.identity);
      case "linkedV1Principals": return s.linkedV1Principals(a.humanId);
      case "jobLink": return s.jobLink(a.humanId);
      case "resolvePrincipals": return s.resolvePrincipals(a.userV2);
      case "getLink": return s.getLink(a.linkId);
      case "backfillRecord": return s.backfillRecord(a.linkId) ?? null;
      case "reserveBackfill": return s.reserveBackfill(a.linkId, a.operationId, a.actor);
      case "finishBackfill": return s.finishBackfill(a.linkId, a.state, a.count, a.receipt);
      case "authorizeAction": return s.authorizeAction(a.action, a.user, a.actor);
      case "emit": return s.emit(a.event);
      default: throw new Error(`unknown op ${op}`);
    }
  }

  private step(op: string, args: Json): { ok?: Json; err?: Json } {
    this.events = []; this.rnd.take();
    let out: { ok?: Json; err?: Json };
    try { out = { ok: clone(this.call(op, args)) }; } catch (e) { out = { err: errorOf(e) }; }
    const tables = this.dump();
    this.steps.push(JSON.stringify({ op, args: clone(args), at: this.t, out, audit: clone(this.events), draws: this.rnd.take(), ...(Object.keys(tables).length ? { tables } : {}) }));
    return out;
  }
  /** Runs a step that must succeed and returns its result. */
  ok(op: string, args: Json = {}): Json {
    const out = this.step(op, args);
    if (out.err) throw new Error(`${op} ${JSON.stringify(args)}: expected a result, got ${JSON.stringify(out.err)}`);
    return out.ok;
  }
  /** Runs a step that must fail with `code` (an `IdentityError` code, or `sqlite`). */
  err(op: string, args: Json, code: string): Json {
    const out = this.step(op, args);
    const got = out.err ? (out.err.code ?? "sqlite") : "ok";
    if (got !== code) throw new Error(`${op} ${JSON.stringify(args)}: expected ${code}, got ${got} ${JSON.stringify(out)}`);
    return out.err;
  }
  /** Runs a step whose outcome the scenario does not fix (an authorization grid). */
  any(op: string, args: Json = {}): { ok?: Json; err?: Json } { return this.step(op, args); }
  count(table: string): number { return (this.db!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; }
}

const OWNER: Actor = { user: "owner-1", host: "mac", kind: "person", role: "owner" };
const ADMIN: Actor = { user: "admin-1", host: "box", kind: "person", role: "admin" };
const tg = (userId: string, displayName?: string) => ({ channel: "telegram", accountId: "bot-1", userId, ...(displayName !== undefined ? { displayName } : {}) });
const self = (id: string, role: Actor["role"], extra: Partial<Actor> = {}): Actor => ({ user: id, host: "phone", kind: "person", role, ...extra });

const SCENARIOS: Record<string, (w: World) => void> = {
  "link-resolve-unlink"(w) {
    w.ok("open");
    const a = w.ok("createHuman", { displayName: "Ada", actor: OWNER });
    w.t += 1;
    const b = w.ok("createHuman", { displayName: "Bo", actor: ADMIN });
    const l1 = w.ok("link", { humanId: a.id, identity: tg("1001", "ada_tg"), actor: OWNER });
    w.err("link", { humanId: b.id, identity: tg("1001"), actor: OWNER }, "conflict");
    w.err("link", { humanId: "no-such-human", identity: tg("1002"), actor: OWNER }, "not-found");
    w.ok("resolve", { identity: tg("1001") });
    w.ok("resolve", { identity: tg("1001", "another label") });
    w.ok("resolve", { identity: tg("nobody") });
    w.ok("resolve", { identity: { channel: "telegram", accountId: "bot-2", userId: "1001" } });
    w.t += 5;
    // Same instant for the next two links: `ORDER BY linked_at, id` decides.
    w.ok("link", { humanId: a.id, identity: { channel: "cli", accountId: "local", userId: "ada" }, actor: OWNER });
    w.ok("link", { humanId: a.id, identity: { channel: "discord", accountId: "guild", userId: "ada#1" }, actor: ADMIN });
    w.ok("link", { humanId: a.id, identity: { channel: "matrix", accountId: "hs", userId: "@ada:hs" }, actor: OWNER });
    w.ok("list");
    w.ok("linkedV1Principals", { humanId: a.id });
    w.ok("linkedV1Principals", { humanId: b.id });
    w.err("linkedV1Principals", { humanId: "missing" }, "not-found");
    w.err("linkedV1Principals", { humanId: "" }, "invalid-params");
    w.ok("jobLink", { humanId: a.id });
    w.ok("jobLink", { humanId: b.id });
    w.ok("jobLink", { humanId: "missing" });
    w.ok("resolvePrincipals", { userV2: deriveUserPrincipal(a.id) });
    w.ok("resolvePrincipals", { userV2: deriveUserPrincipal(b.id) });
    w.err("resolvePrincipals", { userV2: `user:v1:${"0".repeat(64)}` }, "invalid-params");
    w.err("resolvePrincipals", { userV2: "user:v2:short" }, "invalid-params");
    w.err("resolvePrincipals", { userV2: `user:v2:${"0".repeat(64)}` }, "not-found");
    w.ok("getLink", { linkId: l1.id });
    w.err("getLink", { linkId: "no-such-link" }, "not-found");
    w.err("getLink", { linkId: "x".repeat(65) }, "invalid-params");
    w.t += 5;
    w.ok("unlink", { linkId: l1.id, actor: ADMIN });
    w.err("unlink", { linkId: l1.id, actor: OWNER }, "conflict");
    w.err("unlink", { linkId: "no-such-link", actor: OWNER }, "not-found");
    w.ok("getLink", { linkId: l1.id });
    w.ok("resolve", { identity: tg("1001") });
    w.ok("jobLink", { humanId: a.id });
    w.ok("list");
    w.ok("list", { includeRevoked: true });
    w.ok("list", { includeRevoked: false, includeResolvedPairings: true });
    // A revoked handle is free again, for another human too; the first human's union no longer holds it.
    w.ok("link", { humanId: b.id, identity: tg("1001", "now Bo"), actor: OWNER });
    w.ok("linkedV1Principals", { humanId: a.id });
    w.ok("resolvePrincipals", { userV2: deriveUserPrincipal(b.id) });
    // The same v1 principal twice (linked, revoked, linked again to the same human) appears once in the union.
    const again = w.ok("link", { humanId: a.id, identity: { channel: "slack", accountId: "T1", userId: "U1" }, actor: OWNER });
    w.ok("unlink", { linkId: again.id, actor: OWNER });
    w.ok("link", { humanId: a.id, identity: { channel: "slack", accountId: "T1", userId: "U1" }, actor: OWNER });
    w.ok("resolvePrincipals", { userV2: deriveUserPrincipal(a.id) });
    w.ok("jobLink", { humanId: a.id });
    w.ok("close");
  },

  "authorization"(w) {
    w.ok("open");
    const h = w.ok("createHuman", { displayName: "Member", actor: OWNER });
    const other = w.ok("createHuman", { displayName: "Other", actor: OWNER });
    const actors: Actor[] = [
      OWNER, ADMIN,
      { user: "op-1", host: "h", kind: "person", role: "operator" },
      self(h.id, "member"), self(h.id, "viewer"), self(h.id, "operator"),
      self(h.id, "member", { tokenScopes: [] }), self(h.id, "member", { tokenScopes: ["my.write"] }), self(h.id, "member", { tokenScopes: ["users.manage"] }),
      { ...OWNER, tokenScopes: ["my.write"] }, { ...OWNER, tokenScopes: ["users.manage"] }, { ...OWNER, tokenScopes: [] },
      { user: h.id, host: "h", kind: "agent", role: "owner" }, { user: "owner-1", host: "h", kind: "agent", role: "owner" },
      { user: h.id, host: "h", role: "owner" }, { user: h.id, host: "h", kind: "person" }, { user: h.id, host: "h" },
    ];
    for (const actor of actors) for (const action of ["create", "link", "unlink", "pair", "confirm", "backfill"]) for (const user of [h.id, other.id])
      w.any("authorizeAction", { action, user, actor });
    // Through the methods: what is checked first.
    const member = self(h.id, "member");
    const agent: Actor = { user: h.id, host: "h", kind: "agent", role: "owner" };
    w.err("createHuman", { displayName: "x", actor: member }, "denied");
    w.err("createHuman", { displayName: "", actor: agent }, "denied"); // denied before the name is looked at
    w.err("link", { humanId: h.id, identity: { channel: "BAD", accountId: "", userId: "" }, actor: agent }, "denied");
    w.err("link", { humanId: other.id, identity: tg("1"), actor: member }, "denied");
    w.any("link", { humanId: h.id, identity: tg("2"), actor: member });
    w.err("startPairing", { humanId: other.id, channel: "telegram", actor: member }, "denied");
    w.err("startPairing", { humanId: h.id, channel: "telegram", ttlMs: 1, actor: agent }, "invalid-params"); // the TTL is checked before the actor
    w.err("startPairing", { humanId: h.id, channel: "BAD", actor: agent }, "denied"); // the actor before the channel
    const own = w.any("startPairing", { humanId: h.id, channel: "telegram", actor: member });
    const foreign = w.ok("startPairing", { humanId: other.id, channel: "telegram", actor: OWNER });
    w.err("revokePairing", { id: foreign.pairingId, actor: member }, "denied");
    w.err("revokePairing", { id: "no-such-pairing", actor: agent }, "not-found"); // existence before the actor
    w.ok("claim", { code: foreign.code, identity: tg("77") });
    w.err("confirm", { pairingId: foreign.pairingId, approve: true, actor: member }, "denied");
    w.err("confirm", { pairingId: "no-such-pairing", approve: true, actor: agent }, "not-found");
    w.err("confirm", { pairingId: foreign.pairingId, approve: true, actor: agent }, "denied");
    w.ok("confirm", { pairingId: foreign.pairingId, approve: true, actor: self(other.id, "member") });
    if (own.ok) { w.ok("claim", { code: own.ok.code, identity: tg("78") }); w.any("confirm", { pairingId: own.ok.pairingId, approve: true, actor: member }); }
    const links = w.ok("list").humans.flatMap((x: Json) => x.identities);
    for (const l of links) { w.err("unlink", { linkId: l.id, actor: agent }, "denied"); w.any("unlink", { linkId: l.id, actor: member }); }
    w.err("unlink", { linkId: "no-such-link", actor: agent }, "not-found");
    w.ok("close");
  },

  "pairing-claim-confirm"(w) {
    w.ok("open");
    const h = w.ok("createHuman", { displayName: "Ada", actor: OWNER });
    const p = w.ok("startPairing", { humanId: h.id, channel: "telegram", actor: OWNER });
    w.ok("list");
    const z = tg("2001", "Zed");
    w.err("claim", { code: "AAAAAAAA", identity: z }, "invalid-code");
    w.err("claim", { code: p.code, identity: { ...z, channel: "discord" } }, "invalid-code"); // the right code on another channel
    w.err("claim", { code: p.code.slice(0, 7), identity: z }, "invalid-code");
    w.err("claim", { code: `${p.code}A`, identity: z }, "invalid-code");
    w.err("claim", { code: "", identity: tg("2002") }, "invalid-code");
    w.err("claim", { code: "A".repeat(129), identity: tg("2002") }, "invalid-code");
    w.err("claim", { code: p.code, identity: { channel: "telegram", accountId: "", userId: "x" } }, "invalid-params");
    w.err("claim", { code: p.code, identity: { channel: "Telegram", accountId: "a", userId: "x" } }, "invalid-params");
    w.err("claim", { code: p.code, identity: { ...z, displayName: "" } }, "invalid-params");
    w.t += 30_000;
    // What a person types: lower case, hyphen, spaces.
    const typed = ` ${p.code.slice(0, 4).toLowerCase()}-${p.code.slice(4).toLowerCase()}\t`;
    const c = w.ok("claim", { code: typed, identity: z });
    if (c.pairingId !== p.pairingId) throw new Error("claimed another pairing");
    w.err("claim", { code: p.code, identity: tg("2003") }, "invalid-code"); // single use
    w.ok("list");
    w.ok("resolve", { identity: z }); // a claim links nothing
    w.t += 1_000;
    const done = w.ok("confirm", { pairingId: p.pairingId, approve: true, actor: OWNER });
    if (done.state !== "confirmed") throw new Error("not confirmed");
    w.err("confirm", { pairingId: p.pairingId, approve: true, actor: OWNER }, "conflict");
    w.err("confirm", { pairingId: "x".repeat(65), approve: true, actor: OWNER }, "invalid-params");
    w.ok("resolve", { identity: z });
    w.ok("list");
    w.ok("list", { includeResolvedPairings: true });
    // Decline: the claim is discarded and the code is spent.
    const q = w.ok("startPairing", { humanId: h.id, channel: "discord", actor: ADMIN });
    const dz = { channel: "discord", accountId: "guild", userId: "zed#2" };
    w.ok("claim", { code: q.code, identity: dz });
    const no = w.ok("confirm", { pairingId: q.pairingId, approve: false, actor: OWNER });
    if (no.state !== "declined") throw new Error("not declined");
    w.err("claim", { code: q.code, identity: dz }, "invalid-code");
    w.ok("resolve", { identity: dz });
    // A pending pairing cannot be confirmed.
    const r = w.ok("startPairing", { humanId: h.id, channel: "discord", actor: OWNER });
    w.err("confirm", { pairingId: r.pairingId, approve: true, actor: OWNER }, "conflict");
    w.ok("list", { includeResolvedPairings: true });
    w.ok("close");
  },

  "expiry-and-confirm-window"(w) {
    w.ok("open");
    const h = w.ok("createHuman", { displayName: "Ada", actor: OWNER });
    // Default lifetime (10 minutes): usable up to the last millisecond, gone at the deadline.
    const a = w.ok("startPairing", { humanId: h.id, channel: "telegram", actor: OWNER });
    w.t = a.expiresAt;
    w.ok("list"); w.ok("list", { includeResolvedPairings: true });
    w.err("claim", { code: a.code, identity: tg("1") }, "invalid-code"); // reason: expired
    const b = w.ok("startPairing", { humanId: h.id, channel: "telegram", actor: OWNER });
    w.t = b.expiresAt - 1;
    const cb = w.ok("claim", { code: b.code, identity: tg("2") }); // lifetime == default: confirmBy = claim + default
    w.t = cb.confirmBy - 1;
    w.ok("list");
    w.t = cb.confirmBy;
    w.ok("list"); w.ok("list", { includeResolvedPairings: true });
    w.err("confirm", { pairingId: b.pairingId, approve: true, actor: OWNER }, "expired"); // the state change is committed, then refused
    w.err("confirm", { pairingId: b.pairingId, approve: true, actor: OWNER }, "conflict");
    w.ok("resolve", { identity: tg("2") });
    // A short code (one minute): the owner's window ends with the code.
    const c = w.ok("startPairing", { humanId: h.id, channel: "telegram", ttlMs: MIN, actor: OWNER });
    w.t += 20_000;
    const cc = w.ok("claim", { code: c.code, identity: tg("3") });
    if (cc.confirmBy !== c.expiresAt) throw new Error("short code: confirmBy is not the code's end");
    w.t = cc.confirmBy - 1;
    w.ok("confirm", { pairingId: c.pairingId, approve: true, actor: OWNER });
    // A long code (one hour, an invitation): the owner's window is the default from the claim.
    const d = w.ok("startPairing", { humanId: h.id, channel: "telegram", ttlMs: 60 * MIN, actor: OWNER });
    w.t += 55 * MIN;
    const cd = w.ok("claim", { code: d.code, identity: tg("4") });
    if (cd.confirmBy !== w.t + 10 * MIN) throw new Error("long code: confirmBy is not claim + default");
    w.t = d.expiresAt + 1; // past the code's own end, inside the owner's window
    w.ok("confirm", { pairingId: d.pairingId, approve: false, actor: OWNER });
    // Declining after the window: expired wins.
    const e = w.ok("startPairing", { humanId: h.id, channel: "telegram", actor: OWNER });
    const ce = w.ok("claim", { code: e.code, identity: tg("5") });
    w.t = ce.confirmBy + 5;
    w.err("confirm", { pairingId: e.pairingId, approve: false, actor: OWNER }, "expired");
    w.ok("list", { includeResolvedPairings: true });
    w.ok("close");
  },

  "claim-limits"(w) {
    w.ok("open");
    const h = w.ok("createHuman", { displayName: "Ada", actor: OWNER });
    const p = w.ok("startPairing", { humanId: h.id, channel: "telegram", ttlMs: 60 * MIN, actor: OWNER });
    const x = tg("x");
    for (let i = 0; i < 4; i++) { w.t += 1_000; w.err("claim", { code: "WRONGWRG", identity: x }, "invalid-code"); }
    // The window still holds exactly `windowMs` after its start; one millisecond later the count starts again.
    w.t = T0 + 1_000 + 15 * MIN;
    w.err("claim", { code: "WRONGWRG", identity: x }, "invalid-code"); // fifth in the window: locks this handle
    w.err("claim", { code: p.code, identity: x }, "rate-limited"); // the right code is refused too
    w.err("claim", { code: p.code, identity: tg("x", "other label") }, "rate-limited"); // the label is not part of the key
    w.t += 15 * MIN - 1;
    w.err("claim", { code: p.code, identity: x }, "rate-limited"); // one millisecond left
    w.t += 1;
    w.err("claim", { code: "WRONGWRG", identity: x }, "invalid-code"); // the lock is over; a new window starts
    w.t += 15 * MIN + 1;
    w.err("claim", { code: "WRONGWRG", identity: x }, "invalid-code"); // past the window: counted from one again
    // Every handle together: 20 failures in a window lock all claims. One is counted so far: the window of the overall key rolled twice.
    let n = 0;
    while (true) {
      const out = w.any("claim", { code: "WRONGWRG", identity: tg(`y${Math.floor(n / 4)}`) });
      n += 1;
      if (out.err?.code === "rate-limited") break;
      if (n > 40) throw new Error("the overall limit never locked");
    }
    const q = w.ok("startPairing", { humanId: h.id, channel: "telegram", ttlMs: 60 * MIN, actor: OWNER }); // issuing is not claiming
    w.err("claim", { code: q.code, identity: tg("innocent") }, "rate-limited");
    w.t += 15 * MIN - 1;
    w.err("claim", { code: q.code, identity: tg("y0") }, "rate-limited");
    w.t += 1;
    w.err("claim", { code: "WRONGWRG", identity: tg("y0") }, "invalid-code"); // the fifth of this handle, counted before the lock: locks it
    w.err("claim", { code: q.code, identity: tg("y0") }, "rate-limited");
    const c = w.ok("claim", { code: q.code, identity: tg("y1") }); // a success forgets this handle's failures
    w.ok("confirm", { pairingId: c.pairingId, approve: true, actor: OWNER });
    w.ok("close");
  },

  "issuance-limits"(w) {
    w.ok("open");
    const h = w.ok("createHuman", { displayName: "Ada", actor: OWNER });
    const g = w.ok("createHuman", { displayName: "Gus", actor: OWNER });
    const first = [0, 1, 2].map(() => w.ok("startPairing", { humanId: h.id, channel: "telegram", ttlMs: MIN, actor: OWNER }));
    w.err("startPairing", { humanId: h.id, channel: "telegram", ttlMs: MIN, actor: OWNER }, "limit");
    w.ok("startPairing", { humanId: h.id, channel: "discord", ttlMs: MIN, actor: OWNER }); // per channel
    w.ok("startPairing", { humanId: g.id, channel: "telegram", ttlMs: MIN, actor: OWNER }); // per human
    // A claimed code keeps its place while the owner's window runs.
    w.ok("claim", { code: first[0].code, identity: tg("1") });
    w.err("startPairing", { humanId: h.id, channel: "telegram", ttlMs: MIN, actor: OWNER }, "limit");
    w.ok("revokePairing", { id: first[1].pairingId, actor: OWNER }); // a revoked one frees its place
    w.ok("startPairing", { humanId: h.id, channel: "telegram", ttlMs: MIN, actor: OWNER });
    // Ten issuances for one human in 15 minutes lock that human's issuance; five are counted (a refused one is not).
    w.t += MIN + 1;
    for (let i = 0; i < 3; i++) w.ok("startPairing", { humanId: h.id, channel: "telegram", ttlMs: MIN, actor: OWNER });
    w.ok("startPairing", { humanId: h.id, channel: "discord", ttlMs: MIN, actor: OWNER });
    w.ok("startPairing", { humanId: h.id, channel: "slack", ttlMs: MIN, actor: OWNER }); // the tenth: issued, and locks
    w.err("startPairing", { humanId: h.id, channel: "matrix", ttlMs: MIN, actor: OWNER }, "rate-limited");
    w.ok("startPairing", { humanId: g.id, channel: "discord", ttlMs: MIN, actor: OWNER }); // another human is not locked
    w.t += 15 * MIN - 1;
    w.err("startPairing", { humanId: h.id, channel: "matrix", ttlMs: MIN, actor: OWNER }, "rate-limited");
    w.t += 1;
    w.ok("startPairing", { humanId: h.id, channel: "matrix", ttlMs: MIN, actor: OWNER });
    // All humans together: 100 in 15 minutes. The counter is set to 99 here instead of issuing 99 codes.
    w.ok("sql", { text: `UPDATE attempts SET failures = 99, window_start = ${w.t}, locked_until = 0 WHERE key = 'issue:global'` });
    w.ok("startPairing", { humanId: g.id, channel: "slack", ttlMs: MIN, actor: OWNER }); // the hundredth
    w.err("startPairing", { humanId: g.id, channel: "irc", ttlMs: MIN, actor: OWNER }, "rate-limited");
    w.err("startPairing", { humanId: "no-such-human", channel: "irc", actor: OWNER }, "not-found"); // the human before the lock
    w.t += 15 * MIN - 1;
    w.err("startPairing", { humanId: g.id, channel: "irc", ttlMs: MIN, actor: OWNER }, "rate-limited");
    w.t += 1;
    w.ok("startPairing", { humanId: g.id, channel: "irc", ttlMs: MIN, actor: OWNER });
    w.ok("close");
  },

  "claims-per-human-and-release"(w) {
    w.ok("open");
    const h = w.ok("createHuman", { displayName: "Ada", actor: OWNER });
    const start = (channel: string) => w.ok("startPairing", { humanId: h.id, channel, actor: OWNER });
    const codes = ["telegram", "telegram", "telegram", "discord", "discord", "discord", "slack"].map(start);
    const who = (i: number) => ({ channel: codes[i].channel, accountId: "acc", userId: `u${i}` });
    for (let i = 0; i < 5; i++) { w.t += 1_000; w.ok("claim", { code: codes[i].code, identity: who(i) }); } // the fifth claim locks claims for this human
    w.err("claim", { code: codes[5].code, identity: who(5) }, "rate-limited"); // a right code; it stays usable
    w.ok("confirm", { pairingId: codes[1].pairingId, approve: false, actor: OWNER }); // a declined claim stays counted
    w.err("claim", { code: codes[5].code, identity: who(5) }, "rate-limited");
    w.ok("confirm", { pairingId: codes[0].pairingId, approve: true, actor: OWNER }); // a confirmed one frees its place and lifts the lock
    w.ok("claim", { code: codes[5].code, identity: who(5) }); // the fifth again: locks again
    w.err("claim", { code: codes[6].code, identity: who(6) }, "rate-limited");
    w.ok("confirm", { pairingId: codes[2].pairingId, approve: true, actor: OWNER });
    w.ok("confirm", { pairingId: codes[3].pairingId, approve: true, actor: OWNER }); // no lock to lift: one less in the count
    w.ok("claim", { code: codes[6].code, identity: who(6) });
    w.ok("list");
    w.ok("close");
  },

  "taken-handles"(w) {
    w.ok("open");
    const h = w.ok("createHuman", { displayName: "Ada", actor: OWNER });
    const g = w.ok("createHuman", { displayName: "Gus", actor: OWNER });
    w.ok("link", { humanId: g.id, identity: tg("taken"), actor: OWNER });
    const p = w.ok("startPairing", { humanId: h.id, channel: "telegram", actor: OWNER });
    w.err("claim", { code: p.code, identity: tg("taken") }, "conflict"); // nothing counted, the code stays usable
    w.err("claim", { code: p.code, identity: tg("taken") }, "conflict");
    const c = w.ok("claim", { code: p.code, identity: tg("free", "Free") });
    // The handle is linked by hand while the claim waits: confirming declines it and reports the conflict.
    w.ok("link", { humanId: g.id, identity: tg("free"), actor: OWNER });
    w.err("confirm", { pairingId: c.pairingId, approve: true, actor: OWNER }, "conflict");
    w.err("confirm", { pairingId: c.pairingId, approve: true, actor: OWNER }, "conflict"); // now: not waiting any more
    w.ok("list", { includeResolvedPairings: true });
    w.ok("close");
  },

  "revoke-pairing"(w) {
    w.ok("open");
    const h = w.ok("createHuman", { displayName: "Ada", actor: OWNER });
    const a = w.ok("startPairing", { humanId: h.id, channel: "telegram", actor: OWNER });
    const b = w.ok("startPairing", { humanId: h.id, channel: "telegram", actor: OWNER });
    const c = w.ok("startPairing", { humanId: h.id, channel: "telegram", actor: OWNER });
    w.ok("revokePairing", { id: a.pairingId, actor: OWNER }); // pending
    w.err("claim", { code: a.code, identity: tg("1") }, "invalid-code"); // reason: reused
    w.ok("claim", { code: b.code, identity: tg("2") });
    w.t += 7;
    w.ok("revokePairing", { id: b.pairingId, actor: ADMIN }); // claimed
    w.err("confirm", { pairingId: b.pairingId, approve: true, actor: OWNER }, "conflict");
    w.ok("revokePairing", { id: b.pairingId, actor: OWNER }); // declined again: allowed, the time moves
    w.ok("claim", { code: c.code, identity: tg("3") });
    w.ok("confirm", { pairingId: c.pairingId, approve: true, actor: OWNER });
    w.err("revokePairing", { id: c.pairingId, actor: OWNER }, "conflict"); // confirmed
    w.err("revokePairing", { id: "no-such-pairing", actor: OWNER }, "not-found");
    w.err("revokePairing", { id: "", actor: OWNER }, "invalid-params");
    w.err("revokePairing", { id: "x".repeat(65), actor: OWNER }, "invalid-params");
    w.ok("list", { includeResolvedPairings: true });
    w.ok("close");
  },

  "validation"(w) {
    w.ok("open");
    const pair = "\u{1F600}"; // two UTF-16 units
    for (const displayName of ["", "A", "a".repeat(128), "a".repeat(129), `${"a".repeat(126)}${pair}`, `${"a".repeat(127)}${pair}`, "é".repeat(128), "tab\there", "nul\u0000", "del\u007f", "c1\u0080 is allowed", " padded ", "line sep"])
      w.any("createHuman", { displayName, actor: OWNER });
    const h = w.ok("createHuman", { displayName: "Ada", actor: OWNER });
    for (const channel of ["telegram", "t", "T", "", "1abc", "a.b_c-d9", `a${"b".repeat(31)}`, `a${"b".repeat(32)}`, "tele gram", "telegram\n", "télégram", "-abc"])
      w.any("link", { humanId: h.id, identity: { channel, accountId: "acc", userId: `chan:${channel}` }, actor: OWNER });
    for (const [field, value] of [["accountId", ""], ["accountId", "a".repeat(128)], ["accountId", "a".repeat(129)], ["accountId", "a\u001fb"], ["userId", ""], ["userId", "u".repeat(128)], ["userId", "u".repeat(129)], ["userId", `${"u".repeat(127)}${pair}`], ["userId", "u\rb"], ["displayName", ""], ["displayName", "d".repeat(129)], ["displayName", "ok name"]] as const)
      w.any("link", { humanId: h.id, identity: { channel: "telegram", accountId: "v", userId: `f:${field}:${value.length}`, [field]: value }, actor: OWNER });
    w.err("link", { humanId: "h".repeat(65), identity: tg("long-human"), actor: OWNER }, "invalid-params");
    w.err("link", { humanId: "", identity: tg("empty-human"), actor: OWNER }, "invalid-params");
    w.err("link", { humanId: "h".repeat(64), identity: tg("unknown-human"), actor: OWNER }, "not-found");
    for (const ttlMs of [MIN - 1, MIN, MIN + 0.5, 60 * MIN, 60 * MIN + 1, 0, -MIN])
      w.any("startPairing", { humanId: h.id, channel: `ttl${Math.abs(Math.round(ttlMs))}`.slice(0, 32), ttlMs, actor: OWNER });
    w.err("startPairing", { humanId: h.id, channel: "Telegram", actor: OWNER }, "invalid-params");
    w.err("startPairing", { humanId: "", channel: "telegram", actor: OWNER }, "invalid-params");
    w.err("unlink", { linkId: "", actor: OWNER }, "invalid-params");
    w.err("unlink", { linkId: "l".repeat(65), actor: OWNER }, "invalid-params");
    w.ok("close");
    // A configured lifetime: the default and the ceiling of a per-code lifetime at once.
    for (const codeTtlMs of [0, -1, 60 * MIN + 1]) w.err("open", { codeTtlMs }, "invalid-params");
    w.ok("open", { codeTtlMs: 60 * MIN });
    w.ok("close");
    w.ok("open", { codeTtlMs: 2 * MIN });
    const a = w.ok("startPairing", { humanId: h.id, channel: "cfg", actor: OWNER });
    if (a.expiresAt !== w.t + 2 * MIN) throw new Error("configured lifetime not used");
    w.ok("startPairing", { humanId: h.id, channel: "cfg", ttlMs: 2 * MIN, actor: OWNER });
    w.err("startPairing", { humanId: h.id, channel: "cfg", ttlMs: 2 * MIN + 1, actor: OWNER }, "invalid-params");
    const ca = w.ok("claim", { code: a.code, identity: { channel: "cfg", accountId: "a", userId: "u" } });
    if (ca.confirmBy !== w.t + 2 * MIN) throw new Error("configured lifetime not used for the owner's window");
    w.ok("close");
    w.ok("open", { codeTtlMs: MIN / 2 }); // below the smallest per-code lifetime: every explicit lifetime is refused
    w.err("startPairing", { humanId: h.id, channel: "half", ttlMs: MIN, actor: OWNER }, "invalid-params");
    w.ok("startPairing", { humanId: h.id, channel: "half", actor: OWNER });
    w.ok("close");
  },

  "reopen-prune-and-newer-schema"(w) {
    w.ok("open");
    const h = w.ok("createHuman", { displayName: "Ada", actor: OWNER });
    const p = w.ok("startPairing", { humanId: h.id, channel: "telegram", actor: OWNER });
    w.err("claim", { code: "WRONGWRG", identity: tg("1") }, "invalid-code");
    for (let i = 0; i < 5; i++) w.err("claim", { code: "WRONGWRG", identity: tg("2") }, "invalid-code"); // the fifth locks this handle
    w.ok("link", { humanId: h.id, identity: tg("kept"), actor: OWNER });
    w.ok("close");
    w.ok("open"); // pending proofs are gone with the connection; counters and links stay
    w.err("claim", { code: p.code, identity: tg("3") }, "invalid-code");
    w.err("claim", { code: p.code, identity: tg("2") }, "rate-limited"); // a restart does not reset a lock
    w.ok("list", { includeResolvedPairings: true });
    w.ok("close");
    // Counters are dropped once the lock is over and the window started more than 24 hours ago, both strictly.
    w.t += 24 * 60 * MIN;
    w.ok("open");
    w.ok("close");
    w.t += 15 * MIN + 1;
    w.ok("open");
    w.ok("close");
    w.ok("open");
    w.ok("sql", { text: "PRAGMA user_version = 3" });
    w.ok("close");
    w.err("open", {}, "storage");
    w.err("open", {}, "storage");
  },

  "backfill-records"(w) {
    w.ok("open");
    const h = w.ok("createHuman", { displayName: "Ada", actor: OWNER });
    const l = w.ok("link", { humanId: h.id, identity: tg("1"), actor: OWNER });
    const m = w.ok("link", { humanId: h.id, identity: tg("2"), actor: OWNER });
    w.ok("backfillRecord", { linkId: l.id });
    w.ok("reserveBackfill", { linkId: l.id, operationId: "op-1", actor: OWNER });
    w.ok("backfillRecord", { linkId: l.id });
    w.t += 9;
    w.ok("reserveBackfill", { linkId: l.id, operationId: "op-2", actor: ADMIN }); // kept: the first reservation stands
    w.ok("backfillRecord", { linkId: l.id });
    w.err("reserveBackfill", { linkId: m.id, operationId: "op-1", actor: OWNER }, "sqlite"); // an operation id is used once
    w.err("reserveBackfill", { linkId: "no-such-link", operationId: "op-3", actor: OWNER }, "sqlite");
    w.err("unlink", { linkId: l.id, actor: OWNER }, "conflict"); // running
    w.err("finishBackfill", { linkId: l.id, state: "reversing", count: 0, receipt: "r" }, "conflict");
    w.err("finishBackfill", { linkId: l.id, state: "reversed", count: 0, receipt: "r" }, "conflict");
    w.ok("finishBackfill", { linkId: l.id, state: "applied", count: 3, receipt: "{\"rows\":3}" });
    w.ok("finishBackfill", { linkId: l.id, state: "applied", count: 4, receipt: "again" });
    w.ok("backfillRecord", { linkId: l.id });
    w.err("finishBackfill", { linkId: l.id, state: "reversed", count: 0, receipt: "r" }, "conflict");
    w.ok("finishBackfill", { linkId: l.id, state: "reversing", count: 4, receipt: "undo" });
    w.err("unlink", { linkId: l.id, actor: OWNER }, "conflict"); // reversing
    w.err("finishBackfill", { linkId: l.id, state: "applied", count: 0, receipt: "r" }, "conflict");
    w.ok("finishBackfill", { linkId: l.id, state: "reversed", count: 0, receipt: "undone" });
    w.ok("finishBackfill", { linkId: l.id, state: "reversed", count: 0, receipt: "undone twice" });
    w.err("finishBackfill", { linkId: m.id, state: "applied", count: 0, receipt: "r" }, "conflict"); // never reserved
    w.ok("unlink", { linkId: l.id, actor: OWNER });
    w.ok("backfillRecord", { linkId: l.id });
    w.ok("close");
  },

  "stored-principal-is-checked"(w) {
    w.ok("open");
    const h = w.ok("createHuman", { displayName: "Ada", actor: OWNER });
    const l = w.ok("link", { humanId: h.id, identity: tg("1"), actor: OWNER });
    w.ok("link", { humanId: h.id, identity: tg("2"), actor: OWNER });
    for (const bad of [`user:v2:${"a".repeat(64)}`, `user:v1:${"A".repeat(64)}`, `user:v1:${"a".repeat(63)}`, "plain"]) {
      w.ok("sql", { text: `UPDATE identities SET v1_principal = '${bad}' WHERE id = '${l.id}'` });
      w.err("linkedV1Principals", { humanId: h.id }, "storage");
      w.err("resolvePrincipals", { userV2: deriveUserPrincipal(h.id) }, "storage");
    }
    w.ok("unlink", { linkId: l.id, actor: OWNER }); // a revoked row is not read
    w.ok("linkedV1Principals", { humanId: h.id });
    w.ok("close");
  },

  "audit-events"(w) {
    w.ok("open");
    const event = (action: string, detail: Json, actor?: Actor) => w.ok("emit", { event: { action, target: "target-1", detail, ...(actor ? { actor } : {}) } });
    event("identity.custom", { channel: "telegram", proof: "pairing_code", result: "done", reason: "because", note: "hashed", n: 1, flag: true, none: null, nested: { inner: "kept as it is" }, list: ["kept"] }, OWNER);
    event("identity.custom", {});
    for (const action of ["identity.link", "identity.pair.start", "identity.unlink", "identity.pair.rate-limited", "identity.human.create", "identity.pair.revoke", "link.requested"]) event(action, { humanId: "h" }, ADMIN);
    for (const result of ["confirmed", "declined", "expired", "other"]) event("identity.pair.confirm", { result }, OWNER);
    for (const result of ["refused", "awaiting-confirmation"]) event("identity.pair.claim", { result, reason: "wrong" });
    // A sink that throws decides nothing.
    w.ok("sink", { down: true });
    const h = w.ok("createHuman", { displayName: "Ada", actor: OWNER });
    const p = w.ok("startPairing", { humanId: h.id, channel: "telegram", actor: OWNER });
    w.err("claim", { code: "WRONGWRG", identity: tg("1") }, "invalid-code");
    w.ok("claim", { code: p.code, identity: tg("1") });
    w.ok("confirm", { pairingId: p.pairingId, approve: true, actor: OWNER });
    w.ok("sink", { down: false });
    w.ok("list");
    w.ok("close");
  },
};

function buildSchema(file: string): Json {
  const db = openStore(file);
  try {
    const rows = (table: string) => db.prepare(`SELECT type, name, tbl_name, sql FROM ${table} ORDER BY type, name`).all();
    const pragma = (name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
    return {
      master: rows("sqlite_master"), temp: rows("sqlite_temp_master"),
      columns: Object.fromEntries(TABLES.map((t) => [t, (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name)])),
      pragmas: Object.fromEntries(["journal_mode", "foreign_keys", "busy_timeout", "temp_store", "secure_delete", "user_version", "synchronous"].map((n) => [n, pragma(n)])),
    };
  } finally { db.close(); }
}

/** `{ scenarios, schema }`: the fixtures of `fixtures/parity/identity-store/`. */
export function buildIdentityStoreVectors(): Record<string, unknown> {
  const dir = mkdtempSync(path.join(tmpdir(), "p1b-parity-identity-store-"));
  const rnd = scriptRandom();
  try {
    const scenarios = Object.entries(SCENARIOS).map(([name, run], i) => {
      rnd.reseed(name);
      const w = new World(path.join(dir, `s${i}`, "identity.sqlite"), rnd);
      try { run(w); } finally { w.svc?.close(); if (w.db?.isOpen) w.db.close(); }
      return { name, steps: w.steps };
    });
    return { scenarios: { scenarios }, schema: buildSchema(path.join(dir, "schema", "identity.sqlite")) };
  } finally { rnd.restore(); rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "identity-store", build: buildIdentityStoreVectors });
}
