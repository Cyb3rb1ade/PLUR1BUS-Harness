import { DatabaseSync } from 'node:sqlite';
import { CapabilityIndex, type CapabilityEntry, type RegistrationPort } from './capabilities.ts';
export interface CapabilityStats { offered: number; used: number; foundBySearch: number; succeeded: number }
/** Persistent registration port. The owner chooses a scratch/test or application DB; no paths or timers are implicit. */
export class SqliteCapabilityRegistry implements RegistrationPort {
  readonly #db: DatabaseSync;
  readonly #subscribers = new Set<Parameters<RegistrationPort['subscribe']>[0]>();
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS capability_index (id TEXT PRIMARY KEY, version TEXT NOT NULL, entry TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capability_stats (id TEXT NOT NULL, agent TEXT NOT NULL, offered INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, searched INTEGER NOT NULL DEFAULT 0, succeeded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (id, agent));`);
  }
  snapshot(): CapabilityEntry[] { return this.#db.prepare('SELECT entry FROM capability_index ORDER BY id').all().map(r => JSON.parse(r['entry'] as string) as CapabilityEntry); }
  subscribe(fn: Parameters<RegistrationPort['subscribe']>[0]): () => void { this.#subscribers.add(fn); return () => { this.#subscribers.delete(fn); }; }
  upsert(entry: CapabilityEntry): void {
    // Reuse library registration validation before writing anything persistent.
    new CapabilityIndex().upsert(entry);
    const text = JSON.stringify(entry); const old = this.#db.prepare('SELECT entry FROM capability_index WHERE id = ?').get(entry.id);
    if (old?.['entry'] === text) return;
    this.#db.prepare('INSERT INTO capability_index (id,version,entry) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,entry=excluded.entry').run(entry.id, entry.version, text);
    for (const fn of this.#subscribers) fn({ upsert: structuredClone(entry) });
  }
  remove(id: string): void {
    const result = this.#db.prepare('DELETE FROM capability_index WHERE id = ?').run(id);
    if (result.changes) for (const fn of this.#subscribers) fn({ remove: id });
  }
  record(id: string, agent: string, event: 'offered' | 'used' | 'foundBySearch' | 'succeeded'): void {
    const column = { offered: 'offered', used: 'used', foundBySearch: 'searched', succeeded: 'succeeded' }[event];
    if (!column) throw Error('unknown capability statistic');
    if (!this.#db.prepare('SELECT id FROM capability_index WHERE id=?').get(id)) throw Error('unknown capability');
    this.#db.prepare(`INSERT INTO capability_stats(id,agent,${column}) VALUES(?,?,1) ON CONFLICT(id,agent) DO UPDATE SET ${column}=${column}+1`).run(id, agent);
  }
  stats(id: string, agent: string): CapabilityStats {
    const row = this.#db.prepare('SELECT offered,used,searched,succeeded FROM capability_stats WHERE id=? AND agent=?').get(id, agent);
    return { offered: Number(row?.['offered'] ?? 0), used: Number(row?.['used'] ?? 0), foundBySearch: Number(row?.['searched'] ?? 0), succeeded: Number(row?.['succeeded'] ?? 0) };
  }
  close(): void { this.#subscribers.clear(); this.#db.close(); }
}
