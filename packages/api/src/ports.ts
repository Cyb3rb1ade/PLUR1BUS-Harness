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

export interface UserDirectory {
  findByUsername(username: string): Promise<UserRecord | undefined>;
  findById(id: string): Promise<UserRecord | undefined>;
  updatePasswordHash(id: string, hash: string): Promise<void>;
}
