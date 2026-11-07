export interface LearnTarget { scope: 'agent' | 'project' | 'installation'; agentId: string; projectId?: string }
export interface LearnRow {
  id: string; kind: 'knowledge' | 'procedural'; change: 'add' | 'correct' | 'duplicate' | 'stale' | 'retire';
  status: 'pending' | 'accepted' | 'rejected' | 'waiting-h3' | 'withdrawn'; score: number; desiredTier: 'A' | 'B' | 'C';
  skeptic: 'holds' | 'refuted' | 'insufficient' | 'not-required'; revision: number;
  prevalence: { sessions: number; total: number; days: number; agents: number; persons: number };
}
export interface LearnDetail { finding: LearnRow & { text: string; verify: string; toolPattern?: { tool: string; errorClass: string; count: number; affectedAgents: string[]; shape: Record<string, number | boolean> }; previousDecision?: { outcome: string; at: number } };
  prediction?: { status: 'confirmed' | 'not-confirmed' | 'insufficient-data'; sessions: number; recurrences: number; retireProposed: boolean } | null;
  contentHash: string; evidence: { ref: { sessionId: string; turnId: string; sourceId: string; trust: string; day: string }; excerpt: string }[];
  action: { state: string; receipt: Record<string, string | number> } | null }
export interface LearnPrecision { accepted: number; decided: number; precision: number | null; allowed: false; reason: 'shadow-incomplete' | 'precision-below-gate' | 'revert-unavailable' }
declare module '../../api/index.ts' {
  interface RpcMethods {
    'dreams.learn.run': { params: LearnTarget; result: { run: { id: string; outcome: string | null; reason: string | null } } };
    'dreams.learn.status': { params: LearnTarget; result: { status: { enabled: boolean; lastRun: { startedAt: number; outcome: string | null; reason: string | null } | null; nextRunAt: number | null; breakerOpen: boolean } } };
    'dreams.learn.list': { params: LearnTarget & { offset?: number }; result: { items: LearnRow[]; nextOffset?: number | null } };
    'dreams.learn.get': { params: { id: string }; result: LearnDetail };
    'dreams.learn.decide': { params: { id: string; contentHash: string; outcome: 'accepted' | 'rejected'; staleAction?: 'correct' | 'forget' }; result: { status: string; receipt?: Record<string, string | number> } };
    'dreams.learn.rollback': { params: { id: string }; result: { result: Record<string, unknown> } };
    'dreams.learn.calibration': { params: LearnTarget; result: { record: { A: LearnPrecision; B: LearnPrecision; predictions?: { confirmationRate: number | null } } } };
  }
}
