// The permission stores and the approval service as the core runs them: `state/approvals.sqlite` is opened on FIRST USE (the chain key comes from
// the secret store, which may touch the OS keychain, so core start never blocks on it), once; a failed open is retried by the next use; `close()`
// ends every waiting call as not approved and closes the database, and nothing opens afterwards.
import type { PolicyAudit } from "../policy/audit.ts";
import type { Clock } from "../policy/decide.ts";
import { openPermissionStores, type PermissionStores } from "../grants/open.ts";
import { RpcError } from "../rpc/errors.ts";
import type { ChainKeySource } from "./keys.ts";
import { createApprovalService, type ApprovalEvents, type ApprovalService } from "./service.ts";

export interface PermissionRuntimeOptions {
  dbPath: string;
  keys: ChainKeySource;
  clock: Clock;
  audit: PolicyAudit;
  events?: ApprovalEvents;
  securePath?: (p: string, o?: { mode?: number }) => void;
}

export interface OpenPermissions { service: ApprovalService; grants: PermissionStores["grants"]; stores: PermissionStores }

export interface PermissionRuntime {
  open(): Promise<OpenPermissions>;
  isOpen(): boolean;
  /** The opened stores, or null before the first use / after close(). Synchronous: for event mappers that run while a request is being handled. */
  current(): OpenPermissions | null;
  close(): Promise<void>;
}

const stopping = (): RpcError => new RpcError("E_NOT_AVAILABLE", "the core is stopping", { reason: "stopping" });

export function createPermissionRuntime(o: PermissionRuntimeOptions): PermissionRuntime {
  let opened: OpenPermissions | null = null;
  let opening: Promise<OpenPermissions> | null = null;
  let closed = false;

  async function doOpen(): Promise<OpenPermissions> {
    const stores = await openPermissionStores({ path: o.dbPath, keys: o.keys, clock: o.clock, audit: o.audit, ...(o.securePath ? { securePath: o.securePath } : {}) });
    if (closed) { stores.close(); throw stopping(); } // a close() during a slow open wins
    const service = createApprovalService({ stores, clock: o.clock, audit: o.audit, ...(o.events ? { events: o.events } : {}) });
    return { service, grants: stores.grants, stores };
  }

  return {
    open() {
      if (closed) return Promise.reject(stopping());
      if (opened) return Promise.resolve(opened);
      opening ??= doOpen().then(
        (r) => { opened = r; opening = null; return r; },
        (e: unknown) => { opening = null; throw e; },
      );
      return opening;
    },
    isOpen: () => opened !== null,
    current: () => opened,
    async close() {
      closed = true;
      if (opening) await opening.catch(() => {});
      const r = opened; opened = null;
      if (!r) return;
      try { r.service.dispose(); } finally { r.stores.close(); }
    },
  };
}
