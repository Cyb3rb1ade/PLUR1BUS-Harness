import type { DatabaseSync } from 'node:sqlite';
import type { Finding, LearnRun } from './types.ts';
import { contentKey } from './aggregation.ts';
import { digest } from './selection.ts';
export interface Prediction { direction: 'rarer'; signalHash: string; acceptedAt: number; notBefore: number; sessions: number; recurrences: number; status: 'confirmed' | 'not-confirmed' | 'insufficient-data'; retireProposed: boolean }
export interface LearningObservation { sessionId: string; at: number; signals: { findingId: string; at: number }[] }
export function startPrediction(db: DatabaseSync, f: Finding, now: number): void {
  if (f.kind !== 'knowledge') return;
  db.prepare('INSERT OR IGNORE INTO learn_prediction VALUES(?,?,?,?,?,?,?)').run(f.id, f.revision ?? 1, now, now + 14 * 86400000, digest(contentKey(f)), 'insufficient-data', null);
}
export function prediction(db: DatabaseSync, id: string, revision: number): Prediction | null {
  const row = db.prepare('SELECT * FROM learn_prediction WHERE finding_id=? AND revision=?').get(id, revision); if (!row) return null;
  const counts = db.prepare('SELECT count(*) AS sessions,coalesce(sum(recurred),0) AS recurrences FROM learn_prediction_session WHERE finding_id=? AND revision=?').get(id, revision)!;
  return { direction: 'rarer', signalHash: String(row.signal_hash), acceptedAt: Number(row.accepted_at), notBefore: Number(row.not_before), sessions: Number(counts.sessions), recurrences: Number(counts.recurrences), status: row.status as Prediction['status'], retireProposed: row.status === 'not-confirmed' };
}
/** Only completed, uncapped windows establish observation coverage. No MemoryOps exist here. */
export function observePredictions(db: DatabaseSync, run: LearnRun, observations: LearningObservation[]): void {
  if (run.outcome !== 'completed' || run.truncated) return;
  const rows = db.prepare(`SELECT p.* FROM learn_prediction p JOIN learn_finding f ON f.id=p.finding_id
    JOIN learn_run r ON r.id=f.run_id WHERE r.target_hash=(SELECT target_hash FROM learn_run WHERE id=?)
    AND f.state='accepted' AND f.revision=p.revision AND p.closed_at IS NULL`).all(run.id);
  for (const p of rows) {
    const id = String(p.finding_id), revision = Number(p.revision), accepted = Number(p.accepted_at);
    if (run.window.to <= accepted) continue;
    for (const o of observations) {
      if (o.at <= accepted) continue;
      const recurred = o.signals.some(s => s.findingId === id && s.at > accepted);
      db.prepare(`INSERT INTO learn_prediction_session VALUES(?,?,?,?,?) ON CONFLICT(finding_id,revision,session_id)
        DO UPDATE SET at=max(at,excluded.at),recurred=max(recurred,excluded.recurred)`).run(id, revision, o.sessionId, o.at, +recurred);
    }
    db.prepare('INSERT OR IGNORE INTO learn_prediction_coverage VALUES(?,?,?,?)').run(id, revision, Math.max(accepted, run.window.from), run.window.to);
    let coveredThrough = accepted;
    for (const interval of db.prepare('SELECT start,end FROM learn_prediction_coverage WHERE finding_id=? AND revision=? ORDER BY start,end').all(id, revision)) {
      if (Number(interval.start) > coveredThrough) break;
      coveredThrough = Math.max(coveredThrough, Number(interval.end));
    }
    const current = prediction(db, id, revision)!;
    if (current.sessions >= 10 && coveredThrough >= Number(p.not_before)) {
      db.prepare('UPDATE learn_prediction SET status=?,closed_at=? WHERE finding_id=? AND revision=?').run(current.recurrences ? 'not-confirmed' : 'confirmed', coveredThrough, id, revision);
    }
  }
}
