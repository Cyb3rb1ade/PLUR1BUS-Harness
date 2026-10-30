import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { OAuthGrantRecord, OAuthRefreshTokenRecord, OAuthStore } from "./types.ts";

export class MemoryOAuthStore implements OAuthStore {
  readonly #grants = new Map<string, OAuthGrantRecord>();
  readonly #refreshTokens = new Map<string, OAuthRefreshTokenRecord>();

  async saveGrant(grant: OAuthGrantRecord): Promise<void> {
    this.#grants.set(grant.id, structuredClone(grant));
  }

  async getGrant(grantId: string): Promise<OAuthGrantRecord | undefined> {
    const g = this.#grants.get(grantId);
    return g ? structuredClone(g) : undefined;
  }

  async getGrantByFamily(familyId: string): Promise<OAuthGrantRecord | undefined> {
    for (const g of this.#grants.values()) {
      if (g.familyId === familyId) {
        return structuredClone(g);
      }
    }
    return undefined;
  }

  async listGrantsByUser(userId?: string): Promise<readonly OAuthGrantRecord[]> {
    const list: OAuthGrantRecord[] = [];
    for (const g of this.#grants.values()) {
      if (!userId || g.userId === userId) {
        list.push(structuredClone(g));
      }
    }
    return Object.freeze(list);
  }

  async updateGrant(grantId: string, patch: Partial<OAuthGrantRecord>): Promise<void> {
    const existing = this.#grants.get(grantId);
    if (!existing) return;
    this.#grants.set(grantId, { ...existing, ...patch });
  }

  async deleteGrant(grantId: string): Promise<void> {
    this.#grants.delete(grantId);
  }

  async saveRefreshToken(token: OAuthRefreshTokenRecord): Promise<void> {
    this.#refreshTokens.set(token.tokenHash, structuredClone(token));
  }

  async getRefreshToken(tokenHash: string): Promise<OAuthRefreshTokenRecord | undefined> {
    const t = this.#refreshTokens.get(tokenHash);
    return t ? structuredClone(t) : undefined;
  }

  async markRefreshTokenUsed(tokenHash: string): Promise<void> {
    const t = this.#refreshTokens.get(tokenHash);
    if (t) {
      t.used = true;
    }
  }

  async revokeFamily(familyId: string): Promise<void> {
    const now = Date.now();
    for (const [hash, rt] of this.#refreshTokens.entries()) {
      if (rt.familyId === familyId) {
        this.#refreshTokens.delete(hash);
      }
    }
    for (const g of this.#grants.values()) {
      if (g.familyId === familyId) {
        g.revokedAt = now;
      }
    }
  }

  dump(): { grants: OAuthGrantRecord[]; refreshTokens: OAuthRefreshTokenRecord[] } {
    return {
      grants: Array.from(this.#grants.values()),
      refreshTokens: Array.from(this.#refreshTokens.values()),
    };
  }

  load(data: { grants?: OAuthGrantRecord[]; refreshTokens?: OAuthRefreshTokenRecord[] }): void {
    this.#grants.clear();
    this.#refreshTokens.clear();
    for (const g of data.grants ?? []) {
      this.#grants.set(g.id, g);
    }
    for (const rt of data.refreshTokens ?? []) {
      this.#refreshTokens.set(rt.tokenHash, rt);
    }
  }
}

export class SqliteOAuthStore implements OAuthStore {
  readonly #db: DatabaseSync;
  readonly #safe: <T>(fn: () => T) => T;

  constructor(db: DatabaseSync, safe?: <T>(fn: () => T) => T) {
    this.#db = db;
    this.#safe = safe ?? ((fn) => fn());
    this.#init();
  }

  #init(): void {
    this.#safe(() => {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS oauth_grants (
          id TEXT PRIMARY KEY,
          family_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          client_id TEXT NOT NULL,
          record TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants(user_id);
        CREATE INDEX IF NOT EXISTS idx_oauth_grants_family ON oauth_grants(family_id);

        CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
          token_hash TEXT PRIMARY KEY,
          grant_id TEXT NOT NULL,
          family_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          record TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_oauth_refresh_family ON oauth_refresh_tokens(family_id);
      `);
    });
  }

  async saveGrant(grant: OAuthGrantRecord): Promise<void> {
    this.#safe(() => {
      this.#db.prepare(`
        INSERT INTO oauth_grants (id, family_id, user_id, client_id, record, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET record=excluded.record, last_used_at=excluded.last_used_at
      `).run(
        grant.id,
        grant.familyId,
        grant.userId,
        grant.clientId,
        JSON.stringify(grant),
        grant.createdAt,
        grant.lastUsedAt,
      );
    });
  }

  async getGrant(grantId: string): Promise<OAuthGrantRecord | undefined> {
    return this.#safe(() => {
      const row = this.#db.prepare("SELECT record FROM oauth_grants WHERE id = ?").get(grantId);
      if (!row) return undefined;
      return JSON.parse(row.record as string) as OAuthGrantRecord;
    });
  }

  async getGrantByFamily(familyId: string): Promise<OAuthGrantRecord | undefined> {
    return this.#safe(() => {
      const row = this.#db.prepare("SELECT record FROM oauth_grants WHERE family_id = ? ORDER BY created_at DESC LIMIT 1").get(familyId);
      if (!row) return undefined;
      return JSON.parse(row.record as string) as OAuthGrantRecord;
    });
  }

  async listGrantsByUser(userId?: string): Promise<readonly OAuthGrantRecord[]> {
    return this.#safe(() => {
      let rows: Array<{ record: unknown }>;
      if (userId) {
        rows = this.#db.prepare("SELECT record FROM oauth_grants WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Array<{ record: unknown }>;
      } else {
        rows = this.#db.prepare("SELECT record FROM oauth_grants ORDER BY created_at DESC").all() as Array<{ record: unknown }>;
      }
      return Object.freeze(rows.map((r) => JSON.parse(r.record as string) as OAuthGrantRecord));
    });
  }

  async updateGrant(grantId: string, patch: Partial<OAuthGrantRecord>): Promise<void> {
    this.#safe(() => {
      const row = this.#db.prepare("SELECT record FROM oauth_grants WHERE id = ?").get(grantId);
      if (!row) return;
      const current = JSON.parse(row.record as string) as OAuthGrantRecord;
      const updated = { ...current, ...patch };
      this.#db.prepare("UPDATE oauth_grants SET record = ?, last_used_at = ? WHERE id = ?").run(
        JSON.stringify(updated),
        updated.lastUsedAt ?? current.lastUsedAt,
        grantId,
      );
    });
  }

  async deleteGrant(grantId: string): Promise<void> {
    this.#safe(() => {
      this.#db.prepare("DELETE FROM oauth_grants WHERE id = ?").run(grantId);
    });
  }

  async saveRefreshToken(token: OAuthRefreshTokenRecord): Promise<void> {
    this.#safe(() => {
      this.#db.prepare(`
        INSERT INTO oauth_refresh_tokens (token_hash, grant_id, family_id, user_id, record, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_hash) DO UPDATE SET record=excluded.record
      `).run(
        token.tokenHash,
        token.grantId,
        token.familyId,
        token.userId,
        JSON.stringify(token),
        token.createdAt,
      );
    });
  }

  async getRefreshToken(tokenHash: string): Promise<OAuthRefreshTokenRecord | undefined> {
    return this.#safe(() => {
      const row = this.#db.prepare("SELECT record FROM oauth_refresh_tokens WHERE token_hash = ?").get(tokenHash);
      if (!row) return undefined;
      return JSON.parse(row.record as string) as OAuthRefreshTokenRecord;
    });
  }

  async markRefreshTokenUsed(tokenHash: string): Promise<void> {
    this.#safe(() => {
      const row = this.#db.prepare("SELECT record FROM oauth_refresh_tokens WHERE token_hash = ?").get(tokenHash);
      if (!row) return;
      const current = JSON.parse(row.record as string) as OAuthRefreshTokenRecord;
      current.used = true;
      this.#db.prepare("UPDATE oauth_refresh_tokens SET record = ? WHERE token_hash = ?").run(
        JSON.stringify(current),
        tokenHash,
      );
    });
  }

  async revokeFamily(familyId: string): Promise<void> {
    this.#safe(() => {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        const now = Date.now();
        this.#db.prepare("DELETE FROM oauth_refresh_tokens WHERE family_id = ?").run(familyId);
        const grantRows = this.#db.prepare("SELECT id, record FROM oauth_grants WHERE family_id = ?").all(familyId) as Array<{ id: string; record: string }>;
        for (const g of grantRows) {
          const rec = JSON.parse(g.record) as OAuthGrantRecord;
          if (rec.revokedAt === undefined) {
            rec.revokedAt = now;
            this.#db.prepare("UPDATE oauth_grants SET record = ? WHERE id = ?").run(JSON.stringify(rec), g.id);
          }
        }
        this.#db.exec("COMMIT");
      } catch (e) {
        this.#db.exec("ROLLBACK");
        throw e;
      }
    });
  }
}

export class FileOAuthStore implements OAuthStore {
  readonly #filePath: string;
  readonly #memory = new MemoryOAuthStore();

  constructor(filePath: string) {
    this.#filePath = filePath;
    this.#load();
  }

  #load(): void {
    if (!existsSync(this.#filePath)) {
      return;
    }
    try {
      const raw = readFileSync(this.#filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.#memory.load(parsed);
    } catch {
      // If corrupted or unreadable, start fresh
    }
  }

  #persist(): void {
    const dir = dirname(this.#filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.tmp_${randomBytes(8).toString("hex")}`);
    const content = JSON.stringify(this.#memory.dump(), null, 2);
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, this.#filePath);
  }

  async saveGrant(grant: OAuthGrantRecord): Promise<void> {
    await this.#memory.saveGrant(grant);
    this.#persist();
  }

  async getGrant(grantId: string): Promise<OAuthGrantRecord | undefined> {
    return this.#memory.getGrant(grantId);
  }

  async getGrantByFamily(familyId: string): Promise<OAuthGrantRecord | undefined> {
    return this.#memory.getGrantByFamily(familyId);
  }

  async listGrantsByUser(userId?: string): Promise<readonly OAuthGrantRecord[]> {
    return this.#memory.listGrantsByUser(userId);
  }

  async updateGrant(grantId: string, patch: Partial<OAuthGrantRecord>): Promise<void> {
    await this.#memory.updateGrant(grantId, patch);
    this.#persist();
  }

  async deleteGrant(grantId: string): Promise<void> {
    await this.#memory.deleteGrant(grantId);
    this.#persist();
  }

  async saveRefreshToken(token: OAuthRefreshTokenRecord): Promise<void> {
    await this.#memory.saveRefreshToken(token);
    this.#persist();
  }

  async getRefreshToken(tokenHash: string): Promise<OAuthRefreshTokenRecord | undefined> {
    return this.#memory.getRefreshToken(tokenHash);
  }

  async markRefreshTokenUsed(tokenHash: string): Promise<void> {
    await this.#memory.markRefreshTokenUsed(tokenHash);
    this.#persist();
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.#memory.revokeFamily(familyId);
    this.#persist();
  }
}

export function createOAuthStore(path?: string): OAuthStore {
  if (!path || path === ":memory:") {
    return new MemoryOAuthStore();
  }
  if (path.endsWith(".db") || path.endsWith(".sqlite")) {
    const db = new DatabaseSync(path);
    return new SqliteOAuthStore(db);
  }
  return new FileOAuthStore(path);
}
