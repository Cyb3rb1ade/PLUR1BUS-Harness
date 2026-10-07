import type { AgentRight, ProjectRight, Role } from "./rbac-bridge.ts";

/** A local account. The core has no credential store yet (`identity` knows humans and channel links only), so the API
 *  owns this port; the in-memory implementation serves tests, the real store is a follow-up. `version` rises with every
 *  change of role, rights, password or second factor: sessions are rotated when it moves. */
export interface UserRecord {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
  readonly agentRights?: Readonly<Record<string, AgentRight>>;
  readonly projectRights?: Readonly<Record<string, ProjectRight>>;
  /** PHC Argon2id string, absent for an account without a password (token-only). */
  readonly passwordHash?: string;
  readonly disabled?: boolean;
  readonly version: number;
}

/** A personal API token as stored: the public `id` (part of the token string, shown in lists) and the SHA-256 of the
 *  secret part only. The full token string exists nowhere after it was shown once. */
export interface TokenRecord {
  readonly id: string; readonly userId: string; readonly name: string;
  /** Exact RBAC action names or `prefix.*`; they can only narrow what the user's role allows. */
  readonly scopes: readonly string[];
  readonly hash: string;
  readonly createdAt: number; readonly expiresAt: number;
  readonly lastUsedAt?: number; readonly revokedAt?: number;
}
export interface TokenStore {
  put(rec: TokenRecord): Promise<void>;
  get(id: string): Promise<TokenRecord | undefined>;
  listByUser(userId: string): Promise<TokenRecord[]>;
  update(id: string, patch: { lastUsedAt?: number; revokedAt?: number }): Promise<void>;
}

export interface UserDirectory {
  findByUsername(username: string): Promise<UserRecord | undefined>;
  findById(id: string): Promise<UserRecord | undefined>;
  updatePasswordHash(id: string, hash: string): Promise<void>;
}
