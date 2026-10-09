import { DatabaseSync } from 'node:sqlite';
import type { Usage } from '../../../providers/src/types.ts';
/** Separate plan unit; unknown usage stays unknown, and no subscription unit is assigned a dollar price. */
export class PlanUsageStore {
  readonly #db: DatabaseSync;
  constructor(path: string) { this.#db = new DatabaseSync(path); this.#db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS plan_usage (id TEXT PRIMARY KEY, person TEXT NOT NULL, credential TEXT NOT NULL, model TEXT NOT NULL, input INTEGER, output INTEGER, at INTEGER NOT NULL)'); }
  record(id: string, person: string, credential: string, model: string, usage: Usage, at: number) {
    for (const count of [usage.inputTokens, usage.outputTokens]) if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) throw new RangeError('invalid plan usage');
    this.#db.prepare('INSERT OR IGNORE INTO plan_usage VALUES (?,?,?,?,?,?,?)').run(id, person, credential, model, usage.inputTokens ?? null, usage.outputTokens ?? null, at);
  }
  total(person: string) { return { unit: 'plan_tokens' as const, ...this.#db.prepare('SELECT SUM(input) AS inputTokens, SUM(output) AS outputTokens, COUNT(*) AS calls FROM plan_usage WHERE person=?').get(person) }; }
  close() { this.#db.close(); }
}
