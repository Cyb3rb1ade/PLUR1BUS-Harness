import { mergeEvidence } from './aggregation.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { digest, targetHash, validateTarget } from './selection.ts';
import { PROMPT_VERSION, type Finding, type LearnRun, type Reason, type Target, type Window } from './types.ts';

export type DecisionSummary = Pick<Finding, 'id' | 'target' | 'kind' | 'desiredTier' | 'promptVersion' | 'models' | 'modelClasses'> & { hash: string };
const decisionSummary = (f: Finding): DecisionSummary => ({ id: f.id, target: f.target, kind: f.kind,
  desiredTier: f.desiredTier, promptVersion: f.promptVersion, models: f.models, modelClasses: f.modelClasses ?? [], hash: digest(f) });

/** Content is exclusively in learn_payload. Generic ledger projections never select that column. */
export class LearnStore {
  readonly #db: DatabaseSync;
  constructor(file: string, secure?: (path: string, options?: { mode?: number }) => unknown) {
    if (file !== ':memory:') { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); secure?.(dirname(file), { mode: 0o700 }); }
    this.#db = new DatabaseSync(file);
    try {
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const version = Number(this.#db.prepare('PRAGMA user_version').get()!.user_version);
      if (version > 3) throw Error('newer learn schema');
      if (!version) this.#db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE learn_run(id TEXT PRIMARY KEY, target_hash TEXT NOT NULL, window_from INTEGER NOT NULL, window_to INTEGER NOT NULL, metadata TEXT NOT NULL, UNIQUE(target_hash,window_from,window_to));
        CREATE TABLE learn_step(run_id TEXT NOT NULL REFERENCES learn_run(id), step TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(run_id,step));
        CREATE TABLE learn_payload(run_id TEXT NOT NULL REFERENCES learn_run(id), key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id,key));
        CREATE TABLE learn_finding(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES learn_run(id), state TEXT NOT NULL);
        CREATE TABLE learn_decision(finding_id TEXT PRIMARY KEY REFERENCES learn_finding(id), reviewer TEXT NOT NULL, outcome TEXT NOT NULL, decided_at INTEGER NOT NULL, receipt TEXT NOT NULL);
        PRAGMA user_version=1; COMMIT;`);
      if (version < 2) this.#db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE learn_run ADD COLUMN owner TEXT NOT NULL DEFAULT '';
        UPDATE learn_run SET owner=json_extract(metadata,'$.target.owner');
        CREATE INDEX learn_run_owner ON learn_run(owner,window_to DESC);
        CREATE INDEX learn_run_target ON learn_run(target_hash,window_to DESC);
        PRAGMA user_version=2; COMMIT;`);
      if (version < 3) this.transaction(() => {
        this.#db.exec(`ALTER TABLE learn_finding ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE learn_decision RENAME TO old_decision;
          CREATE TABLE learn_decision(finding_id TEXT NOT NULL REFERENCES learn_finding(id), revision INTEGER NOT NULL,
            reviewer TEXT NOT NULL, outcome TEXT NOT NULL, decided_at INTEGER NOT NULL, receipt TEXT NOT NULL,
            summary TEXT NOT NULL, PRIMARY KEY(finding_id,revision));
          CREATE TABLE learn_observation(run_id TEXT NOT NULL REFERENCES learn_run(id), finding_id TEXT NOT NULL REFERENCES learn_finding(id), PRIMARY KEY(run_id,finding_id));
          INSERT INTO learn_observation SELECT run_id,id FROM learn_finding;`);
        for (const r of this.#db.prepare('SELECT * FROM old_decision').all()) {
          const f = this.finding(r.finding_id as string);
          if (!f) throw Error('missing-learning-finding');
          this.#db.prepare('INSERT INTO learn_decision VALUES(?,?,?,?,?,?,?)').run(f.id, 1, r.reviewer!, r.outcome!, r.decided_at!, r.receipt!, JSON.stringify(decisionSummary(f)));
        }
        this.#db.exec('DROP TABLE old_decision; PRAGMA user_version=3;');
      });
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
    this.#db.prepare('INSERT INTO learn_run(id,target_hash,window_from,window_to,metadata,owner) VALUES(?,?,?,?,?,?)').run(run.id, hash, window.from, window.to, JSON.stringify(run), target.owner); return run;
  }
  get(id: string): LearnRun | null { const row = this.#db.prepare('SELECT metadata FROM learn_run WHERE id=?').get(id); return row ? JSON.parse(row.metadata as string) as LearnRun : null; }
  save(run: LearnRun): void { this.#db.prepare('UPDATE learn_run SET metadata=? WHERE id=?').run(JSON.stringify(run), run.id); }
  runs(owner: string, target?: Target): LearnRun[] {
    const rows = target
      ? this.#db.prepare('SELECT metadata FROM learn_run WHERE owner=? AND target_hash=? ORDER BY window_to DESC LIMIT 1000').all(owner, targetHash(target))
      : this.#db.prepare('SELECT metadata FROM learn_run WHERE owner=? ORDER BY window_to DESC LIMIT 1000').all(owner);
    return rows.map(r => JSON.parse(r.metadata as string) as LearnRun);
  }
  breakerOpen(target: Target, now: number): boolean {
    const start = Math.floor(now / 86_400_000) * 86_400_000;
    const row = this.#db.prepare(`SELECT count(*) AS n FROM learn_run WHERE owner=? AND target_hash=?
      AND json_extract(metadata,'$.startedAt')>=? AND json_extract(metadata,'$.outcome')='failed'`).get(target.owner, targetHash(target), start);
    return Number(row!.n) >= 3;
  }
  step(runId: string, step: string, state: 'started' | 'completed'): void { this.#db.prepare('INSERT INTO learn_step VALUES(?,?,?) ON CONFLICT(run_id,step) DO UPDATE SET state=excluded.state').run(runId, step, state); }
  payload<T>(runId: string, key: string): T | null { const row = this.#db.prepare('SELECT payload FROM learn_payload WHERE run_id=? AND key=?').get(runId, key); return row ? JSON.parse(row.payload as string) as T : null; }
  checkpoint(runId: string, key: string, value: unknown): void {
    this.transaction(() => { this.#db.prepare('INSERT INTO learn_payload VALUES(?,?,?) ON CONFLICT(run_id,key) DO UPDATE SET payload=excluded.payload').run(runId, key, JSON.stringify(value)); this.step(runId, key, 'completed'); });
  }
  finish(run: LearnRun, outcome: NonNullable<LearnRun['outcome']>, reason: Reason | null, now: number): void { run.outcome = outcome; run.reason = reason; run.finishedAt = now; this.save(run); }
  publish(run: LearnRun, findings: Finding[], now: number): void {
    this.transaction(() => {
      let published = 0;
      for (const input of findings) {
        const f = this.prepareCandidate(input);
        if (!f) continue;
        const old = this.finding(f.id);
        this.#db.prepare(`INSERT INTO learn_finding VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          run_id=excluded.run_id,state=excluded.state,revision=excluded.revision`).run(f.id, run.id, f.status, f.revision ?? 1);
        if (old) this.#db.prepare('DELETE FROM learn_payload WHERE run_id=? AND key=?').run(old.runId, `finding:${f.id}`);
        this.#db.prepare('INSERT OR REPLACE INTO learn_payload VALUES(?,?,?)').run(run.id, `finding:${f.id}`, JSON.stringify(f));
        this.#db.prepare('INSERT OR IGNORE INTO learn_observation VALUES(?,?)').run(run.id, f.id);
        published++;
      }
      run.findings = published; this.finish(run, 'completed', null, now);
    });
  }
  finding(id: string): Finding | null {
    const row = this.#db.prepare('SELECT run_id,state,revision FROM learn_finding WHERE id=?').get(id);
    if (!row) return null;
    const f = this.payload<Finding>(row.run_id as string, `finding:${id}`);
    return f ? { ...f, status: row.state as Finding['status'], revision: Number(row.revision) } : null;
  }
  findings(runId: string): Finding[] { return this.#db.prepare('SELECT finding_id AS id FROM learn_observation WHERE run_id=? ORDER BY finding_id').all(runId).map(r => this.finding(r.id as string)!); }
  decide(id: string, reviewer: string, outcome: 'accepted' | 'rejected', now: number, receipt: Record<string, string | number>): void {
    this.transaction(() => {
      const f = this.finding(id); if (!f) throw Error('finding-not-found');
      const changed = this.#db.prepare("UPDATE learn_finding SET state=? WHERE id=? AND state='pending'").run(outcome, id);
      if (Number(changed.changes) !== 1) throw Error('finding-not-pending');
      this.#db.prepare('INSERT INTO learn_decision VALUES(?,?,?,?,?,?,?)').run(id, f.revision ?? 1, reviewer, outcome, now, JSON.stringify(receipt), JSON.stringify(decisionSummary(f)));
    });
  }
  /** One most recent human decision per stable finding; earlier revisions remain auditable. */
  decidedFindings(owner: string): { finding: DecisionSummary; outcome: string }[] {
    return this.#db.prepare(`SELECT d.summary,d.outcome FROM learn_decision d
      JOIN learn_finding f ON f.id=d.finding_id JOIN learn_run r ON r.id=f.run_id
      WHERE r.owner=? AND d.revision=(SELECT max(n.revision) FROM learn_decision n WHERE n.finding_id=d.finding_id)`)
      .all(owner).map(r => ({ finding: JSON.parse(r.summary as string) as DecisionSummary, outcome: r.outcome as string }));
  }
  targetFindings(target: Target): Finding[] {
    return this.#db.prepare(`SELECT f.id FROM learn_finding f JOIN learn_run r ON r.id=f.run_id
      WHERE r.owner=? AND r.target_hash=? ORDER BY r.window_to DESC,f.id LIMIT 100`)
      .all(target.owner, targetHash(target)).map(r => this.finding(r.id as string)!);
  }
  prepareCandidate(next: Finding): Finding | null {
    const old = this.finding(next.id);
    if (!old) return next;
    if (targetHash(old.target) !== targetHash(next.target)) throw Error('finding-target-mismatch');
    if (old.status === 'accepted') return null;
    if (old.status === 'rejected') {
      const latestDay = old.evidence.map(e => e.day).sort().at(-1) ?? '';
      const oldRefs = new Set(old.evidence.map(e => digest([e.sessionId, e.source, e.sourceId])));
      if (!next.evidence.some(e => e.day > latestDay && !oldRefs.has(digest([e.sessionId, e.source, e.sourceId])))) return null;
      const row = this.#db.prepare('SELECT * FROM learn_decision WHERE finding_id=? ORDER BY revision DESC LIMIT 1').get(old.id)!;
      return { ...mergeEvidence(old, next), revision: (old.revision ?? 1) + 1, previousDecision: {
        revision: Number(row.revision), outcome: String(row.outcome), at: Number(row.decided_at),
        hash: (JSON.parse(row.summary as string) as DecisionSummary).hash,
      } };
    }
    return { ...mergeEvidence(old, next), revision: old.revision ?? 1, ...(old.previousDecision ? { previousDecision: old.previousDecision } : {}) };
  }
  decisions(runId: string): { findingId: string; outcome: string; receipt: Record<string, string | number> }[] {
    return this.#db.prepare('SELECT d.* FROM learn_decision d JOIN learn_finding f ON f.id=d.finding_id WHERE f.run_id=?').all(runId).map(r => ({ findingId: r.finding_id as string, outcome: r.outcome as string, receipt: JSON.parse(r.receipt as string) as Record<string, string | number> }));
  }
}
