/** Team data and pending events. PT-4b alone will consume events and execute the action outbox. */
import type { DatabaseSync } from 'node:sqlite';
import { validateDefinition, type TeamRun, type TeamMember, type TeamPlanReport, type TeamPlanApproveParams, type TeamPolicy, type TeamPlan } from '@plur1bus/rpc-schema';
import { CollabError } from '../errors.ts';
import type { Project } from '../types.ts';
import type { RedactionPort } from '../ports.ts';
import { assertTeamPlan, scopePackages, teamHash } from './plan.ts';

type Row = Record<string, unknown>;
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
export const DEFAULT_TEAM_POLICY: TeamPolicy = { approval: { auto: false }, closedPaths: [], deployBranches: [] };

export class TeamStore {
  private readonly db: DatabaseSync;
  private readonly project: (id: string) => Project | null;
  private readonly now: () => number;
  private readonly id: (prefix: string) => string;
  private readonly redact: RedactionPort;
  private readonly policy: () => TeamPolicy;
  constructor(db: DatabaseSync, project: (id: string) => Project | null,
    now: () => number, id: (prefix: string) => string, redact: RedactionPort,
    policy: () => TeamPolicy = () => DEFAULT_TEAM_POLICY) {
    this.db = db; this.project = project; this.now = now; this.id = id; this.redact = redact; this.policy = policy;
  }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private row(id: string): Row {
    const row = this.db.prepare('SELECT * FROM team_runs WHERE id=?').get(id);
    if (!row) throw new CollabError('not-found', 'team not found', { reason: 'team-run' });
    return row;
  }
  private liveProject(id: string): Project {
    const project = this.project(id);
    if (!project || project.archivedAt !== null) throw new CollabError('not-found', 'active project required', { reason: 'team-project' });
    return project;
  }
  /** Project additions cannot remove deployment/path restrictions inherited from configuration. */
  private effectivePolicy(projectId: string): TeamPolicy {
    const base = this.policy(), local = this.liveProject(projectId).settings.collaboration?.teams;
    if (!validateDefinition('TeamPolicy', base).ok || (local && !validateDefinition('TeamPolicy', local).ok)) throw new CollabError('invalid', 'invalid team policy');
    return { approval: { auto: local?.approval.auto ?? base.approval.auto },
      closedPaths: [...new Set([...base.closedPaths, ...(local?.closedPaths ?? [])])],
      deployBranches: [...new Set([...base.deployBranches, ...(local?.deployBranches ?? [])])] };
  }
  private clean<T>(value: T): T {
    const visit = (v: unknown): unknown => typeof v === 'string' ? this.redact.text(v) : Array.isArray(v) ? v.map(visit)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)])) : v;
    return visit(value) as T;
  }
  private event(runId: string, type: string, data: unknown): void {
    const seq = Number(this.db.prepare('SELECT coalesce(max(seq),0)+1 AS n FROM team_events WHERE run_id=?').get(runId)!.n);
    this.db.prepare('INSERT INTO team_events VALUES(?,?,?,?,?,?)').run(runId, seq,
      JSON.stringify(this.clean({ type, data })), this.id('te'), 'pending', this.now());
    this.db.prepare('UPDATE team_runs SET state_version=state_version+1,updated_at=? WHERE id=?').run(this.now(), runId);
  }
  private invalidate(runId: string): void {
    this.db.prepare('UPDATE team_runs SET approval_json=NULL,approval_scope=NULL,approved_by=NULL,check_hash=NULL,check_json=NULL WHERE id=?').run(runId);
  }
  get(id: string): TeamRun {
    const r = this.row(id);
    const members = this.db.prepare('SELECT * FROM team_members WHERE run_id=? ORDER BY member_id').all(id).map(m => ({
      id: String(m.member_id), kind: m.kind, role: m.role, model: String(m.model), disclosure: parse(m.disclosure),
      ...(m.agent_id ? { agentId: String(m.agent_id) } : {}), ...(m.peer_id ? { peerId: String(m.peer_id) } : {}),
    })) as TeamMember[];
    return { id, projectId: String(r.project_id), leadAgent: String(r.lead_agent), objective: String(r.objective),
      mode: r.mode as TeamRun['mode'], cardId: r.card_id as string | null, state: r.state as TeamRun['state'], stateVersion: Number(r.state_version),
      plan: r.plan_json ? parse(r.plan_json) : null, planHash: r.plan_hash as string | null, compositionHash: String(r.composition_hash), members,
      checkHash: r.check_hash as string | null, report: r.check_json ? parse(r.check_json) : null, policy: parse(r.policy_json),
      approval: r.approval_json ? parse(r.approval_json) : null, targetBranch: String(r.target_branch),
      budget: { tokens: Number(r.token_budget), wallTimeMs: Number(r.wall_budget_ms) }, writersMax: Number(r.writers_max),
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
  }
  list(projectId: string, limit = 50, offset = 0): { runs: TeamRun[]; nextOffset: number | null } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new CollabError('invalid', 'invalid team page');
    const rows = this.db.prepare('SELECT id FROM team_runs WHERE project_id=? ORDER BY created_at,id LIMIT ? OFFSET ?').all(projectId, limit + 1, offset);
    return { runs: rows.slice(0, limit).map(r => this.get(String(r.id))), nextOffset: rows.length > limit ? offset + limit : null };
  }
  create(input: { projectId: string; leadAgent: string; objective: string; targetBranch?: string; mode?: 'team' | 'best-of-n'; cardId?: string }, by?: string): TeamRun {
    const project = this.liveProject(input.projectId);
    if (!project.agents.includes(input.leadAgent)) throw new CollabError('invalid', 'lead must belong to project', { reason: 'team-member' });
    if (Buffer.byteLength(input.objective, 'utf8') > 2000 || !input.objective.trim()) throw new CollabError('invalid', 'invalid objective');
    const policy = this.effectivePolicy(input.projectId);
    if (!validateDefinition('TeamPolicy', policy).ok) throw new CollabError('invalid', 'invalid team policy');
    return this.tx(() => {
      const id = this.id('team'), now = this.now();
      this.db.prepare(`INSERT INTO team_runs(id,project_id,lead_agent,mode,state,objective,card_id,composition_hash,policy_json,target_branch,
        token_budget,wall_budget_ms,writers_max,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, project.id, input.leadAgent, input.mode ?? 'team', 'proposing', this.redact.text(input.objective), input.cardId ?? null,
        teamHash([]), JSON.stringify(policy), input.targetBranch ?? project.repo?.baseBranch ?? 'main', 0, 0, 4, now, now);
      this.event(id, 'team.created', { by: by ?? project.owner });
      return this.get(id);
    });
  }
  confirm(runId: string, expectedHash: string, input: TeamMember[], by: string): TeamRun {
    return this.tx(() => {
      const run = this.get(runId), project = this.liveProject(run.projectId), members = this.clean(input).sort((a, b) => a.id.localeCompare(b.id));
      if (run.compositionHash !== expectedHash) throw new CollabError('conflict', 'composition changed', { reason: 'team-composition-stale' });
      if (!members.length || members.length > 64 || new Set(members.map(m => m.id)).size !== members.length || members.some(m => !validateDefinition('TeamMember', m).ok)) throw new CollabError('invalid', 'invalid composition');
      if (members.some(m => m.kind !== 'a2a' && (!m.agentId || !project.agents.includes(m.agentId)) || m.kind === 'a2a' && !m.peerId)) throw new CollabError('invalid', 'member is not bound to the project', { reason: 'team-member' });
      // Keep members referenced by package history; identity edits need a new draft plan first.
      const used = this.db.prepare('SELECT writer_member FROM team_packages WHERE run_id=?').all(runId);
      if (used.some(r => !members.some(m => m.id === r.writer_member))) throw new CollabError('conflict', 'member still assigned to a package');
      for (const m of members) this.db.prepare(`INSERT INTO team_members VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run_id,member_id) DO UPDATE SET
        kind=excluded.kind,role=excluded.role,model=excluded.model,agent_id=excluded.agent_id,peer_id=excluded.peer_id,disclosure=excluded.disclosure`).run(
        runId, m.id, m.kind, m.role, m.model, m.agentId ?? null, m.peerId ?? null, JSON.stringify(m.disclosure));
      for (const m of run.members) if (!members.some(next => next.id === m.id)) this.db.prepare('DELETE FROM team_members WHERE run_id=? AND member_id=?').run(runId, m.id);
      this.db.prepare("UPDATE team_runs SET composition_hash=?,state='planning' WHERE id=?").run(teamHash(members), runId);
      this.invalidate(runId); this.event(runId, 'team.composition.confirmed', { by, compositionHash: teamHash(members) });
      return this.get(runId);
    });
  }
  /** Trusted Core-only seam: PT-4b passes an already redacted plan and the native checker result. Never RPC input. */
  stagePlan(runId: string, input: unknown, report: TeamPlanReport): TeamRun {
    const plan = this.clean(input); assertTeamPlan(plan);
    if (!validateDefinition('TeamPlanReport', report).ok || report.planHash !== teamHash(plan)) throw new CollabError('conflict', 'checker result is not for this plan', { reason: 'team-check-stale' });
    return this.tx(() => {
      const run = this.get(runId); this.liveProject(run.projectId);
      if (plan.targetBranch !== run.targetBranch) throw new CollabError('conflict', 'target differs from run');
      if (plan.packages.some(p => !run.members.some(m => m.id === p.worker.member && m.kind === p.worker.kind && m.role === 'writer'))) throw new CollabError('invalid', 'unconfirmed writer');
      if (report.lanes.length !== plan.packages.length || new Set(report.lanes.map(l => l.package)).size !== plan.packages.length || report.lanes.some(l => !plan.packages.some(p => p.key === l.package))) throw new CollabError('invalid', 'incomplete checker lanes');
      if (this.db.prepare('SELECT 1 FROM team_actions WHERE run_id=? LIMIT 1').get(runId)) throw new CollabError('conflict', 'executed plan requires shell revision handling');
      for (const table of ['team_package_deps', 'team_ownership', 'team_rounds', 'team_merge_queue', 'team_packages', 'team_sections']) this.db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(runId);
      for (const [index, section] of plan.sections.entries()) this.db.prepare('INSERT INTO team_sections(run_id,id,section_index,title,goals_json,token_budget,wall_budget_ms) VALUES(?,?,?,?,?,?,?)')
        .run(runId, section.key, index, section.title, JSON.stringify(section.goals), section.budget.tokens, section.budget.wallTimeMs);
      for (const p of plan.packages) this.db.prepare(`INSERT INTO team_packages(run_id,id,section_id,key,task_class,writer_member,worker_kind,sync_mode,merge_position,token_alloc,wall_budget_ms,plan_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, p.key, p.section, p.key, p.taskClass, p.worker.member, p.worker.kind, p.sync,
        plan.sections.find(s => s.key === p.section)!.mergeOrder.indexOf(p.key), p.estimate.tokens, p.estimate.wallTimeMs, JSON.stringify(p));
      for (const p of plan.packages) {
        for (const dep of p.dependsOn) this.db.prepare('INSERT INTO team_package_deps VALUES(?,?,?,?,?,?)').run(runId, p.key, dep.package, dep.kind, JSON.stringify(dep.carries ?? []), dep.reason ?? null);
        for (const own of p.owns) this.db.prepare('INSERT INTO team_ownership VALUES(?,?,?,?,?)').run(runId, p.key, own.glob, own.mode, own.personReview ? 1 : 0);
      }
      const policy = this.effectivePolicy(run.projectId);
      if (!validateDefinition('TeamPolicy', policy).ok || report.policyHash !== teamHash(policy)) throw new CollabError('conflict', 'checker policy changed', { reason: 'team-check-stale' });
      this.invalidate(runId);
      this.db.prepare("UPDATE team_runs SET plan_json=?,plan_hash=?,check_json=?,check_hash=?,policy_json=?,state='awaiting-approval',token_budget=?,wall_budget_ms=? WHERE id=?").run(
        JSON.stringify(plan), teamHash(plan), JSON.stringify(this.clean(report)), teamHash({ report, compositionHash: run.compositionHash, policy }), JSON.stringify(policy),
        plan.sections.reduce((n, s) => n + s.budget.tokens, 0), plan.sections.reduce((n, s) => n + s.budget.wallTimeMs, 0), runId);
      this.event(runId, 'team.plan.proposed', { planHash: teamHash(plan) });
      return this.get(runId);
    });
  }
  approve(input: TeamPlanApproveParams, by: string, extend = false): TeamRun {
    return this.tx(() => {
      const run = this.get(input.runId); this.liveProject(run.projectId);
      if (!run.plan || !run.report || run.planHash !== input.planHash || run.checkHash !== input.checkHash || run.compositionHash !== input.compositionHash || teamHash(run.policy) !== teamHash(this.effectivePolicy(run.projectId))) throw new CollabError('conflict', 'approval facts changed', { reason: 'team-approval-stale' });
      if (run.report.findings.some(f => f.blocking)) throw new CollabError('conflict', 'plan has blocking findings', { reason: 'team-plan-blocked' });
      // Defense in depth: an absent executable check cannot be approved even if a malformed internal report missed it.
      if (run.plan.packages.some(p => p.taskClass.startsWith('code-') && !p.checks.some(c => c.kind === 'command' || c.kind === 'tests'))) throw new CollabError('conflict', 'coding package needs a check', { reason: 'team-plan-blocked' });
      if (!validateDefinition('TeamScope', input.scope).ok || !scopePackages(run.plan, input.scope).length || input.scope.kind === 'auto' && !run.policy.approval.auto) throw new CollabError('invalid', 'approval scope unavailable', { reason: 'team-scope' });
      if (extend && (!run.approval || scopePackages(run.plan, run.approval.scope).some(p => !scopePackages(run.plan!, input.scope).includes(p)) || run.approval.scope.kind === 'auto' && input.scope.kind !== 'auto')) throw new CollabError('conflict', 'scope extension cannot narrow approval');
      const approval = { planHash: input.planHash, checkHash: input.checkHash, compositionHash: input.compositionHash, policyHash: teamHash(run.policy), scope: input.scope, approvedBy: by, at: this.now() };
      this.db.prepare('UPDATE team_runs SET approval_json=?,approval_scope=?,approved_by=? WHERE id=?').run(JSON.stringify(approval), JSON.stringify(input.scope), by, run.id);
      this.event(run.id, extend ? 'team.scope.extended' : 'team.plan.approved', approval);
      return this.get(run.id);
    });
  }
  /** Store human commands for PT-4b; never start a worker, perform Git operations or fabricate completion. */
  request(runId: string, type: string, data: Record<string, unknown>, by: string): TeamRun {
    return this.tx(() => {
      const run = this.get(runId); this.liveProject(run.projectId);
      if (data.packageId && !run.plan?.packages.some(p => p.key === data.packageId)) throw new CollabError('not-found', 'team package not found');
      if (data.sectionId && !run.plan?.sections.some(s => s.key === data.sectionId)) throw new CollabError('not-found', 'team section not found');
      if (data.memberId && !run.members.some(m => m.id === data.memberId && m.role === 'writer')) throw new CollabError('invalid', 'unconfirmed writer');
      this.event(runId, type, { ...data, by });
      return this.get(runId);
    });
  }
  events(runId: string): { type: string; data: unknown }[] {
    return this.db.prepare('SELECT event_json FROM team_events WHERE run_id=? ORDER BY seq').all(runId).map(r => parse(r.event_json));
  }
  pendingActions(runId: string): unknown[] {
    return this.db.prepare("SELECT action_json FROM team_actions WHERE run_id=? AND state='pending' ORDER BY seq").all(runId).map(r => parse(r.action_json));
  }
}
