// F42 read-only join against the existing harness budget ledger. No engine database, transcript or prompt is read.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { RpcError } from "./errors.ts";
export interface SessionUsage { model: string | null; usage: { inputTokens: number; outputTokens: number; costMicros: number | null; pendingCalls: number } }
export function sessionUsage(file: string, ids: readonly string[]): Map<string, SessionUsage> {
  const result = new Map<string, SessionUsage>(); if (!ids.length || !existsSync(file)) return result;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const present = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('budget_call','usage_event')").all();
    if (present.length !== 2) return result; // a pre-composition budget store has no per-session admission ledger
    const rows = db.prepare(`SELECT c.session,c.model,c.state,c.cost,u.input_tokens,u.output_tokens FROM budget_call c
      LEFT JOIN usage_event u ON u.request_id='budget-call:'||c.id WHERE c.session IN (${ids.map(() => "?").join(",")}) ORDER BY c.ts,c.rowid`).all(...ids) as unknown as { session: string; model: string; state: string; cost: number | null; input_tokens: number | null; output_tokens: number | null }[];
    const count = (n: unknown): number => { if (!Number.isSafeInteger(n) || Number(n)<0) throw new RpcError("E_STORAGE", "invalid session usage count"); return Number(n); };
    for (const r of rows) {
      const s = result.get(r.session) ?? { model: null, usage: { inputTokens: 0, outputTokens: 0, costMicros: 0, pendingCalls: 0 } };
      s.model = r.model;
      if (r.state === "reserved") { s.usage.pendingCalls++; s.usage.costMicros = null; }
      else {
        if (r.input_tokens === null || r.output_tokens === null) { s.usage.costMicros = null; }
        else { s.usage.inputTokens = count(s.usage.inputTokens + count(r.input_tokens)); s.usage.outputTokens = count(s.usage.outputTokens + count(r.output_tokens)); }
        if (r.cost === null) s.usage.costMicros=null;
        else if (s.usage.costMicros !== null) s.usage.costMicros=count(s.usage.costMicros + count(r.cost));
      }
      result.set(r.session,s);
    }
    return result;
  } catch (e) { if (e instanceof RpcError) throw e; throw new RpcError("E_STORAGE", "session usage ledger unavailable"); }
  finally { db.close(); }
}
