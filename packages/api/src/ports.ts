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

/** A user's second factor. `secret` is the base32 TOTP seed: it must be recoverable to check codes, so the real store
 *  belongs in the core's secret store (follow-up); the in-memory store is for tests. `backupHashes` are SHA-256 of the
 *  normalised one-time codes. `lastStep` is the newest accepted time step (replay guard). */
export interface TotpRecord {
  readonly userId: string; readonly secret: string; readonly enabled: boolean; readonly createdAt: number;
  readonly lastStep?: number; readonly backupHashes: readonly string[];
}
export interface TotpStore {
  get(userId: string): Promise<TotpRecord | undefined>;
  put(rec: TotpRecord): Promise<void>;
  delete(userId: string): Promise<void>;
}

export interface UserDirectory {
  findByUsername(username: string): Promise<UserRecord | undefined>;
  findById(id: string): Promise<UserRecord | undefined>;
  updatePasswordHash(id: string, hash: string): Promise<void>;
}
