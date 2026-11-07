import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from '../../../rpc-schema/fixtures/team/plan.json' with { type: 'json' };
import { CollabStore } from '../../src/collab/store.ts';
import { DEFAULT_TEAM_POLICY } from '../../src/collab/team/store.ts';
import { teamHash } from '../../src/collab/team/plan.ts';
import { MIGRATIONS, migrate } from '../../src/collab/migrations.ts';

import type { TeamMember } from '@plur1bus/rpc-schema';
const members: TeamMember[] = [{ id: 'writer', kind: 'native' as const, role: 'writer' as const, model: 'fixture', agentId: 'writer', disclosure: [] }];
test('TK1 re-confirmation cannot change records once execution has an outbox action', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-confirm-'));
  const path = join(dir, 'collab.sqlite');
  const store = new CollabStore({ path });
  const db = new DatabaseSync(path);
  try {
    const project = store.createProject({ name: 'team', owner: 'person' });
    store.addAgent(project.id, 'writer');
    let run = store.team.create({ projectId: project.id, leadAgent: 'writer', objective: 'fixture', targetBranch: 'integration' });
    run = store.team.confirm(run.id, run.compositionHash, members, 'person');
    run = store.team.stagePlan(run.id, fixture, { policyHash: teamHash(DEFAULT_TEAM_POLICY), planHash: teamHash(fixture), findings: [],
      lanes: [{ package: 'duration', lane: 'contained', reasons: [] }], overlapScore: 0, criticalPathMs: 10000 });
    store.team.approve({ runId: run.id, planHash: run.planHash!, checkHash: run.checkHash!, compositionHash: run.compositionHash, scope: { kind: 'plan' } }, 'person');
    db.prepare("UPDATE team_runs SET state='running' WHERE id=?").run(run.id);
    db.prepare("INSERT INTO team_actions VALUES(?,1,?,?,'pending',0,0)").run(run.id, JSON.stringify({ kind: 'create-worktree', package: 'duration' }), 'fixture-action');
    const snapshot = () => ['team_runs', 'team_members', 'team_events', 'team_actions', 'team_packages', 'team_sections']
      .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    for (const state of ['pending', 'applied', 'done', 'failed']) {
      db.prepare('UPDATE team_actions SET state=? WHERE run_id=?').run(state, run.id);
      const before = snapshot();
      assert.throws(() => store.team.confirm(run.id, run.compositionHash, [{ ...members[0]!, model: 'other' }], 'person'), { code: 'conflict' });
      assert.deepEqual(snapshot(), before, `no writes with ${state} execution history`);
    }
  } finally { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('TK1 team records round trip with redaction, bound approvals and an empty action outbox', () => {
  const store = new CollabStore({ path: ':memory:', redact: { text: s => s.replaceAll('private marker', '[redacted]'), value: v => v } });
  try {
    const project = store.createProject({ name: 'team', owner: 'person' });
    store.addAgent(project.id, 'writer');
    let run = store.team.create({ projectId: project.id, leadAgent: 'writer', objective: 'private marker', targetBranch: 'integration' });
    assert.equal(run.objective, '[redacted]');
    assert.equal(store.team.list(project.id, 1, 0).runs[0]?.id, run.id);
    run = store.team.confirm(run.id, run.compositionHash, members, 'person');
    const report = { policyHash: teamHash(DEFAULT_TEAM_POLICY), planHash: teamHash(fixture), findings: [], lanes: [{ package: 'duration', lane: 'contained' as const, reasons: [] }], overlapScore: 0, criticalPathMs: 10000 };
    run = store.team.stagePlan(run.id, fixture, report);
    const approval = { runId: run.id, planHash: run.planHash!, checkHash: run.checkHash!, compositionHash: run.compositionHash, scope: { kind: 'plan' as const } };
    assert.throws(() => store.team.approve({ ...approval, checkHash: '0'.repeat(64) }, 'person'));
    run = store.team.approve(approval, 'person');
    assert.equal(run.approval?.approvedBy, 'person');
    assert.equal(run.approval?.checkHash, approval.checkHash);
    assert.ok(store.team.events(run.id).some(e => e.type === 'team.plan.approved'));
    assert.deepEqual(store.team.pendingActions(run.id), []);
    run = store.team.confirm(run.id, run.compositionHash, [{ ...members[0]!, model: 'other' }], 'person');
    assert.equal(run.approval, null);
    assert.equal(run.checkHash, null);
    assert.throws(() => store.team.approve(approval, 'person'));
  } finally { store.close(); }
});

test('TK1 migration retains old memberships and permits worker/reviewer without granting lead', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db, MIGRATIONS.slice(0, 8));
    db.exec("INSERT INTO projects(id,name,owner,settings,created_at,updated_at) VALUES('p','p','person','{}',0,0); INSERT INTO project_members VALUES('p','person','lead',0)");
    migrate(db);
    db.exec("INSERT INTO project_members VALUES('p','worker','worker',0),('p','reviewer','reviewer',0)");
    assert.deepEqual(db.prepare('SELECT role FROM project_members ORDER BY user_id').all().map(r => r.role), ['lead','reviewer','worker']);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 9);
  } finally { db.close(); }
});

test('TK1 approval rejects absent executable checks, blockers, stale facts and disabled auto without mutating records', () => {
  const policy = structuredClone(DEFAULT_TEAM_POLICY);
  const store = new CollabStore({ path: ':memory:', teamPolicy: () => policy });
  try {
    const project = store.createProject({ name: 'team', owner: 'person' }); store.addAgent(project.id, 'writer');
    let run = store.team.create({ projectId: project.id, leadAgent: 'writer', objective: 'fixture', targetBranch: 'integration' });
    run = store.team.confirm(run.id, run.compositionHash, members, 'person');
    const stage = (plan: unknown, blocking = false) => store.team.stagePlan(run.id, plan, {
      policyHash: teamHash(policy), planHash: teamHash(plan), findings: blocking ? [{ kind: 'false-edge', package: 'duration', detail: 'fixture', blocking: true }] : [],
      lanes: [{ package: 'duration', lane: 'contained', reasons: [] }], overlapScore: 0, criticalPathMs: 10000,
    });
    const approve = () => ({ runId: run.id, planHash: run.planHash!, checkHash: run.checkHash!, compositionHash: run.compositionHash, scope: { kind: 'plan' as const } });
    for (const checks of [[], [{ kind: 'paths', paths: ['src/duration.ts'], criterion: 0 }]]) {
      const plan = structuredClone(fixture); Object.assign(plan.packages[0]!, { checks }); run = stage(plan);
      assert.throws(() => store.team.approve(approve(), 'person')); assert.equal(store.team.get(run.id).approval, null);
    }
    run = stage(fixture, true); assert.throws(() => store.team.approve(approve(), 'person'));
    run = stage(fixture);
    for (const key of ['planHash', 'checkHash', 'compositionHash']) assert.throws(() => store.team.approve({ ...approve(), [key]: '0'.repeat(64) }, 'person'));
    assert.throws(() => store.team.approve({ ...approve(), scope: { kind: 'auto' } }, 'person'));
    assert.throws(() => store.team.approve({ ...approve(), scope: { kind: 'section', through: 'missing' } }, 'person'));
    policy.closedPaths.push('src/**'); assert.throws(() => store.team.approve(approve(), 'person'));
    run = stage(fixture); run = store.team.approve(approve(), 'person'); assert.ok(run.approval);
    const events = store.team.events(run.id).length;
    assert.throws(() => store.team.request(run.id, 'team.package.reassign.requested', { packageId: 'missing', memberId: 'writer' }, 'person'));
    assert.equal(store.team.events(run.id).length, events);
  } finally { store.close(); }
});

test('TK1 project restrictions are additive and changing project policy invalidates a checker result', () => {
  const store = new CollabStore({ path: ':memory:', teamPolicy: () => ({ ...DEFAULT_TEAM_POLICY, closedPaths: ['secrets/**'], deployBranches: ['production'] }) });
  try {
    const project = store.createProject({ name: 'team', owner: 'person', settings: { collaboration: { teams: { approval: { auto: false }, closedPaths: ['private/**'], deployBranches: ['release'] } } } });
    store.addAgent(project.id, 'writer');
    const run = store.team.create({ projectId: project.id, leadAgent: 'writer', objective: 'fixture' });
    assert.deepEqual(run.policy.closedPaths, ['secrets/**', 'private/**']);
    assert.deepEqual(run.policy.deployBranches, ['production', 'release']);
  } finally { store.close(); }
});
