// Credentials only. Every authority decision joins the current Core person; no role/status cache is persisted.
import { createSecurePath } from "@plur1bus/module-api";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { ApiError } from "./errors.ts";
import { normalizeUsername } from "./memory-stores.ts";
import type { UserDirectory, UserRecord, TokenStore, TokenRecord, TotpStore, TotpRecord } from "./ports.ts";
import type { RbacPrincipal } from "./rbac-bridge.ts";

export type CorePerson = RbacPrincipal & { disabled: boolean; version: number };
export interface AccountStoreOptions { path: string; resolve: (personId: string) => Promise<CorePerson | null>; now?: () => number }
const storage = () => new ApiError(503, "E_STORAGE", "account storage unavailable", { reason: "account-storage" });
const conflict = () => new ApiError(409, "E_CONFLICT", "account already exists", { reason: "account-exists" });
export class AccountStore implements UserDirectory {
  readonly #db: DatabaseSync; readonly #resolve: AccountStoreOptions["resolve"]; readonly #now: () => number;
  #poll: NodeJS.Timeout | undefined;
  readonly tokens: TokenStore; readonly totp: TotpStore;
  onChange?: (personId: string) => void;
  constructor(o: AccountStoreOptions) {
    this.#resolve = o.resolve; this.#now = o.now ?? Date.now;
    try {
      if (o.path !== ":memory:") { mkdirSync(dirname(o.path), { recursive: true, mode: 0o700 }); chmodSync(dirname(o.path), 0o700); closeSync(openSync(o.path, "a", 0o600)); chmodSync(o.path, 0o600); const secure = createSecurePath(); if (!secure(dirname(o.path), { mode: 0o700 }).applied || !secure(o.path, { mode: 0o600 }).applied) throw storage(); }
      this.#db = new DatabaseSync(o.path);
      if (Number(this.#db.prepare("PRAGMA user_version").get()?.user_version) > 1) throw storage();
      this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS accounts (person_id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,pending INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,core_version INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS totp (user_id TEXT PRIMARY KEY,record TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,record TEXT NOT NULL,core_version INTEGER NOT NULL) STRICT;
        PRAGMA user_version=1;`);
    } catch { throw storage(); }
    this.totp = {
      get: async id => this.#safe(() => { const r = this.#db.prepare("SELECT record FROM totp WHERE user_id=?").get(id); return r ? JSON.parse(r.record as string) as TotpRecord : undefined; }),
      put: async r => { const previous = await this.totp.get(r.userId); const write = () => { this.#db.prepare("INSERT INTO totp VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET record=excluded.record").run(r.userId, JSON.stringify(r)); };
        if ((previous?.enabled ?? false) !== r.enabled || (r.enabled && previous?.secret !== r.secret)) this.#factor(r.userId, write); else this.#safe(write); },
      delete: async id => this.#factor(id, () => { this.#db.prepare("DELETE FROM totp WHERE user_id=?").run(id); }),
    };
    this.tokens = {
      put: async r => { const p = await this.#person(r.userId); if (!p || p.disabled) throw storage(); this.#safe(() => this.#db.prepare("INSERT INTO tokens VALUES (?,?,?,?)").run(r.id, r.userId, JSON.stringify(r), p.version)); },
      get: async id => {
        const row = this.#safe(() => this.#db.prepare("SELECT record,core_version FROM tokens WHERE id=?").get(id));
        if (!row) return undefined;
        const r = this.#safe(() => JSON.parse(row.record as string) as TokenRecord);
        const p = await this.#person(r.userId);
        if (r.revokedAt === undefined && (!p || p.disabled || p.version !== row.core_version)) {
          const revoked = { ...r, revokedAt: this.#now() }; await this.tokens.update(id, { revokedAt: revoked.revokedAt }); return revoked;
        }
        return r;
      },
      listByUser: async id => this.#safe(() => this.#db.prepare("SELECT record FROM tokens WHERE user_id=? ORDER BY id").all(id).map(r => JSON.parse(r.record as string) as TokenRecord)),
      update: async (id, patch) => this.#safe(() => { const row = this.#db.prepare("SELECT record FROM tokens WHERE id=?").get(id); if (row) this.#db.prepare("UPDATE tokens SET record=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(row.record as string), ...patch }), id); }),
    };
  }
  #safe<T>(fn: () => T): T { try { return fn(); } catch (e) { if (e instanceof ApiError) throw e; throw storage(); } }
  async #person(id: string): Promise<CorePerson | null> { return this.#resolve(id === "owner" ? "local-owner" : id); }
  #factor(id: string, write: () => void): void { this.#safe(() => { this.#db.exec("BEGIN IMMEDIATE"); try { write(); this.#bump(id); this.#db.exec("COMMIT"); } catch (e) { this.#db.exec("ROLLBACK"); throw e; } }); this.onChange?.(id); }
  #bump(id: string): void { this.#db.prepare("UPDATE accounts SET version=version+1,updated_at=? WHERE person_id=?").run(this.#now(), id); }
  async createPending(personId: string, username: string, passwordHash: string): Promise<void> {
    this.#safe(() => { try { this.#db.prepare("INSERT INTO accounts(person_id,username,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)").run(personId, normalizeUsername(username), passwordHash, this.#now(), this.#now()); }
      catch (e) { if ((e as { errcode?: number }).errcode === 2067 || (e as { errcode?: number }).errcode === 1555) throw conflict(); throw e; } });
  }
  async activate(id: string): Promise<void> { this.#safe(() => this.#db.prepare("UPDATE accounts SET pending=0,updated_at=? WHERE person_id=?").run(this.#now(), id)); }
  async removePending(id: string): Promise<void> { this.#safe(() => this.#db.prepare("DELETE FROM accounts WHERE person_id=? AND pending=1").run(id)); }
  async credentialsByUsername(username: string): Promise<UserRecord | undefined> {
    const row = this.#safe(() => this.#db.prepare("SELECT * FROM accounts WHERE username=? AND pending=0").get(normalizeUsername(username)));
    return row ? { id: row.person_id as string, username: row.username as string, passwordHash: row.password_hash as string, version: Number(row.version), role: "member" } : undefined;
  }
  async findByUsername(username: string): Promise<UserRecord | undefined> { const row = this.#safe(() => this.#db.prepare("SELECT person_id FROM accounts WHERE username=? AND pending=0").get(normalizeUsername(username))); return row ? this.findById(row.person_id as string) : undefined; }
  async findById(id: string): Promise<UserRecord | undefined> {
    const row = this.#safe(() => this.#db.prepare("SELECT * FROM accounts WHERE person_id=? AND pending=0").get(id));
    if (!row) return undefined;
    const p = await this.#person(id);
    // Missing/disabled accounts retain their hash so login still performs the same Argon2 comparison before refusal.
    const changed = row.core_version !== null && row.core_version !== p?.version;
    if (changed || p?.disabled || !p) {
      if (changed) this.#safe(() => this.#bump(id));
      for (const r of await this.tokens.listByUser(id)) if (r.revokedAt === undefined) await this.tokens.update(r.id, { revokedAt: this.#now() });
      this.onChange?.(id);
    }
    if (p) this.#safe(() => this.#db.prepare("UPDATE accounts SET core_version=? WHERE person_id=?").run(p.version, id));
    return { id, username: row.username as string, passwordHash: row.password_hash as string, role: p?.role ?? "member", disabled: !p || p.disabled, agentRights: p?.agentRights ?? {}, projectRights: p?.projectRights ?? {}, version: Number(row.version) + (changed ? 1 : 0) };
  }
  async updatePasswordHash(id: string, hash: string): Promise<void> { this.#factor(id, () => { this.#db.prepare("UPDATE accounts SET password_hash=? WHERE person_id=?").run(hash, id); }); }
  startPolling(): void {
    if (this.#poll) return;
    let running = false;
    this.#poll = setInterval(() => { if (running) return; running = true;
      void (async () => { const rows = this.#safe(() => this.#db.prepare("SELECT person_id FROM accounts WHERE pending=0").all()); for (const r of rows) await this.findById(r.person_id as string); })().catch(() => {}).finally(() => { running = false; });
    }, 5000); this.#poll.unref();
  }
  close(): void { clearInterval(this.#poll); this.#db.close(); }
}
