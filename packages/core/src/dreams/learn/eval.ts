import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_COLLAB_SETTINGS } from '../../collab/defaults.ts';
import { defaults } from '@plur1bus/config-schema';
import { SessionStore } from '../../session/store.ts';
import { createIdentityService } from '../../identity/service.ts';
import { deriveUserPrincipal } from '../../identity/principals.ts';
import { learningToolMetadata } from '../../tools/learning-metadata.ts';
import { LearnService } from './service.ts';
import { LearnStore } from './store.ts';
import { learningSource } from './source.ts';
import type { LearnModel } from './model.ts';
import type { Change, LearnScope, Tier, Verdict } from './types.ts';
export interface LearnEvalCase {
  id: string; scope: LearnScope; source: 'person' | 'assistant' | 'tool' | 'direct-channel' | 'group' | 'unknown-channel';
  sessions: number; sameDay: boolean; text: string; key: string; kind: 'knowledge' | 'procedural'; change: Change;
  skeptic: Verdict; paraphrases?: string[]; verify?: 'supported' | 'contradicted' | 'trivial'; card?: string; oldTurns?: number;
  expected: { clusters: string[]; zero: boolean; tier: Tier; skeptic: Verdict };
}
const DAY = 86400000, marker = 'LEARN_EVAL_PRIVATE_MARKER';
/** Synthetic fixture sources, real selection/extraction/aggregation/review/tier pipeline. */
export async function evaluateLearning(cases: readonly LearnEvalCase[], model?: LearnModel) {
  const results: { id: string; passed: boolean; predicted: number; expected: number; matched: number; skepticChecks: number; skepticMatches: number; tokens: number; unmeasuredCalls: number; contentFree: boolean }[] = [];
  for (const c of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'learn-eval-'));
    let now = DAY, extracts = 0, measuredTokens = 0, unmeasuredCalls = 0;
    const identity = createIdentityService({ dbPath: join(dir, 'identity.db'), clock: () => DAY, audit: () => {} });
    const actor = { user: 'owner', host: 'fixture', role: 'owner' as const, kind: 'person' as const };
    const human = identity.createHuman({ displayName: 'Synthetic Eval Person' }, actor);
    identity.link({ humanId: human.id, identity: { channel: 'telegram', accountId: 'bot', userId: 'sender' } }, actor);
    const person = { userId: human.id, role: 'owner' as const, kind: 'person' as const };
    const sessions = new SessionStore({ path: ':memory:', clock: () => now }), store = new LearnStore(':memory:');
    const target = { scope: c.scope, owner: person.userId, agentId: 'alpha', ...(c.scope === 'project' ? { projectId: 'project' } : {}) };
    const config = defaults(); config.dreams = { learn: { agents: { alpha: { owner: person.userId, enabled: true } }, projects: { project: { owner: person.userId, agentId: 'alpha', enabled: true } }, installation: { owner: person.userId, agentId: 'alpha', enabled: true } } };
    const project = { id: 'project', name: 'Synthetic', settings: DEFAULT_COLLAB_SETTINGS, owner: person.userId, members: [], agents: ['alpha', 'beta'], archivedAt: null, createdAt: 0, updatedAt: 0 };
    for (let i = 0; i < c.sessions; i++) {
      const channel = ['direct-channel', 'group', 'unknown-channel'].includes(c.source), chatId = `chat-${i}`;
      const s = sessions.createSession({ kind: channel ? 'channel' : 'direct', agentId: c.scope === 'project' && i % 2 ? 'beta' : 'alpha', owner: deriveUserPrincipal(person.userId), scope: c.scope === 'project' ? 'project' : '', ...(channel ? { chatKey: `telegram:${chatId}` } : {}) });
      if (i === 0) for (let n = 0; n < (c.oldTurns ?? 0); n++) { now = DAY; const { turn } = sessions.beginTurn(s.id, 'Old synthetic context', 1); sessions.completeTurn(turn.id, { text: 'Old reply', tokens: 1 }); }
      now = (10 + (c.sameDay ? 0 : i)) * DAY;
      const text = `${c.paraphrases?.[i] ?? c.text} ${marker}`;
      const { turn } = sessions.beginTurn(s.id, text, 10, channel && c.source !== 'unknown-channel' ? { channelOrigin: { channel: 'telegram', accountId: 'bot', chatId, senderId: 'sender', humanId: person.userId, chatKind: c.source === 'group' ? 'group' : 'direct' } } : {});
      if (c.source === 'tool') sessions.appendEvent(turn.id, 'tool.result', { output: text, learnTool: learningToolMetadata({ callId: 'call', tool: 'file.read', isError: true, error: { code: 'tool-timeout', message: text }, provenance: { origin: { system: 'harness:tools', trust: 'untrusted', agent: 'alpha', principal: 'owner' }, hops: 0, transformedBy: [] }, meta: { decision: 'allow', durationMs: 1, bytes: 1 } }, { path: text }, true) });
      sessions.completeTurn(turn.id, { text, tokens: 10 });
    }
    now = 14 * DAY;
    const source = learningSource(sessions, { config: () => config, hasAgent: () => true, project: () => project, identity: () => identity });
    const notices: unknown[] = [];
    const fake: LearnModel = { async complete(req) {
      const data = JSON.parse(req.data).data;
      let text: string;
      if (req.stage === 'extract') {
        const message = data.messages.find((m: { role: string }) => m.role === (c.source === 'assistant' ? 'assistant' : 'user'));
        const event = data.events.find((e: { type: string }) => e.type === 'tool.result');
        text = JSON.stringify([{ kind: c.kind, change: c.change, contentKey: c.key, text: c.paraphrases?.[extracts++ % c.sessions] ?? c.text,
          ...(c.card ? { memoryId: 'synthetic-card' } : {}), ...(c.verify ? { checks: [{ path: 'go.mod', contains: c.verify === 'trivial' ? 'x' : c.text }] } : {}),
          evidence: [{ source: c.source === 'tool' ? 'event' : 'message', id: c.source === 'tool' ? String(event.seq) : message.id }] }]);
      } else text = req.stage === 'skeptic' ? JSON.stringify({ verdict: c.skeptic }) : JSON.stringify({ text: data.text });
      return { text, model: `fixture/${req.modelClass}`, inputTokens: 100, outputTokens: 100 };
    } };
    const service = new LearnService({ store, source, config: () => config, now: () => now, principal: () => person, mayReadTarget: () => true,
      signal: new AbortController().signal, model: { async complete(request) {
        try { const result = await (model ?? fake).complete(request); measuredTokens += result.inputTokens + result.outputTokens; return result; }
        catch (error) { unmeasuredCalls++; throw error; }
      } }, inbox: { publish: n => { notices.push(n); }, settle: () => {} },
      readPort: async () => c.verify ? { async call(name) { if (name !== 'file.read') throw Error('unexpected tool'); return { ok: true, text: c.verify === 'contradicted' ? 'Other language' : c.verify === 'trivial' ? 'x' : c.text }; } } : null,
      card: async () => c.card ? { text: c.text, origin: c.card, scope: c.scope === 'project' ? 'workspace' : 'agent-private' } : null });
    try {
      const run = await service.run(target, person, new AbortController().signal), findings = store.findings(run.id);
      const keys = findings.map(f => f.toolPattern ? `${f.toolPattern.tool}:${f.toolPattern.errorClass}` : f.contentKey ?? '');
      const matched = keys.filter(k => c.expected.clusters.includes(k)).length;
      const contentFree = !JSON.stringify({ run: store.get(run.id), notices }).includes(marker);
      const passed = run.outcome === 'completed' && contentFree && matched === c.expected.clusters.length && matched === keys.length && findings.every(f => (f.score === 0) === c.expected.zero && f.desiredTier === c.expected.tier && f.skeptic === c.expected.skeptic);
      results.push({ id: c.id, passed, predicted: keys.length, expected: c.expected.clusters.length, matched,
        skepticChecks: findings.length, skepticMatches: findings.filter(f => f.skeptic === c.expected.skeptic).length, tokens: measuredTokens, unmeasuredCalls, contentFree });
    } finally { await service.close(); sessions.close(); identity.close(); rmSync(dir, { recursive: true, force: true }); }
  }
  const sum = (key: 'matched' | 'predicted' | 'expected' | 'skepticChecks' | 'skepticMatches' | 'tokens' | 'unmeasuredCalls') => results.reduce((n, r) => n + r[key], 0);
  return { schema: 'plur1bus.learn-eval/1', evidence: model ? 'live' : 'fixture', results,
    extractionPrecision: sum('predicted') ? sum('matched') / sum('predicted') : null, extractionRecall: sum('expected') ? sum('matched') / sum('expected') : null,
    skepticAgreement: sum('skepticChecks') ? sum('skepticMatches') / sum('skepticChecks') : null, tokens: sum('tokens'), unmeasuredCalls: sum('unmeasuredCalls') };
}
