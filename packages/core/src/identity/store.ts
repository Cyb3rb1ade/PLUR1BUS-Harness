import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Raised for every failure of the identity store and service; `code` is the closed vocabulary the RPC layer maps. */
export type IdentityErrorCode = "invalid-params" | "not-found" | "invalid-code" | "expired" | "rate-limited" | "conflict" | "limit" | "storage";
export class IdentityError extends Error {
  readonly code: IdentityErrorCode; readonly field?: string; readonly retryAfterMs?: number;
  constructor(code: IdentityErrorCode, message: string, o: { field?: string; retryAfterMs?: number } = {}) {
    super(message); this.name = "IdentityError"; this.code = code;
    if (o.field !== undefined) this.field = o.field;
    if (o.retryAfterMs !== undefined) this.retryAfterMs = o.retryAfterMs;
  }
}

export const SCHEMA_VERSION = 1;

/** Each entry migrates from `index` to `index + 1`; append only. Run in one transaction with the version bump. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE humans (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL
  ) STRICT;
  CREATE TABLE identities (
    id TEXT PRIMARY KEY,
    human_id TEXT NOT NULL REFERENCES humans(id),
    channel TEXT NOT NULL, account_id TEXT NOT NULL, channel_user_id TEXT NOT NULL,
    display_name TEXT,
    v1_principal TEXT NOT NULL,
    -- RULING: signed_challenge is part of the model, but no flow offers it yet (fail closed).
    proof_method TEXT NOT NULL CHECK (proof_method IN ('pairing_code', 'owner_manual', 'signed_challenge')),
    linked_at INTEGER NOT NULL, linked_by TEXT NOT NULL,
    revoked_at INTEGER, revoked_by TEXT
  ) STRICT;
  -- N:1: many identities per human, but an identity belongs to at most one human at a time (ADR-007 Q4).
  CREATE UNIQUE INDEX identities_active ON identities(channel, account_id, channel_user_id) WHERE revoked_at IS NULL;
  CREATE INDEX identities_human ON identities(human_id);
  CREATE TABLE pairings (
    id TEXT PRIMARY KEY,
    human_id TEXT NOT NULL REFERENCES humans(id),
    channel TEXT NOT NULL,
    salt TEXT NOT NULL, code_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'confirmed', 'declined', 'expired')),
    created_at INTEGER NOT NULL, created_by TEXT NOT NULL, expires_at INTEGER NOT NULL,
    claim_account_id TEXT, claim_user_id TEXT, claim_display_name TEXT, claimed_at INTEGER, confirm_by INTEGER,
    resolved_at INTEGER, link_id TEXT
  ) STRICT;
  CREATE INDEX pairings_state ON pairings(state, channel);
  CREATE TABLE attempts (
    key TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_start INTEGER NOT NULL, locked_until INTEGER NOT NULL
  ) STRICT;
  `,
];

/** Opens (creating, 0700 directory) and migrates the identity database. A file from a newer harness is refused, never altered. */
export function openStore(file: string): DatabaseSync {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > SCHEMA_VERSION) {
      db.close();
      throw new IdentityError("storage", `identity store is schema ${version}, newer than this harness (${SCHEMA_VERSION})`);
    }
    for (let v = version; v < SCHEMA_VERSION; v++) {
      db.exec("BEGIN IMMEDIATE");
      try { db.exec(MIGRATIONS[v]!); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec("COMMIT"); }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    }
    return db;
  } catch (e) {
    if (e instanceof IdentityError) throw e;
    throw new IdentityError("storage", `identity store unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}
