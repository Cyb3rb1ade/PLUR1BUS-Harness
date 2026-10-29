import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
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

  async listGrantsByUser(userId: string): Promise<readonly OAuthGrantRecord[]> {
    const list: OAuthGrantRecord[] = [];
    for (const g of this.#grants.values()) {
      if (g.userId === userId) {
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
    try {
      const dir = dirname(this.#filePath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = join(dir, `.tmp_${randomBytes(8).toString("hex")}`);
      const content = JSON.stringify(this.#memory.dump(), null, 2);
      writeFileSync(tmp, content, { mode: 0o600 });
      renameSync(tmp, this.#filePath);
    } catch {
      // Non-fatal store write failure
    }
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

  async listGrantsByUser(userId: string): Promise<readonly OAuthGrantRecord[]> {
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
  return new FileOAuthStore(path);
}
