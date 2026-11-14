// Parity sequences (ruling R9 of P4-12) for the admin store and the desktop attach store (task 5): every method of `AdminStore`
// (`admin.sqlite`: role presets, agent rights, invitations and their one-time redeem, break-glass notices) and of
// `DesktopAttach` (`desktop-attach.db`: one-use codes and hashed bearer credentials), driven against temporary files.
// `crates/plur1bus-core/src/identity/admin_vectors.rs` replays every step. Recorded, never edited by hand.
//
// A step is one JSON text: `{ op, args, out: { ok } | { err }, hooks?, audit?, draws?, tables? }`, as in
// `export-identity-store.ts` (same `tables` rule, same scripted random source). Differences:
//   - `AdminStore` takes its time as an argument, so a step has no `at`; `DesktopAttach` steps carry `at`.
//   - `hooks` lists the calls of `beforeCommit` during the step (its argument, `null` when it has none). `args.hook: "fail"`
//     makes the hook throw; the step's error is then `{ hook: true }` and nothing of the step may be stored.
//   - `err` is `{ rpc, message, reason? }` for an `RpcError`, `{ device }` for a `DeviceError`, `{ sqlite }` for an error of
//     SQLite the store lets through, `{ hook: true }` or `{ audit: true }` for a failing hook or audit sink.
//   - the device store behind `DesktopAttach` is a stub (the Rust port has a trait there): `recordPairing` numbers its devices
//     `dev-1`, `dev-2`, ... and refuses the public key `"refuse"` with `DeviceError("conflict")`; the ops `device` (set fields of
//     a stored device), `person` (set or remove a person's version) and `sink` (make the audit sink throw) change the stub.
//   - op `raw` runs SQL on the closed file through a plain connection (a file an older harness left behind).
// `schema.json`: `sqlite_master`, the pragmas and the column order of both stores, fresh and after opening an older file.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-identity-admin.ts [--check]
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { AdminStore } from "../../packages/core/src/identity/admin-store.ts";
import { DesktopAttach } from "../../packages/core/src/identity/desktop-attach.ts";
import { RpcError } from "../../packages/core/src/rpc/errors.ts";
import { DeviceError, type Device, type DeviceStore } from "../../packages/remote-access/src/device-store.ts";
import { exporterMain } from "./lib.mjs";
import { scriptRandom, type Random } from "./export-identity-store.ts";

type Json = any;
class HookFailed extends Error {}
class SinkFailed extends Error {}
const clone = (v: unknown): Json => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
function errorOf(e: unknown): Json {
  if (e instanceof RpcError) return { rpc: e.error, message: e.message, ...(e.reason !== undefined ? { reason: e.reason } : {}) };
  if (e instanceof DeviceError) return { device: e.code };
  if (e instanceof HookFailed) return { hook: true };
  if (e instanceof SinkFailed) return { audit: true };
  const errcode = (e as { errcode?: unknown })?.errcode;
  if (typeof errcode === "number") return { sqlite: errcode };
  throw e;
}
const ADMIN_TABLES = ["admin_roles", "admin_rights", "admin_notices", "admin_invites", "attempts"];
const ATTACH_TABLES = ["codes", "credentials"];
const masterOf = (db: DatabaseSync) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
const pragmasOf = (db: DatabaseSync) => Object.fromEntries(["journal_mode", "foreign_keys", "busy_timeout", "user_version", "synchronous"].map((n) => [n, Object.values(db.prepare(`PRAGMA ${n}`).get() as Record<string, unknown>)[0]]));
const columnsOf = (db: DatabaseSync, tables: string[]) => Object.fromEntries(tables.map((t) => [t, (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name)]));

abstract class World {
  readonly steps: string[] = [];
  protected last: Record<string, string> = {};
  protected hooks: Json[] = []; protected events: Json[] = [];
  protected readonly file: string; protected readonly rnd: Random; protected readonly tables: string[];
  constructor(file: string, rnd: Random, tables: string[]) { this.file = file; this.rnd = rnd; this.tables = tables; }
  protected abstract db(): DatabaseSync | null;
  protected abstract call(op: string, a: Json): unknown;
  protected extra(): Json { return {}; }
  private dump(): Record<string, Json[][]> {
    const out: Record<string, Json[][]> = {}; const db = this.db();
    if (!db?.isOpen) return out;
    for (const t of this.tables) {
      const rows = (db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all() as Record<string, unknown>[]).map((r) => Object.values(r));
      const text = JSON.stringify(rows);
      if (text !== (this.last[t] ?? "[]")) { out[t] = rows; this.last[t] = text; }
    }
    return out;
  }
  protected raw(text: string): void {
    const db = new DatabaseSync(this.file);
    try { db.exec(text); } finally { db.close(); }
    this.last = Object.fromEntries(this.tables.map((t) => [t, "?"])); // the next dump names every table
  }
  private step(op: string, args: Json): { ok?: Json; err?: Json } {
    this.hooks = []; this.events = []; this.rnd.take();
    let out: { ok?: Json; err?: Json };
    try { out = { ok: clone(this.call(op, args)) }; } catch (e) { out = { err: errorOf(e) }; }
    const tables = this.dump(); const draws = this.rnd.take();
    this.steps.push(JSON.stringify({ op, args: clone(args), ...this.extra(), out, ...(this.hooks.length ? { hooks: clone(this.hooks) } : {}), ...(this.events.length ? { audit: clone(this.events) } : {}), ...(draws.length ? { draws } : {}), ...(Object.keys(tables).length ? { tables } : {}) }));
    return out;
  }
  ok(op: string, args: Json = {}): Json {
    const out = this.step(op, args);
    if (out.err) throw new Error(`${op} ${JSON.stringify(args)}: expected a result, got ${JSON.stringify(out.err)}`);
    return out.ok;
  }
  err(op: string, args: Json, want: string): Json {
    const out = this.step(op, args);
    const e = out.err; const got = !e ? "ok" : e.rpc ? `${e.rpc}${e.reason ? `/${e.reason}` : ""}` : e.device ? `device:${e.device}` : e.sqlite ? "sqlite" : e.hook ? "hook" : "audit";
    if (got !== want) throw new Error(`${op} ${JSON.stringify(args)}: expected ${want}, got ${got} ${JSON.stringify(out)}`);
    return e;
  }
  abstract close(): void;
}

class AdminWorld extends World {
  store: AdminStore | null = null;
  protected db() { return this.store?.db ?? null; }
  close() { if (this.store?.db.isOpen) this.store.close(); }
  private hook(a: Json) { return (invite?: unknown) => { this.hooks.push(invite ?? null); if (a.hook === "fail") throw new HookFailed(); }; }
  protected call(op: string, a: Json): unknown {
    if (op === "open") { this.store = new AdminStore({ path: this.file, ownerId: a.ownerId }); this.last = Object.fromEntries(this.tables.map((t) => [t, "?"])); return undefined; }
    if (op === "raw") { this.raw(a.text); return undefined; }
    const s = this.store!;
    switch (op) {
      case "close": s.close(); return undefined;
      case "sql": s.db.exec(a.text); return undefined;
      case "role": return a.fallback === undefined ? s.role(a.id) : s.role(a.id, a.fallback);
      case "users": return s.users();
      case "person": return s.person(a.id);
      case "resolvePerson": return s.resolvePerson(a.id);
      case "setDisabled": return s.setDisabled(a.id, a.disabled, a.by, a.now, this.hook(a));
      case "validateInvite": return s.validateInvite(a.hash, a.now) ?? null;
      case "setRole": return s.setRole(a.id, a.role, this.hook(a));
      case "rights": return s.rights(a.agentId);
      case "setRight": return s.setRight(a.agentId, a.userId, a.right);
      case "resolve": return s.resolve(a.principal);
      case "invite": return s.invite(a.invite);
      case "notice": return s.notice(a.notice);
      case "notices": return s.notices(a.userId);
      case "allNotices": return s.allNotices();
      case "invites": return s.invites();
      case "revoke": return s.revoke(a.id);
      case "redeem": return s.redeem(a.tokenHash, { now: a.now, source: a.source, beforeCommit: this.hook(a) });
      default: throw new Error(`unknown op ${op}`);
    }
  }
}

class AttachWorld extends World {
  t = 1_760_000_000_000; attach: DesktopAttach | null = null; private handle: DatabaseSync | null = null;
  private devices: Device[] = []; private versions = new Map<string, number | null>(); private sinkDown = false; private versioned = true;
  protected db() { return this.handle; }
  protected extra() { return { at: this.t }; }
  close() { if (this.handle?.isOpen) this.handle.close(); this.handle = null; try { this.attach?.close(); } catch { /* closed */ } }
  private store(): DeviceStore {
    const recordPairing = (input: Json): Device => {
      if (input.publicKey === "refuse") throw new DeviceError("conflict");
      const d: Device = { ...structuredClone(input), fingerprint: `fp-${this.devices.length + 1}`, id: `dev-${this.devices.length + 1}`, pairedAt: this.t, lastSeenAt: this.t, revoked: false };
      this.devices.push(d); return structuredClone(d);
    };
    const get = (id: string): Device => { const d = this.devices.find((x) => x.id === id); if (!d) throw new DeviceError("not-found"); return structuredClone(d); };
    return { recordPairing, get } as unknown as DeviceStore;
  }
  protected call(op: string, a: Json): unknown {
    if (op === "open") {
      this.versioned = a.personVersion !== false;
      this.attach = new DesktopAttach({
        file: this.file, devices: this.store(), now: () => this.t, securePath: () => {},
        audit: { append: (e) => { if (this.sinkDown) throw new SinkFailed(); this.events.push(e); } },
        ...(this.versioned ? { personVersion: (id: string) => (this.versions.has(id) ? this.versions.get(id)! : 1) } : {}),
      });
      this.handle = new DatabaseSync(this.file); // a second connection for the dumps: the store keeps its own private
      this.last = Object.fromEntries(this.tables.map((t) => [t, "?"]));
      return undefined;
    }
    if (op === "raw") { this.raw(a.text); return undefined; }
    if (op === "sql") { this.handle!.exec(a.text); return undefined; }
    if (op === "device") { Object.assign(this.devices.find((d) => d.id === a.id)!, a.set); return undefined; }
    if (op === "person") { this.versions.set(a.id, a.version); return undefined; }
    if (op === "sink") { this.sinkDown = a.down; return undefined; }
    const s = this.attach!;
    switch (op) {
      case "close": this.close(); this.attach = null; return undefined;
      case "issue": return a.extensions === undefined ? s.issue(a.userId, a.kind) : a.imports === undefined ? s.issue(a.userId, a.kind, a.extensions) : s.issue(a.userId, a.kind, a.extensions, a.imports);
      case "redeem": return s.redeem(a.code, a.kind, a.name, a.publicKey);
      case "authenticate": return s.authenticate(a.token);
      case "resolve": return s.resolve(a.deviceId);
      default: throw new Error(`unknown op ${op}`);
    }
  }
}

const NOW = 1_760_000_000_000;
const MIN = 60_000;
const hex = (c: string) => c.repeat(64);

const ADMIN: Record<string, (w: AdminWorld) => void> = {
  "seed-roles-last-owner"(w) {
    w.ok("open", { ownerId: "owner-1" });
    w.ok("users");
    w.ok("role", { id: "owner-1" }); w.ok("role", { id: "nobody" }); w.ok("role", { id: "nobody", fallback: "viewer" }); w.ok("role", { id: "owner-1", fallback: "viewer" });
    w.ok("person", { id: "owner-1" }); w.ok("person", { id: "nobody" });
    w.ok("resolvePerson", { id: "owner-1" }); w.ok("resolvePerson", { id: "nobody" });
    w.ok("setRole", { id: "u-admin", role: "admin" });
    w.ok("setRole", { id: "u-admin", role: "admin" }); // the same role again: the version moves
    for (const role of ["operator", "member", "viewer"]) w.ok("setRole", { id: `u-${role}`, role });
    w.err("setRole", { id: "u-x", role: "root" }, "E_INVALID_PARAMS"); // refused before the hook
    w.err("setRole", { id: "u-x", role: "Owner" }, "E_INVALID_PARAMS");
    w.err("setRole", { id: "owner-1", role: "admin" }, "E_CONFLICT/last-owner"); // refused before the hook
    w.ok("setRole", { id: "owner-1", role: "owner" }); // owner to owner is not a demotion
    w.err("setRole", { id: "u-member", role: "admin", hook: "fail" }, "hook"); // a failing audit write stores nothing
    w.ok("setRole", { id: "owner-2", role: "owner" });
    w.ok("setRole", { id: "owner-1", role: "member" }); // two owners: one may go
    w.err("setRole", { id: "owner-2", role: "viewer" }, "E_CONFLICT/last-owner");
    w.ok("users");
    w.ok("close");
    w.ok("open", { ownerId: "someone-else" }); // seeded only when empty: a demoted bootstrap owner stays demoted
    w.ok("users");
    w.ok("sql", { text: "DELETE FROM admin_roles" });
    w.ok("close");
    w.ok("open", { ownerId: "fresh-owner" });
    w.ok("users");
    w.ok("close");
  },

  "disable-enable"(w) {
    w.ok("open", { ownerId: "owner-1" });
    w.ok("setRole", { id: "m", role: "member" });
    w.err("setDisabled", { id: "nobody", disabled: true, by: "owner-1", now: NOW }, "E_NOT_FOUND");
    w.ok("setDisabled", { id: "m", disabled: true, by: "owner-1", now: NOW });
    w.ok("person", { id: "m" }); w.ok("resolvePerson", { id: "m" }); w.ok("role", { id: "m" }); w.ok("users");
    w.ok("setDisabled", { id: "m", disabled: true, by: "someone", now: NOW + 5 }); // already disabled: no hook, nothing changes
    w.ok("setDisabled", { id: "m", disabled: false, by: "owner-1", now: NOW + 9 });
    w.ok("setDisabled", { id: "m", disabled: false, by: "owner-1", now: NOW + 9 });
    w.err("setDisabled", { id: "m", disabled: true, by: "owner-1", now: NOW + 10, hook: "fail" }, "hook");
    w.ok("person", { id: "m" });
    w.err("setDisabled", { id: "owner-1", disabled: true, by: "owner-1", now: NOW }, "E_CONFLICT/last-owner");
    w.ok("setDisabled", { id: "owner-1", disabled: false, by: "owner-1", now: NOW }); // enabling the enabled last owner: nothing
    w.ok("setRole", { id: "owner-2", role: "owner" });
    w.ok("setDisabled", { id: "owner-1", disabled: true, by: "owner-2", now: NOW + 20 });
    w.err("setDisabled", { id: "owner-2", disabled: true, by: "owner-2", now: NOW + 21 }, "E_CONFLICT/last-owner"); // the last active one
    w.err("setRole", { id: "owner-2", role: "admin" }, "E_CONFLICT/last-owner");
    w.ok("setRole", { id: "owner-1", role: "member" }); // a disabled owner is no active owner: may be demoted
    w.ok("setRole", { id: "owner-1", role: "owner" }); // and promoted again, still disabled
    w.err("setRole", { id: "owner-2", role: "admin" }, "E_CONFLICT/last-owner");
    w.ok("setDisabled", { id: "owner-1", disabled: false, by: "owner-2", now: NOW + 30 });
    w.ok("setDisabled", { id: "owner-2", disabled: true, by: "owner-1", now: NOW + 31 });
    w.ok("users");
    w.ok("close");
  },

  "agent-rights"(w) {
    w.ok("open", { ownerId: "owner-1" });
    w.ok("setRole", { id: "u1", role: "member" });
    w.ok("rights", { agentId: "a1" });
    w.ok("setRight", { agentId: "a1", userId: "u1", right: "use" });
    w.ok("setRight", { agentId: "a1", userId: "u1", right: "manage" });
    w.ok("setRight", { agentId: "a2", userId: "u1", right: "use" });
    w.ok("setRight", { agentId: "a1", userId: "u0", right: "use" }); // a user without a role row: the right is stored, no version moves
    w.ok("setRight", { agentId: "a1", userId: "owner-1", right: "manage" });
    w.err("setRight", { agentId: "a1", userId: "u1", right: "admin" }, "E_INVALID_PARAMS"); // no version moves either
    w.err("setRight", { agentId: "a1", userId: "u1", right: "" }, "E_INVALID_PARAMS");
    w.ok("rights", { agentId: "a1" }); w.ok("rights", { agentId: "a2" });
    w.ok("resolve", { principal: { kind: "person", userId: "u1", role: "viewer" } }); // the stored role wins
    w.ok("resolve", { principal: { kind: "person", userId: "u0", role: "viewer" } }); // no stored role: the given one stays
    w.ok("resolve", { principal: { kind: "person", userId: "u1", role: "owner", tokenScopes: ["chat:read"], agentRights: { stale: "manage" } } });
    w.ok("resolve", { principal: { kind: "agent", userId: "u1", role: "owner" } }); // an agent is returned as it came
    w.ok("resolve", { principal: { kind: "person", userId: "none", role: "member" } });
    w.ok("person", { id: "u1" }); w.ok("resolvePerson", { id: "u1" });
    w.ok("setRight", { agentId: "a1", userId: "u1", right: null });
    w.ok("setRight", { agentId: "a1", userId: "u1", right: null }); // removing nothing still moves the version
    w.ok("setRight", { agentId: "nope", userId: "nobody", right: null });
    w.ok("rights", { agentId: "a1" });
    w.ok("person", { id: "u1" });
    w.ok("close");
  },

  "invitations"(w) {
    w.ok("open", { ownerId: "owner-1" });
    const inv = (id: string, extra: Json = {}) => ({ id, userId: `user-${id}`, role: "member", channel: "telegram", expiresAt: NOW + 60 * MIN, createdAt: NOW, createdBy: "owner-1", ...extra });
    w.ok("invite", { invite: inv("i1", { tokenHash: hex("a") }) });
    w.ok("invite", { invite: inv("i2") }); // a plain pairing-code invitation: no token
    w.ok("invite", { invite: inv("i0", { tokenHash: hex("b"), expiresAt: NOW + 60 * MIN, role: "admin", channel: "web" }) });
    w.ok("invite", { invite: inv("i3", { tokenHash: hex("c"), expiresAt: NOW + 10 * MIN }) });
    w.err("invite", { invite: inv("i1", { tokenHash: hex("d") }) }, "sqlite"); // the id again
    w.err("invite", { invite: inv("i4", { tokenHash: hex("a") }) }, "sqlite"); // the token again
    w.ok("invites");
    w.ok("validateInvite", { hash: null, now: NOW });
    w.ok("validateInvite", { hash: "", now: NOW });
    w.ok("validateInvite", { hash: hex("a"), now: NOW });
    w.ok("validateInvite", { hash: hex("A"), now: NOW });
    w.ok("validateInvite", { hash: hex("e"), now: NOW });
    w.ok("validateInvite", { hash: hex("c"), now: NOW + 10 * MIN - 1 });
    w.ok("validateInvite", { hash: hex("c"), now: NOW + 10 * MIN }); // gone at its deadline
    w.ok("revoke", { id: "i1" });
    w.ok("revoke", { id: "no-such-invite" });
    w.ok("validateInvite", { hash: hex("a"), now: NOW });
    w.ok("invites");
    w.ok("close");
  },

  "redeem"(w) {
    w.ok("open", { ownerId: "owner-1" });
    const inv = (id: string, c: string, extra: Json = {}) => w.ok("invite", { invite: { id, userId: `user-${id}`, role: "member", channel: "telegram", expiresAt: NOW + 60 * MIN, createdAt: NOW, createdBy: "owner-1", tokenHash: hex(c), ...extra } });
    inv("good", "a"); inv("revoked", "b"); inv("short", "c", { expiresAt: NOW + MIN }); inv("both", "d"); inv("kept", "e"); inv("late", "f"); inv("plain", "0", { tokenHash: undefined });
    w.ok("revoke", { id: "revoked" });
    const r = (tokenHash: string | null, source: string, now = NOW, extra: Json = {}) => ({ tokenHash, source, now, ...extra });
    w.ok("redeem", r(null, "s1")); // malformed: counted like any failure
    w.ok("redeem", r(hex("9"), "s1")); // unknown
    w.ok("redeem", r(hex("b"), "s1")); // revoked
    w.ok("redeem", r(hex("c"), "s1", NOW + MIN)); // expired at its deadline
    w.err("redeem", r(hex("a"), "s1", NOW + MIN, { hook: "fail" }), "hook"); // the audit write fails: not consumed, not counted
    w.ok("redeem", r(hex("a"), "s1", NOW + MIN + 1)); // taken: this source's failures are forgotten
    w.ok("redeem", r(hex("a"), "s2", NOW + MIN + 2)); // redeemed
    w.ok("redeem", r(hex("d"), "s2", NOW + MIN + 3));
    w.ok("revoke", { id: "both" });
    w.ok("redeem", r(hex("d"), "s2", NOW + MIN + 4)); // revoked and redeemed: reported as revoked
    w.ok("invites");
    w.ok("validateInvite", { hash: hex("a"), now: NOW });
    // Five failures of one source lock it; a valid token is refused while the lock runs and is not consumed.
    for (let i = 0; i < 5; i++) w.ok("redeem", r(hex("9"), "s3", NOW + 2 * MIN + i));
    w.ok("redeem", r(hex("e"), "s3", NOW + 2 * MIN + 5));
    w.ok("redeem", r(hex("e"), "s3", NOW + 2 * MIN + 4 + 15 * MIN - 1));
    w.ok("redeem", r(hex("9"), "s4", NOW + 2 * MIN + 6)); // another source is free
    w.ok("redeem", r(hex("e"), "s3", NOW + 2 * MIN + 4 + 15 * MIN)); // the lock is over
    // Every source together: 100 failures lock all redeems for five minutes. The counter is set to 99 here.
    const t = NOW + 30 * MIN;
    w.ok("sql", { text: `UPDATE attempts SET failures = 99, window_start = ${t}, locked_until = 0 WHERE key = 'invite-redeem:global'` });
    w.ok("redeem", r(hex("9"), "s5", t)); // the hundredth
    w.ok("redeem", r(hex("f"), "s6", t + 1)); // valid, refused
    w.ok("redeem", r(hex("f"), "s6", t + 5 * MIN - 1));
    w.ok("redeem", r(hex("f"), "s6", t + 5 * MIN));
    w.ok("invites");
    w.ok("close");
  },

  "break-glass-notices"(w) {
    w.ok("open", { ownerId: "owner-1" });
    const n = (grantId: string, userId: string) => ({ kind: "granted", userId, grantId, holderUserId: "owner-1", reason: `reason ${grantId}`, expiresAt: NOW + 30 * MIN });
    w.ok("notices", { userId: "u1" }); w.ok("allNotices");
    w.ok("notice", { notice: n("g1", "u1") }); w.ok("notice", { notice: n("g3", "u2") }); w.ok("notice", { notice: n("g2", "u1") });
    w.err("notice", { notice: n("g1", "u2") }, "sqlite"); // one notice per grant
    w.ok("notices", { userId: "u1" }); w.ok("notices", { userId: "u2" }); w.ok("notices", { userId: "nobody" });
    w.ok("allNotices");
    // At most the 200 newest of one user.
    w.ok("sql", { text: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 205) INSERT INTO admin_notices SELECT 'bulk-' || i, 'many', json_object('grantId', 'bulk-' || i, 'i', i) FROM n" });
    const got = w.ok("notices", { userId: "many" });
    if (got.length !== 200 || got[0].i !== 205 || got[199].i !== 6) throw new Error("the 200 newest were expected");
    w.ok("close");
  },

  "older-file"(w) {
    // A file from before the status columns of `admin_roles`: they are added on open; existing rows get the defaults.
    w.ok("raw", { text: "CREATE TABLE admin_roles (user_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','member','viewer'))) STRICT; INSERT INTO admin_roles VALUES ('old-owner','owner'), ('old-member','member');" });
    w.ok("open", { ownerId: "owner-1" });
    w.ok("users");
    w.ok("setDisabled", { id: "old-member", disabled: true, by: "old-owner", now: NOW });
    w.ok("close");
    w.ok("open", { ownerId: "owner-1" }); // a second open adds nothing
    w.ok("users");
    w.ok("close");
  },
};

const ATTACH: Record<string, (w: AttachWorld) => void> = {
  "issue-redeem-authenticate"(w) {
    w.ok("open");
    w.err("issue", { userId: "alice", kind: "phone" }, "device:invalid");
    w.err("issue", { userId: "", kind: "desktop" }, "device:invalid");
    const g = w.ok("issue", { userId: "alice", kind: "desktop" });
    if (g.code.length !== 43 || g.expiresAt !== w.t + 600_000) throw new Error("code shape");
    const ext = w.ok("issue", { userId: "alice", kind: "desktop", extensions: true });
    const all = w.ok("issue", { userId: "bob", kind: "desktop", extensions: true, imports: true });
    const imp = w.ok("issue", { userId: "bob", kind: "desktop", extensions: false, imports: true });
    w.err("redeem", { code: g.code, kind: "phone", name: "PC", publicKey: "k1" }, "device:denied");
    w.err("redeem", { code: g.code.slice(1), kind: "desktop", name: "PC", publicKey: "k1" }, "device:denied");
    w.err("redeem", { code: `${g.code}A`, kind: "desktop", name: "PC", publicKey: "k1" }, "device:denied");
    w.err("redeem", { code: "A".repeat(43), kind: "desktop", name: "PC", publicKey: "k1" }, "device:denied");
    w.t += 1_000;
    const p = w.ok("redeem", { code: g.code, kind: "desktop", name: "PC", publicKey: "k1" });
    if (p.token.length !== 43 || p.expiresAt !== w.t + 30 * 86_400_000) throw new Error("token shape");
    w.err("redeem", { code: g.code, kind: "desktop", name: "Other", publicKey: "k2" }, "device:denied"); // one use
    w.ok("authenticate", { token: p.token });
    w.ok("resolve", { deviceId: p.device.id });
    w.err("authenticate", { token: p.token.slice(1) }, "device:denied");
    w.err("authenticate", { token: "B".repeat(43) }, "device:denied");
    w.err("authenticate", { token: g.code }, "device:denied"); // a code is not a credential
    w.err("resolve", { deviceId: "dev-99" }, "device:not-found"); // the device store answers before the credential is looked at
    const pe = w.ok("redeem", { code: ext.code, kind: "desktop", name: "Ext", publicKey: "k3" });
    const pa = w.ok("redeem", { code: all.code, kind: "desktop", name: "All", publicKey: "k4" });
    const pi = w.ok("redeem", { code: imp.code, kind: "desktop", name: "Imp", publicKey: "k5" });
    for (const x of [pe, pa, pi]) w.ok("authenticate", { token: x.token });
    // The device store is the authority: its scope narrows, its revocation and platform end the session.
    w.ok("device", { id: pa.device.id, set: { scope: ["chat:read", "extensions.manage", "not-a-desktop-scope"] } });
    w.ok("authenticate", { token: pa.token });
    w.ok("device", { id: pe.device.id, set: { platform: "phone" } });
    w.err("authenticate", { token: pe.token }, "device:denied");
    w.ok("device", { id: p.device.id, set: { revoked: true } });
    w.err("authenticate", { token: p.token }, "device:denied");
    w.err("resolve", { deviceId: p.device.id }, "device:denied");
    // The credential lasts 30 days, to the millisecond.
    w.t = pi.expiresAt - 1;
    w.ok("authenticate", { token: pi.token });
    w.t = pi.expiresAt;
    w.err("authenticate", { token: pi.token }, "device:denied");
    w.err("resolve", { deviceId: pi.device.id }, "device:denied");
    w.ok("close");
  },

  "codes-expire-and-are-capped"(w) {
    w.ok("open");
    const a = w.ok("issue", { userId: "alice", kind: "desktop" });
    const b = w.ok("issue", { userId: "alice", kind: "desktop" });
    w.t = a.expiresAt - 1;
    w.ok("redeem", { code: a.code, kind: "desktop", name: "PC", publicKey: "k1" });
    w.t = b.expiresAt;
    w.err("redeem", { code: b.code, kind: "desktop", name: "PC", publicKey: "k2" }, "device:denied"); // gone at its deadline; the row stays
    const c = w.ok("issue", { userId: "alice", kind: "desktop" }); // issuing drops the expired rows
    w.err("redeem", { code: c.code, kind: "desktop", name: "PC", publicKey: "refuse" }, "device:conflict"); // the device store refuses: the code is spent
    w.err("redeem", { code: c.code, kind: "desktop", name: "PC", publicKey: "k3" }, "device:denied");
    // At most 256 unexpired codes.
    w.ok("sql", { text: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 255) INSERT INTO codes(hash,user_id,kind,person_version,expires_at) SELECT 'fill-' || i, 'x', 'desktop', 1, ${w.t + 1} FROM n` });
    w.ok("issue", { userId: "alice", kind: "desktop" }); // the 256th
    w.err("issue", { userId: "alice", kind: "desktop" }, "device:denied");
    w.t += 1; // the filler expires
    w.ok("issue", { userId: "alice", kind: "desktop" });
    w.ok("close");
  },

  "person-version-and-audit-sink"(w) {
    w.ok("open");
    w.ok("person", { id: "gone", version: null });
    w.err("issue", { userId: "gone", kind: "desktop" }, "device:denied"); // an unknown or disabled person
    w.ok("person", { id: "alice", version: 3 });
    const a = w.ok("issue", { userId: "alice", kind: "desktop" });
    const b = w.ok("issue", { userId: "alice", kind: "desktop" });
    const c = w.ok("issue", { userId: "alice", kind: "desktop" });
    const d = w.ok("issue", { userId: "alice", kind: "desktop" });
    const p = w.ok("redeem", { code: a.code, kind: "desktop", name: "PC", publicKey: "k1" });
    w.ok("authenticate", { token: p.token });
    w.ok("person", { id: "alice", version: 4 }); // the person changed (role, rights, status): codes and credentials of before are void
    w.err("redeem", { code: b.code, kind: "desktop", name: "PC2", publicKey: "k2" }, "device:denied"); // and the code is spent
    w.err("authenticate", { token: p.token }, "device:denied");
    w.err("resolve", { deviceId: p.device.id }, "device:denied");
    w.ok("person", { id: "alice", version: 3 });
    w.ok("authenticate", { token: p.token });
    w.err("redeem", { code: b.code, kind: "desktop", name: "PC2", publicKey: "k2" }, "device:denied");
    w.ok("person", { id: "alice", version: null });
    w.err("authenticate", { token: p.token }, "device:denied");
    w.err("redeem", { code: c.code, kind: "desktop", name: "PC3", publicKey: "k3" }, "device:denied");
    w.ok("person", { id: "alice", version: 3 });
    // The audit line comes before the effect: a failing sink leaves no code, and no credential for a recorded device.
    w.ok("sink", { down: true });
    w.err("issue", { userId: "alice", kind: "desktop" }, "audit");
    w.err("redeem", { code: d.code, kind: "desktop", name: "PC4", publicKey: "k4" }, "audit");
    w.ok("sink", { down: false });
    w.err("redeem", { code: d.code, kind: "desktop", name: "PC4", publicKey: "k5" }, "device:denied");
    w.ok("close");
    // Without a person-version port every person is version 0.
    w.ok("open", { personVersion: false });
    const e = w.ok("issue", { userId: "anyone", kind: "desktop" });
    const pe = w.ok("redeem", { code: e.code, kind: "desktop", name: "PC5", publicKey: "k6" });
    w.ok("authenticate", { token: pe.token });
    w.err("authenticate", { token: p.token }, "device:denied"); // issued under version 3
    w.ok("close");
  },

  "older-file"(w) {
    w.ok("raw", { text: "CREATE TABLE codes (hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,person_version INTEGER NOT NULL,expires_at INTEGER NOT NULL) STRICT; INSERT INTO codes VALUES ('old', 'alice', 'desktop', 1, 9999999999999);" });
    w.ok("open");
    const g = w.ok("issue", { userId: "alice", kind: "desktop", extensions: true, imports: true });
    w.ok("redeem", { code: g.code, kind: "desktop", name: "PC", publicKey: "k1" });
    w.ok("close");
    w.ok("open");
    w.ok("close");
  },
};

function schemas(dir: string): Json {
  mkdirSync(path.join(dir, "schema"), { recursive: true });
  const admin = (name: string, before?: string) => {
    const file = path.join(dir, "schema", name);
    if (before) { const raw = new DatabaseSync(file); raw.exec(before); raw.close(); }
    const s = new AdminStore({ path: file, ownerId: "owner-1" });
    try { return { master: masterOf(s.db), pragmas: pragmasOf(s.db), columns: columnsOf(s.db, ADMIN_TABLES) }; } finally { s.close(); }
  };
  const attach = (name: string, before?: string) => {
    const file = path.join(dir, "schema", name);
    if (before) { const raw = new DatabaseSync(file); raw.exec(before); raw.close(); }
    new DesktopAttach({ file, devices: {} as DeviceStore, now: () => 0, audit: { append() {} }, securePath() {} }).close();
    const db = new DatabaseSync(file);
    // The pragmas of a connection are its own: only the journal mode and the version are properties of the file.
    try { return { master: masterOf(db), file: { journal_mode: pragmasOf(db).journal_mode, user_version: pragmasOf(db).user_version }, columns: columnsOf(db, ATTACH_TABLES) }; } finally { db.close(); }
  };
  const plain = new DatabaseSync(":memory:");
  const nodeDefault = { foreign_keys: Object.values(plain.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>)[0] };
  plain.close();
  return {
    // What a node:sqlite connection has when the store never touches the pragma (`DesktopAttach` sets only the busy timeout).
    "node-default": nodeDefault,
    admin: admin("admin.sqlite"),
    "admin-older": admin("admin-older.sqlite", "CREATE TABLE admin_roles (user_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','member','viewer'))) STRICT;"),
    attach: attach("attach.db"),
    "attach-older": attach("attach-older.db", "CREATE TABLE codes (hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,person_version INTEGER NOT NULL,expires_at INTEGER NOT NULL) STRICT;"),
  };
}

/** `{ admin, attach, schema }`: the fixtures of `fixtures/parity/identity-admin/`. */
export function buildIdentityAdminVectors(): Record<string, unknown> {
  const dir = mkdtempSync(path.join(tmpdir(), "p1b-parity-identity-admin-"));
  const rnd = scriptRandom();
  try {
    const run = <W extends World>(kind: string, make: (file: string) => W, scenarios: Record<string, (w: W) => void>) => Object.entries(scenarios).map(([name, script], i) => {
      rnd.reseed(`${kind}:${name}`);
      mkdirSync(path.join(dir, `${kind}${i}`), { recursive: true });
      const w = make(path.join(dir, `${kind}${i}`, kind === "admin" ? "admin.sqlite" : "desktop-attach.db"));
      try { script(w); } finally { w.close(); }
      return { name, steps: w.steps };
    });
    return {
      admin: { scenarios: run("admin", (f) => new AdminWorld(f, rnd, ADMIN_TABLES), ADMIN) },
      attach: { scenarios: run("attach", (f) => new AttachWorld(f, rnd, ATTACH_TABLES), ATTACH) },
      schema: schemas(dir),
    };
  } finally { rnd.restore(); rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "identity-admin", build: buildIdentityAdminVectors });
}
