import type { UserDirectory, UserRecord } from "./ports.ts";

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
