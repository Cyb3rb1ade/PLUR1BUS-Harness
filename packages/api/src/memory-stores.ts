import type { TokenRecord, TokenStore, TotpRecord, TotpStore, UserDirectory, UserRecord } from "./ports.ts";

/** In-memory `TotpStore` for tests. */
export class MemoryTotpStore implements TotpStore {
  readonly #byUser = new Map<string, TotpRecord>();
  async get(userId: string): Promise<TotpRecord | undefined> { return this.#byUser.get(userId); }
  async put(rec: TotpRecord): Promise<void> { this.#byUser.set(rec.userId, Object.freeze({ ...rec })); }
  async delete(userId: string): Promise<void> { this.#byUser.delete(userId); }
  dump(): string { return JSON.stringify([...this.#byUser.values()]); }
}

/** In-memory `TokenStore` for tests; records are copied in and out so a caller cannot mutate the stored one. */
export class MemoryTokenStore implements TokenStore {
  readonly #byId = new Map<string, TokenRecord>();
  async put(rec: TokenRecord): Promise<void> { this.#byId.set(rec.id, Object.freeze({ ...rec })); }
  async get(id: string): Promise<TokenRecord | undefined> { return this.#byId.get(id); }
  async listByUser(userId: string): Promise<TokenRecord[]> { return [...this.#byId.values()].filter((t) => t.userId === userId).sort((a, b) => b.createdAt - a.createdAt); }
  async update(id: string, patch: { lastUsedAt?: number; revokedAt?: number }): Promise<void> {
    const cur = this.#byId.get(id); if (cur) this.#byId.set(id, Object.freeze({ ...cur, ...patch }));
  }
  /** What a heap or disk dump of the store would hold: for tests that check no secret is in it. */
  dump(): string { return JSON.stringify([...this.#byId.values()]); }
}

export const normalizeUsername = (u: string): string => u.normalize("NFC").trim().toLowerCase();

/** In-memory `UserDirectory` for tests and for an installation that has not wired a store yet. */
export class MemoryUserDirectory implements UserDirectory {
  readonly #byId = new Map<string, UserRecord>();
  add(u: Omit<UserRecord, "version"> & { version?: number }): UserRecord {
    const rec: UserRecord = Object.freeze({ ...u, username: normalizeUsername(u.username), version: u.version ?? 1 });
    this.#byId.set(rec.id, rec);
    return rec;
  }
  /** Replaces fields and raises `version`, as a store must on every role, rights or password change. */
  change(id: string, patch: Partial<Omit<UserRecord, "id" | "version">>): UserRecord {
    const cur = this.#byId.get(id); if (!cur) throw new Error(`no user ${id}`);
    const rec: UserRecord = Object.freeze({ ...cur, ...patch, version: cur.version + 1 });
    this.#byId.set(id, rec);
    return rec;
  }
  async findByUsername(username: string): Promise<UserRecord | undefined> {
    const n = normalizeUsername(username);
    for (const u of this.#byId.values()) if (u.username === n) return u;
    return undefined;
  }
  async findById(id: string): Promise<UserRecord | undefined> { return this.#byId.get(id); }
  async updatePasswordHash(id: string, hash: string): Promise<void> { this.change(id, { passwordHash: hash }); }
}
