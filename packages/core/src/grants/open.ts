// Opens the one approvals database with the stores that share its chain (grants and approvals must use ONE
// ApprovalChain instance: its verified-snapshot cache is per connection).
import type { DatabaseSync } from "node:sqlite";
import { ApprovalChain } from "../approvals/chain.ts";
import { openApprovalsDb, type OpenApprovalsDbOptions } from "../approvals/db.ts";
import type { ChainKeySource } from "../approvals/keys.ts";
import { type ApprovalStore, createApprovalStore } from "../approvals/store.ts";
import type { Clock } from "../policy/decide.ts";
import { GrantStore } from "./store.ts";

export interface PermissionStores {
  db: DatabaseSync;
  chain: ApprovalChain;
  grants: GrantStore;
  approvals: ApprovalStore;
  close(): void;
}

export interface OpenPermissionStoresOptions extends OpenApprovalsDbOptions {
  keys: ChainKeySource;
  clock: Clock;
  requestTtlMs?: number;
}

export async function openPermissionStores(o: OpenPermissionStoresOptions): Promise<PermissionStores> {
  const db = openApprovalsDb(o);
  try {
    const approvals = await createApprovalStore({ db, keys: o.keys, clock: o.clock, ...(o.requestTtlMs !== undefined ? { requestTtlMs: o.requestTtlMs } : {}) });
    const chain = approvals.chain;
    return { db, chain, approvals, grants: new GrantStore({ db, chain, clock: o.clock }), close: () => db.close() };
  } catch (e) {
    db.close();
    throw e;
  }
}
