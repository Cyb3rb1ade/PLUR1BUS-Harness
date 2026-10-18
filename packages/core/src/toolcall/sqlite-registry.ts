import { createHash } from 'node:crypto';
import { canonicalJson } from '../tools/dispatcher.ts';
import { DatabaseSync } from 'node:sqlite';
import { CapabilityIndex, type CapabilityEntry, type RegistrationPort } from './capabilities.ts';
export interface CapabilityStats { offered: number; used: number; foundBySearch: number; succeeded: number }
/** Persistent registration port. The owner chooses a scratch/test or application DB; no paths or timers are implicit. */
export class SqliteCapabilityRegistry implements RegistrationPort {
  readonly #db: DatabaseSync;
  readonly #subscribers = new Set<Parameters<RegistrationPort['subscribe']>[0]>();
  readonly #clock: () => number;
  constructor(path: string, clock: () => number = Date.now) {
    this.#clock = clock;
    this.#db = new DatabaseSync(path);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS capability_index (id TEXT PRIMARY KEY, version TEXT NOT NULL, entry TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capability_stats (id TEXT NOT NULL, agent TEXT NOT NULL, offered INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, searched INTEGER NOT NULL DEFAULT 0, succeeded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (id, agent));
      CREATE TABLE IF NOT EXISTS capability_usage (id TEXT NOT NULL, agent TEXT NOT NULL, bucket INTEGER NOT NULL, offered INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, searched INTEGER NOT NULL DEFAULT 0, succeeded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(id,agent,bucket));
      CREATE TABLE IF NOT EXISTS capability_hashes (id TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS capability_fts USING fts5(id UNINDEXED, text);
      CREATE TABLE IF NOT EXISTS capability_vectors (id TEXT PRIMARY KEY, hash TEXT NOT NULL, model TEXT NOT NULL, vector TEXT NOT NULL);`);
    // Migrate existing library registries without changing their row shape.
    for (const entry of this.snapshot()) this.#writeSearch(entry);
  }
  snapshot(): CapabilityEntry[] { return this.#db.prepare('SELECT entry FROM capability_index ORDER BY id').all().map(r => JSON.parse(r['entry'] as string) as CapabilityEntry); }
  subscribe(fn: Parameters<RegistrationPort['subscribe']>[0]): () => void { this.#subscribers.add(fn); return () => { this.#subscribers.delete(fn); }; }
  upsert(entry: CapabilityEntry): void {
    // Reuse library registration validation before writing anything persistent.
    new CapabilityIndex().upsert(entry);
    const text = JSON.stringify(entry); const old = this.#db.prepare('SELECT entry FROM capability_index WHERE id = ?').get(entry.id);
    if (old?.['entry'] === text) return;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
    this.#db.prepare('INSERT INTO capability_index (id,version,entry) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,entry=excluded.entry').run(entry.id, entry.version, text);
    if (old && (JSON.parse(String(old['entry'])) as CapabilityEntry).version !== entry.version) { for (const table of ['capability_stats', 'capability_usage']) this.#db.prepare(`DELETE FROM ${table} WHERE id=?`).run(entry.id); }
    this.#writeSearch(entry);
    this.#db.exec('COMMIT');
    } catch (e) { this.#db.exec('ROLLBACK'); throw e; }
    for (const fn of this.#subscribers) fn({ upsert: structuredClone(entry) });
  }
  remove(id: string): void {
    const result = this.#db.prepare('DELETE FROM capability_index WHERE id = ?').run(id);
    this.#db.prepare('DELETE FROM capability_fts WHERE id=?').run(id);
    for (const table of ['capability_hashes', 'capability_vectors', 'capability_stats', 'capability_usage']) this.#db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
    if (result.changes) for (const fn of this.#subscribers) fn({ remove: id });
  }
  record(id: string, agent: string, event: 'offered' | 'used' | 'foundBySearch' | 'succeeded'): void {
    const column = { offered: 'offered', used: 'used', foundBySearch: 'searched', succeeded: 'succeeded' }[event];
    if (!column) throw Error('unknown capability statistic');
    if (!this.#db.prepare('SELECT id FROM capability_index WHERE id=?').get(id)) throw Error('unknown capability');
    this.#db.prepare(`INSERT INTO capability_stats(id,agent,${column}) VALUES(?,?,1) ON CONFLICT(id,agent) DO UPDATE SET ${column}=${column}+1`).run(id, agent);
    const bucket = Math.floor(this.#clock() / 3_600_000) * 3_600_000;
    this.#db.prepare(`INSERT INTO capability_usage(id,agent,bucket,${column}) VALUES(?,?,?,1) ON CONFLICT(id,agent,bucket) DO UPDATE SET ${column}=${column}+1`).run(id, agent, bucket);
  }
  weightedStats(id: string, agent: string | undefined, halfLifeDays: number, now = this.#clock()): CapabilityStats {
    if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0 || !Number.isFinite(now)) throw Error('invalid decay window');
    const sql = `SELECT u.* FROM capability_usage u JOIN capability_index i ON i.id=u.id
      WHERE json_extract(i.entry, '$.name')=(SELECT json_extract(entry, '$.name') FROM capability_index WHERE id=?)
      AND json_extract(i.entry, '$.kind')=(SELECT json_extract(entry, '$.kind') FROM capability_index WHERE id=?)
      AND json_extract(i.entry, '$.version')=(SELECT json_extract(entry, '$.version') FROM capability_index WHERE id=?)`;
    const rows = agent === undefined ? this.#db.prepare(sql).all(id, id, id) : this.#db.prepare(sql + ' AND u.agent=?').all(id, id, id, agent);
    const total: CapabilityStats = { offered: 0, used: 0, foundBySearch: 0, succeeded: 0 };
    for (const row of rows) {
      const weight = 2 ** (-Math.max(0, now - Number(row['bucket'])) / (halfLifeDays * 86_400_000));
      total.offered += Number(row['offered']) * weight; total.used += Number(row['used']) * weight;
      total.foundBySearch += Number(row['searched']) * weight; total.succeeded += Number(row['succeeded']) * weight;
    }
    return total;
  }
  agents(): string[] { return this.#db.prepare('SELECT DISTINCT agent FROM capability_usage ORDER BY agent').all().map(r => String(r['agent'])); }
  stats(id: string, agent: string): CapabilityStats {
    const row = this.#db.prepare('SELECT offered,used,searched,succeeded FROM capability_stats WHERE id=? AND agent=?').get(id, agent);
    return { offered: Number(row?.['offered'] ?? 0), used: Number(row?.['used'] ?? 0), foundBySearch: Number(row?.['searched'] ?? 0), succeeded: Number(row?.['succeeded'] ?? 0) };
  }
  #writeSearch(entry: CapabilityEntry): void {
    const hash = createHash('sha256').update(canonicalJson(entry)).digest('hex');
    if (this.hash(entry.id) === hash) return;
    this.#db.prepare('DELETE FROM capability_fts WHERE id=?').run(entry.id);
    this.#db.prepare('INSERT INTO capability_fts(id,text) VALUES(?,?)').run(entry.id, [entry.name, entry.description, entry.category, entry.useWhen, entry.inputs].filter(Boolean).join(' '));
    this.#db.prepare('INSERT OR REPLACE INTO capability_hashes(id,hash) VALUES(?,?)').run(entry.id, hash);
    this.#db.prepare('DELETE FROM capability_vectors WHERE id=?').run(entry.id);
  }
  hash(id: string): string | undefined { return this.#db.prepare('SELECT hash FROM capability_hashes WHERE id=?').get(id)?.['hash'] as string | undefined; }
  /** Bound literal terms only: no caller-controlled FTS query operators. */
  search(query: string, allowed: ReadonlySet<string>, limit = 12): CapabilityEntry[] {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 128) throw Error('search limit must be 0..128');
    const terms = query.slice(0, 4096).match(/[\p{L}\p{N}_]+/gu)?.slice(0, 64) ?? [];
    if (!terms.length || !limit) return [];
    const match = terms.map(t => `"${t}"`).join(' OR ');
    return this.#db.prepare('SELECT i.id,i.entry FROM capability_fts f JOIN capability_index i ON i.id=f.id WHERE capability_fts MATCH ? ORDER BY bm25(capability_fts),i.id').all(match)
      .filter(r => allowed.has(String(r['id']))).slice(0, limit).map(r => JSON.parse(String(r['entry'])) as CapabilityEntry);
  }
  /** Only a local model adapter may supply vectors; the storage layer has no network client. */
  putVector(id: string, hash: string, model: string, vector: readonly number[]): boolean {
    if (!model || !vector.length || vector.length > 16384 || vector.some(v => !Number.isFinite(v))) throw Error('invalid local vector');
    if (this.hash(id) !== hash) return false;
    this.#db.prepare('INSERT OR REPLACE INTO capability_vectors(id,hash,model,vector) VALUES(?,?,?,?)').run(id, hash, model, JSON.stringify(vector));
    return true;
  }
  vector(id: string, model: string): number[] | undefined {
    const row = this.#db.prepare('SELECT vector FROM capability_vectors WHERE id=? AND model=? AND hash=?').get(id, model, this.hash(id) ?? '');
    return row ? JSON.parse(String(row['vector'])) as number[] : undefined;
  }
  close(): void { this.#subscribers.clear(); this.#db.close(); }
}
