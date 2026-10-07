import { randomUUID } from "node:crypto";
import type { Actor, IdentityService } from "./service.ts";
import { deriveUserPrincipal, isUserPrincipal } from "./principals.ts";
import { IdentityError } from "./store.ts";

/** Dedicated engine operation. It must touch owner metadata only, preserve vectors, and atomically
 * remember operationId → result. Reverse must use the exact receipt's row set (never all v2 rows). */
export interface MetadataRebindPort {
  rebind(p: { from: string; to: string; dryRun: boolean; operationId: string }): Promise<{ count: number; receipt?: string }>;
  reverse(p: { receipt: string; dryRun: boolean; operationId: string }): Promise<{ count: number }>;
}
export interface BackfillReport {
  linkId: string; from: string; to: string; dryRun: boolean; count: number; at: number; receipt?: string;
}
export function createBackfill(o: { service: IdentityService; engine: MetadataRebindPort; clock: () => number }) {
  const s = o.service;
  const busy = new Set<string>();
  async function exclusive<T>(linkId: string, fn: () => Promise<T>): Promise<T> {
    if (busy.has(linkId)) throw new IdentityError("conflict", "backfill already in progress");
    busy.add(linkId);
    try { return await fn(); } finally { busy.delete(linkId); }
  }
  const countOf = (count: number): number => {
    if (!Number.isSafeInteger(count) || count < 0) throw new IdentityError("storage", "invalid engine rebind count");
    return count;
  };
  return {
    run(p: { linkId: string; dryRun: boolean }, actor: Actor): Promise<BackfillReport> {
      return exclusive(p.linkId, async () => {
        const link = s.getLink(p.linkId);
        s.authorizeAction("backfill", link.humanId, actor);
        if (link.revokedAt !== null) throw new IdentityError("conflict", "cannot backfill a removed link");
        if (!isUserPrincipal(link.v1Principal) || !link.v1Principal.startsWith("user:v1:")) throw new IdentityError("storage", "invalid source principal");
        const to = deriveUserPrincipal(link.humanId);
        let record = s.backfillRecord(link.id);
        if (record && ["reversing", "reversed"].includes(record.state as string)) throw new IdentityError("conflict", "backfill was reversed or is reversing");
        if (!p.dryRun && !record) {
          s.reserveBackfill(link.id, randomUUID(), actor);
          record = s.backfillRecord(link.id)!;
        }
        let result: { count: number; receipt?: string };
        if (!p.dryRun && record?.state === "applied") {
          result = { count: record.count as number, receipt: record.receipt as string };
        } else {
          result = await o.engine.rebind({ from: link.v1Principal, to, dryRun: p.dryRun, operationId: record?.operation_id as string ?? randomUUID() });
          countOf(result.count);
          if (!p.dryRun) {
            if (typeof result.receipt !== "string" || !result.receipt) throw new IdentityError("storage", "engine must return a reversible receipt");
            s.finishBackfill(link.id, "applied", result.count, result.receipt);
          }
        }
        const report: BackfillReport = { linkId: link.id, from: link.v1Principal, to, dryRun: p.dryRun, count: countOf(result.count), at: o.clock(), ...(result.receipt ? { receipt: result.receipt } : {}) };
        s.emit({ action: "identity.backfill", target: link.id, detail: { from: report.from, to, count: report.count, dryRun: p.dryRun, at: report.at, receipt: result.receipt ?? "" }, actor });
        return report;
      });
    },
    reverse(p: { linkId: string; dryRun: boolean }, actor: Actor): Promise<{ count: number }> {
      return exclusive(p.linkId, async () => {
        const link = s.getLink(p.linkId);
        s.authorizeAction("backfill", link.humanId, actor);
        const record = s.backfillRecord(link.id);
        if (!record || record.state === "running") throw new IdentityError("conflict", "no applied backfill to reverse");
        if (record.state === "reversed") return { count: record.count as number };
        if (!p.dryRun) s.finishBackfill(link.id, "reversing", record.count as number, record.receipt as string);
        const result = await o.engine.reverse({ receipt: record.receipt as string, dryRun: p.dryRun, operationId: `${record.operation_id as string}:reverse` });
        countOf(result.count);
        if (!p.dryRun) s.finishBackfill(link.id, "reversed", result.count, record.receipt as string);
        s.emit({ action: "identity.backfill.reversed", target: link.id, detail: { count: result.count, dryRun: p.dryRun, from: deriveUserPrincipal(link.humanId), to: link.v1Principal }, actor });
        return result;
      });
    },
  };
}
