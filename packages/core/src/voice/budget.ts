import { DatabaseSync } from 'node:sqlite';
import type { CallBudget } from '../budget/index.ts';
import type { VoiceBudgetPort } from './ports.ts';
/** Separate authoritative voice-seconds ledger. The existing call-budget admits every opening and backend usage. */
export function voiceBudget(o: { path: string; budget: CallBudget; clock: () => number; dailySeconds: number; billingProvider?: string }) {
  const db = new DatabaseSync(o.path); db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS voice_usage (id TEXT PRIMARY KEY, agent TEXT NOT NULL, person TEXT NOT NULL, at INTEGER NOT NULL, seconds REAL NOT NULL, cost INTEGER NOT NULL);');
  const held = new Map<string, { agent: string; person: string; ticket: string; model: string }>();
  const allowed = (agent: string, person: string) => {
    const start = Math.floor(o.clock() / 86400000) * 86400000;
    const rows = db.prepare('SELECT COALESCE(SUM(seconds),0) AS seconds FROM voice_usage WHERE at>=? AND (agent=? OR person=?)').get(start, agent, person) as { seconds: number };
    return rows.seconds < o.dailySeconds;
  };
  const port: VoiceBudgetPort = {
    async reserve(r) {
      if (!allowed(r.agent, r.user)) return false;
      const decision = o.budget.checkBeforeCall({ principal: r.user, agent: r.agent, project: 'voice', model: r.model ?? 'gpt-live-1', provider: o.billingProvider ?? 'openai-voice', session: r.reservation, estimatedInputTokens: 0, maxOutputTokens: 0 });
      if (decision.kind === 'refuse') return false;
      held.set(r.reservation, { agent: r.agent, person: r.user, ticket: decision.reservationId, model: r.model ?? 'gpt-live-1' }); return true;
    },
    async record(r) {
      const h = held.get(r.reservation); if (!h || h.person !== r.user || h.agent !== r.agent) return false;
      db.prepare('INSERT OR IGNORE INTO voice_usage VALUES (?,?,?,?,?,?)').run(r.reservation + ':' + r.eventId, r.agent, r.user, o.clock(), r.usage.seconds, r.usage.costMicros);
      if (r.usage.inputTokens || r.usage.outputTokens) {
        const decision = o.budget.checkBeforeCall({ principal: r.user, agent: r.agent, project: 'voice', model: h.model, provider: o.billingProvider ?? 'openai-voice', session: r.reservation, estimatedInputTokens: r.usage.inputTokens, maxOutputTokens: r.usage.outputTokens });
        if (decision.kind === 'refuse') return false;
        const settlement = o.budget.settle(decision.reservationId, { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens });
        if (settlement.overages.length) return false;
      }
      return allowed(r.agent, r.user);
    },
    async release(reservation) { const entry = held.get(reservation); if (entry) { o.budget.releaseUnused(entry.ticket); held.delete(reservation); } },
  };
  return { port, close() { for (const h of held.values()) o.budget.releaseUnused(h.ticket); held.clear(); db.close(); } };
}
