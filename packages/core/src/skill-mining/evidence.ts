import { DatabaseSync } from 'node:sqlite';
import type { MiningScope, ExecutionProof } from './miner.ts';
export interface WorkflowExecution { owner: string; agentId: string; sessionId: string; turnId: string; callId: string; tool: string; version: string; success: boolean }
/** Only composition's dispatcher result writer owns this ledger. No args, results, descriptions or session text. */
export class WorkflowEvidence implements ExecutionProof {
  readonly #db: DatabaseSync;
  constructor(path: string) { this.#db = new DatabaseSync(path); this.#db.exec('CREATE TABLE IF NOT EXISTS mining_executions(owner TEXT NOT NULL, agent TEXT NOT NULL, session TEXT NOT NULL, turn TEXT NOT NULL, call TEXT NOT NULL, tool TEXT NOT NULL, version TEXT NOT NULL, success INTEGER NOT NULL, PRIMARY KEY(session,turn,call))'); }
  record(e: WorkflowExecution): void { this.#db.prepare('INSERT OR REPLACE INTO mining_executions(owner,agent,session,turn,call,tool,version,success) VALUES(?,?,?,?,?,?,?,?)').run(e.owner, e.agentId, e.sessionId, e.turnId, e.callId, e.tool, e.version, e.success ? 1 : 0); }
  verified(scope: MiningScope, sessionId: string, turnId: string, callId: string, tool: string, version: string): boolean {
    return this.#db.prepare('SELECT success FROM mining_executions WHERE owner=? AND agent=? AND session=? AND turn=? AND call=? AND tool=? AND version=?').get(scope.owner, scope.agentId, sessionId, turnId, callId, tool, version)?.['success'] === 1;
  }
  close(): void { this.#db.close(); }
}
