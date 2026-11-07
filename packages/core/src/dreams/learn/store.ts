import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { digest, targetHash, validateTarget } from './selection.ts';
import { PROMPT_VERSION, type Finding, type LearnRun, type Reason, type Target, type Window } from './types.ts';

/** Content is exclusively in learn_payload. Generic ledger projections never select that column. */
export class LearnStore {
  readonly #db: DatabaseSync;
  constructor(file: string, secure?: (path: string, options?: { mode?: number }) => unknown) {
    if (file !== ':memory:') { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); secure?.(dirname(file), { mode: 0o700 }); }
    this.#db = new DatabaseSync(file);
    try {
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const version = Number(this.#db.prepare('PRAGMA user_version').get()!.user_version);
      if (version > 1) throw Error('newer learn schema');
      if (!version) this.#db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE learn_run(id TEXT PRIMARY KEY, target_hash TEXT NOT NULL, window_from INTEGER NOT NULL, window_to INTEGER NOT NULL, metadata TEXT NOT NULL, UNIQUE(target_hash,window_from,window_to));
        CREATE TABLE learn_step(run_id TEXT NOT NULL REFERENCES learn_run(id), step TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(run_id,step));
        CREATE TABLE learn_payload(run_id TEXT NOT NULL REFERENCES learn_run(id), key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id,key));
        CREATE TABLE learn_finding(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES learn_run(id), state TEXT NOT NULL);
        CREATE TABLE learn_decision(finding_id TEXT PRIMARY KEY REFERENCES learn_finding(id), reviewer TEXT NOT NULL, outcome TEXT NOT NULL, decided_at INTEGER NOT NULL, receipt TEXT NOT NULL);
        PRAGMA user_version=1; COMMIT;`);
      if (file !== ':memory:') { chmodSync(file, 0o600); secure?.(file); }
    } catch (error) { this.#db.close(); throw error; }
  }
  close(): void { this.#db.close(); }
  transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.#db.exec('COMMIT'); return result; } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  begin(target: Target, window: Window, now: number): LearnRun {
    validateTarget(target);
    const hash = targetHash(target);
    const previous = this.#db.prepare('SELECT metadata FROM learn_run WHERE target_hash=? AND window_from=? AND window_to=?').get(hash, window.from, window.to);
    if (previous) return JSON.parse(previous.metadata as string) as LearnRun;
    const run: LearnRun = { id: digest([hash, window.from, window.to, PROMPT_VERSION]), target, window, sessionIds: [], digest: '', startedAt: now, finishedAt: null, outcome: null, reason: null, tokens: 0, findings: 0 };
    this.#db.prepare('INSERT INTO learn_run VALUES(?,?,?,?,?)').run(run.id, hash, window.from, window.to, JSON.stringify(run)); return run;
  }
  get(id: string): LearnRun | null { const row = this.#db.prepare('SELECT metadata FROM learn_run WHERE id=?').get(id); return row ? JSON.parse(row.metadata as string) as LearnRun : null; }
  save(run: LearnRun): void { this.#db.prepare('UPDATE learn_run SET metadata=? WHERE id=?').run(JSON.stringify(run), run.id); }
  runs(owner: string): LearnRun[] { return this.#db.prepare('SELECT metadata FROM learn_run ORDER BY window_to DESC LIMIT 1000').all().map(r => JSON.parse(r.metadata as string) as LearnRun).filter(r => r.target.owner === owner); }
  breakerOpen(target: Target, now: number): boolean {
    const start = Math.floor(now / 86_400_000) * 86_400_000;
    return this.runs(target.owner).filter(r => r.startedAt >= start && r.outcome === 'failed' && targetHash(r.target) === targetHash(target)).length >= 3;
  }
  step(runId: string, step: string, state: 'started' | 'completed'): void { this.#db.prepare('INSERT INTO learn_step VALUES(?,?,?) ON CONFLICT(run_id,step) DO UPDATE SET state=excluded.state').run(runId, step, state); }
  payload<T>(runId: string, key: string): T | null { const row = this.#db.prepare('SELECT payload FROM learn_payload WHERE run_id=? AND key=?').get(runId, key); return row ? JSON.parse(row.payload as string) as T : null; }
  checkpoint(runId: string, key: string, value: unknown): void {
    this.transaction(() => { this.#db.prepare('INSERT INTO learn_payload VALUES(?,?,?) ON CONFLICT(run_id,key) DO UPDATE SET payload=excluded.payload').run(runId, key, JSON.stringify(value)); this.step(runId, key, 'completed'); });
  }
  finish(run: LearnRun, outcome: NonNullable<LearnRun['outcome']>, reason: Reason | null, now: number): void { run.outcome = outcome; run.reason = reason; run.finishedAt = now; this.save(run); }
  publish(run: LearnRun, findings: Finding[], now: number): void {
    this.transaction(() => {
      for (const f of findings) {
        this.#db.prepare('INSERT OR IGNORE INTO learn_finding VALUES(?,?,?)').run(f.id, run.id, f.status);
        this.#db.prepare('INSERT OR IGNORE INTO learn_payload VALUES(?,?,?)').run(run.id, `finding:${f.id}`, JSON.stringify(f));
      }
      run.findings = findings.length; this.finish(run, 'completed', null, now);
    });
  }
  finding(id: string): Finding | null {
    const row = this.#db.prepare('SELECT run_id,state FROM learn_finding WHERE id=?').get(id);
    if (!row) return null;
    const f = this.payload<Finding>(row.run_id as string, `finding:${id}`);
    return f ? { ...f, status: row.state as Finding['status'] } : null;
  }
  findings(runId: string): Finding[] { return this.#db.prepare('SELECT id FROM learn_finding WHERE run_id=? ORDER BY id').all(runId).map(r => this.finding(r.id as string)!); }
  decide(id: string, reviewer: string, outcome: 'accepted' | 'rejected', now: number, receipt: Record<string, string | number>): void {
    this.transaction(() => {
      const changed = this.#db.prepare("UPDATE learn_finding SET state=? WHERE id=? AND state='pending'").run(outcome, id);
      if (Number(changed.changes) !== 1) throw Error('finding-not-pending');
      this.#db.prepare('INSERT INTO learn_decision VALUES(?,?,?,?,?)').run(id, reviewer, outcome, now, JSON.stringify(receipt));
    });
  }
  decisions(runId: string): { findingId: string; outcome: string; receipt: Record<string, string | number> }[] {
    return this.#db.prepare('SELECT d.* FROM learn_decision d JOIN learn_finding f ON f.id=d.finding_id WHERE f.run_id=?').all(runId).map(r => ({ findingId: r.finding_id as string, outcome: r.outcome as string, receipt: JSON.parse(r.receipt as string) as Record<string, string | number> }));
  }
}
