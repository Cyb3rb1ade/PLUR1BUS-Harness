import { randomUUID } from 'node:crypto';
import { downloadModel, isInstalled, licenceKey, modelSizeBytes, modelsFor, needsLicenceConfirmation, type CatalogModel, type AudioChunk } from '../../../voice-providers/src/index.ts';
import type { VoiceFeatures, VoiceOverride, VoiceRealtimeProfile, VoiceRealtimeProfileInput, VoiceModel, VoiceMetrics as MetricsResult } from '@plur1bus/rpc-schema';
import { voiceBudgetFailure, VOICE_V3_FEATURES, type HarnessConfig } from '@plur1bus/config-schema';
import type { Handler, CallContext, NotifyOptions } from '../rpc/server.ts';
import { RpcError } from '../rpc/errors.ts';
import type { PrincipalResolver } from '../rbac/guard.ts';
import type { Principal } from '../rbac/types.ts';
import type { VoiceChannel, VoiceClient, OpenVoice } from './v2.ts';
import { validateVoiceSetupSelection } from '../setup/model.ts';
import { voiceV3Catalog } from './v3-catalog.ts';

export const VOICE_FEATURES = VOICE_V3_FEATURES;
export interface VoiceV3Deps {
  config(): HarnessConfig;
  confirmLicence?: (who: string, model: CatalogModel) => void;
  set(changes: { key: string; value: unknown }[]): Promise<void> | null;
  modelsDir: string; resolve: PrincipalResolver; hasAgent(id: string): boolean;
  notify(method: string, params: object, options: NotifyOptions): void;
  openTalk(request: OpenVoice, client: VoiceClient): Promise<VoiceChannel>;
  /** PCM transport is supplied only by a trusted host adapter, never by request params. */
  audio?: { receive(connectionId: string, sessionId: string, chunk: AudioChunk): Promise<void>; stop(connectionId: string, sessionId: string): void };
  session(id: string): { agentId: string; owner: string; archivedAt: number | null } | undefined;
  signal: AbortSignal; clock(): number;
  metrics(): MetricsResult;
  fetch?: import('../../../voice-providers/src/http.ts').FetchLike;
  install?: typeof downloadModel; installed?: typeof isInstalled;
}
/** Stable feature order identifies the first switch that would overflow the synchronous budget. */
export function validateVoiceBudget(features: VoiceFeatures, budgetMs: number): void {
  for (const name of VOICE_FEATURES) if (name !== 'toolSchemas' && features[name].mode === 'reduced') throw new RpcError('E_INVALID_PARAMS', 'Only toolSchemas supports reduced mode', { detail: name });
  const overflow = voiceBudgetFailure(features, budgetMs);
  if (overflow) throw new RpcError('E_VOICE_BUDGET', `Voice feature ${overflow.feature} exceeds the ${budgetMs} ms budget`, { reason: 'latency-budget', detail: overflow.feature, ids: { feature: overflow.feature, totalMs: String(overflow.totalMs), budgetMs: String(budgetMs) } });
}
export function createVoiceV3(d: VoiceV3Deps) {
  const catalog = voiceV3Catalog(d.config().voice.local.catalogOverride, d.config().voice.v3.profiles);
  const languageKey = (language: string): 'de' | 'en' => { if (language !== 'de' && language !== 'en') throw new RpcError('E_INVALID_PARAMS', 'Unsupported voice language', { detail: 'language' }); return language; };
  const sessions = new Map<string, { connection: string; person: string; agentId: string; channel?: VoiceChannel; closed: boolean; opening?: Promise<void> }>();
  let mutation: Promise<unknown> = Promise.resolve();
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const operations = new AbortController();
  const signal = AbortSignal.any([d.signal, operations.signal]);
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const work = mutation.then(() => { if (closed || signal.aborted) throw new RpcError('E_VOICE_UNAVAILABLE', 'Voice is closed'); return fn(); });
    mutation = work.catch(() => {}); return work;
  };
  const save = async (changes: { key: string; value: unknown }[]) => {
    const work = d.set(changes);
    if (!work) throw new RpcError('E_NOT_AVAILABLE', 'A running supervisor is required to save voice settings', { reason: 'no-supervisor' });
    await work;
  };
  const requireAgent = (id: string) => { if (!d.hasAgent(id)) throw new RpcError('E_AGENT_UNKNOWN', 'Unknown agent', { ids: { agentId: id } }); };
  const authorize = async (ctx: CallContext, method: string, params: unknown, write: boolean): Promise<Principal> => {
    let p: Principal | null | undefined;
    try { p = await d.resolve(ctx, method, params); } catch { /* fail closed */ }
    if (!p?.userId || !['owner','admin','operator','member','viewer'].includes(p.role)) throw new RpcError('E_UNAUTHORIZED', 'Authentication required');
    const agentId = (params as { agentId?: string } | undefined)?.agentId;
    const ownOverride = method === 'voice.agent.override.get' && agentId === p.userId;
    if (p.kind !== 'person' && !(p.kind === 'agent' && ownOverride)) throw new RpcError('E_DENIED', 'Agents may read only their own voice override');
    if (write && (p.kind !== 'person' || !['owner','admin'].includes(p.role))) throw new RpcError('E_DENIED', 'Voice writes require Owner/Admin');
    const action = ownOverride ? 'voice.override.read' : write ? 'voice.write' : 'voice.read';
    if (p.tokenScopes && !p.tokenScopes.some(s => s === action || s === 'voice.*' || s === '*')) throw new RpcError('E_DENIED', 'Voice token scope denied');
    return p;
  };
  const config = () => d.config().voice.v3;
  const override = (id?: string): VoiceOverride | null => {
    if (!id) return null; requireAgent(id);
    const o = d.config().agents[id]?.voice;
    return o && Object.keys(o).length ? structuredClone(o) : null;
  };
  const effectiveInput = (id?: string): VoiceRealtimeProfileInput => {
    const base = structuredClone(config().realtime), o = override(id);
    return { ...base, ...(o?.enabled !== undefined ? { enabled: o.enabled } : {}), ...(o?.endpointingMs !== undefined ? { endpointingMs: o.endpointingMs } : {}), ...(o?.speculative !== undefined ? { speculative: o.speculative } : {}), ...(o?.ackSound !== undefined ? { ackSound: o.ackSound } : {}), features: Object.fromEntries(VOICE_FEATURES.map(k => [k, { ...base.features[k], ...o?.features?.[k] }])) as unknown as VoiceFeatures };
  };
  const effective = (id?: string): VoiceRealtimeProfile => {
    const rt = effectiveInput(id);
    return { ...rt, features: Object.fromEntries(VOICE_FEATURES.map(k => [k, { ...rt.features[k], effective: k === 'reranker' || k === 'postTurnRefine' ? 'engine-fixed' : 'applied' }])) as VoiceRealtimeProfile['features'] };
  };
  const assertAllBudgets = (base: VoiceRealtimeProfileInput) => {
    validateVoiceBudget(base.features, config().budgetMs);
    for (const id of Object.keys(d.config().agents)) {
      const o = d.config().agents[id]?.voice;
      validateVoiceBudget(Object.fromEntries(VOICE_FEATURES.map(k => [k, { ...base.features[k], ...o?.features?.[k] }])) as unknown as VoiceFeatures, config().budgetMs);
    }
  };
  const summarize = async (m: CatalogModel): Promise<VoiceModel> => ({ modelId: m.id, role: m.kind === 'stt' ? 'asr' : m.kind, sizeBytes: modelSizeBytes(m) ?? 0, licenceId: m.licence.id, needsConfirmation: needsLicenceConfirmation(m), installed: await (d.installed ?? isInstalled)(d.modelsDir, m) });
  const model = (id: string) => { const m = catalog.models[id]; if (!m) throw new RpcError('E_NOT_FOUND', 'Unknown voice model'); return m; };
  const emit = (connection: string, method: string, params: object) => {
    if (!closed && !signal.aborted) d.notify(method, params, { audience: [{ connectionId: connection }], optIn: true });
  };
  const install = async (m: CatalogModel, accepted: boolean, connection: string, callSignal: AbortSignal) => {
    // Deliberately before disk/network, including the already-installed shortcut.
    if (needsLicenceConfirmation(m) && !accepted) throw new RpcError('E_VOICE_LICENSE', 'Explicit model licence acceptance required', { reason: 'confirmation-required', detail: m.licence.id, ids: { modelId: m.id } });
    if (await (d.installed ?? isInstalled)(d.modelsDir, m)) return;
    try {
      await (d.install ?? downloadModel)(m, { modelsDir: d.modelsDir, acceptedLicences: accepted ? [licenceKey(m)] : [], signal: AbortSignal.any([signal, callSignal]), ...(d.fetch ? { fetch: d.fetch } : {}), onProgress: p => emit(connection, 'voice.download.progress', { modelId: m.id, receivedBytes: p.receivedBytes, totalBytes: p.totalBytes ?? modelSizeBytes(m) ?? 0, done: false }) });
      emit(connection, 'voice.download.progress', { modelId: m.id, receivedBytes: modelSizeBytes(m) ?? 0, totalBytes: modelSizeBytes(m) ?? 0, done: true });
    } catch {
      emit(connection, 'voice.download.progress', { modelId: m.id, receivedBytes: 0, totalBytes: modelSizeBytes(m) ?? 0, done: true, error: 'E_VOICE_UNAVAILABLE' });
      throw new RpcError('E_VOICE_UNAVAILABLE', 'Voice model download unavailable', { ids: { modelId: m.id } });
    }
  };
  /** Same gate as voice.language.set, for paths that cannot carry an acceptance: the confirmation must already be stored. */
  const requireStoredConfirmation = (language: 'de' | 'en', profile: 'fast' | 'quality') => {
    const selected = modelsFor(catalog, language, profile), stored = d.config().voice.local.acceptedLicences;
    for (const m of [selected.stt, selected.tts, selected.vad]) if (needsLicenceConfirmation(m) && !Object.hasOwn(stored, licenceKey(m))) throw new RpcError('E_VOICE_LICENCE', 'Explicit model licence acceptance required', { detail: m.licence.id, ids: { modelId: m.id } });
  };
  const overrideResult = (id: string) => ({ agentId: id, override: override(id), effective: effective(id) });
  const stop = async (id: string) => {
    const s = sessions.get(id); if (!s) return;
    s.closed = true;
    await s.opening;
    try { await s.channel?.close(); } finally { sessions.delete(id); }
    emit(s.connection, 'voice.realtime.state', { sessionId: id, agentId: s.agentId, state: 'stopped' });
  };
  const raw: Record<string, Handler> = {
    'voice.status': async () => ({ available: !!d.audio && !closed && !signal.aborted, language: config().language, profile: config().profile, activeSessions: sessions.size, budgetMs: config().budgetMs }),
    'voice.agent.override.get': async p => overrideResult(p.agentId),
    'voice.agent.override.set': async p => serialize(async () => { requireAgent(p.agentId); const base = effectiveInput(); validateVoiceBudget(Object.fromEntries(VOICE_FEATURES.map(k => [k, { ...base.features[k], ...p.override.features?.[k] }])) as unknown as VoiceFeatures, config().budgetMs);
      if (p.override.language !== undefined || p.override.profile !== undefined) { const language = languageKey(p.override.language ?? config().language); requireStoredConfirmation(language, p.override.profile ?? config().selectedProfiles[language]); }
      await save([{ key: `agents.${p.agentId}.voice`, value: { ...p.override, ...(p.override.language ? { language: languageKey(p.override.language) } : {}) } }]); return overrideResult(p.agentId); }),
    'voice.agent.override.clear': async p => serialize(async () => { requireAgent(p.agentId); await save([{ key: `agents.${p.agentId}.voice`, value: {} }]); return overrideResult(p.agentId); }),
    'voice.models.list': async () => ({ models: await Promise.all(Object.values(catalog.models).map(summarize)) }),
    'voice.models.install': async (p, ctx) => serialize(async () => { const m = model(p.modelId); if (p.licenseAccepted === true && d.confirmLicence) { const who = await authorize(ctx, 'voice.models.install', p, true); d.confirmLicence(who.userId, m); } await install(m, p.licenseAccepted === true, ctx.connectionId, ctx.signal); return { model: await summarize(m) }; }),
    'voice.language.list': async p => { if (p?.agentId) requireAgent(p.agentId); return { languages: await Promise.all((['de','en'] as const).map(async language => ({ language, profiles: Object.fromEntries(await Promise.all((['fast','quality'] as const).map(async profile => { const m = modelsFor(catalog, language, profile); return [profile, { models: await Promise.all([m.stt, m.tts, m.vad].map(summarize)) }]; }))) }))) }; },
    'voice.language.get': async p => { const o = override(p?.agentId); const language = languageKey(o?.language ?? config().language); const profile = o?.profile ?? config().selectedProfiles[language]; return { language, profile }; },
    'voice.language.set': async (p, ctx) => serialize(async () => {
      validateVoiceSetupSelection(p);
      if (p.agentId) requireAgent(p.agentId);
      const selected = modelsFor(catalog, languageKey(p.language), p.profile); const models = [selected.stt, selected.tts, selected.vad]; const accepted = new Set<string>(p.acceptLicences ?? []);
      for (const m of models) if (needsLicenceConfirmation(m) && !accepted.has(licenceKey(m))) throw new RpcError('E_VOICE_LICENCE', 'Explicit model licence acceptance required', { detail: m.licence.id, ids: { modelId: m.id } });
      if (d.confirmLicence) { const who = await authorize(ctx, 'voice.language.set', p, true); for (const m of models) if (accepted.has(licenceKey(m))) d.confirmLicence(who.userId,m); }
      for (const m of models) await install(m, accepted.has(licenceKey(m)), ctx.connectionId, ctx.signal);
      const profile = p.profile;
      const licenceChanges = models.filter(m => accepted.has(licenceKey(m))).map(m => ({ key: `voice.local.acceptedLicences.${licenceKey(m)}`, value: new Date(d.clock()).toISOString() }));
      if (licenceChanges.length) await save([{ key: 'voice.local.acceptedLicences', value: { ...d.config().voice.local.acceptedLicences, ...Object.fromEntries(models.filter(m => accepted.has(licenceKey(m))).map(m => [licenceKey(m),new Date(d.clock()).toISOString()])) } }]);
      await save(p.agentId ? [{ key: `agents.${p.agentId}.voice`, value: { ...override(p.agentId), language: p.language, profile } }] : [{ key: 'voice.v3.language', value: p.language }, { key: 'voice.v3.profile', value: profile }, { key: `voice.v3.selectedProfiles.${p.language}`, value: profile }]);
      return { ok: true, downloading: false };
    }),
    'voice.realtime.profile.get': async p => effective(p?.agentId),
    'voice.realtime.profile.set': async p => serialize(async () => {
      const { agentId, ...rt } = p;
      if (agentId) { requireAgent(agentId); validateVoiceBudget(rt.features, config().budgetMs); await save([{ key: `agents.${agentId}.voice`, value: { ...override(agentId), ...rt } }]); }
      else { assertAllBudgets(rt); await save([{ key: 'voice.v3.realtime', value: rt }]); }
      return effective(agentId);
    }),
    'voice.metrics.get': async p => { if (p?.agentId) requireAgent(p.agentId); return d.metrics(); },
    'voice.realtime.start': async (p, ctx) => {
      requireAgent(p.agentId);
      validateVoiceBudget(effectiveInput(p.agentId).features, config().budgetMs);
      if (!d.audio) throw new RpcError('E_VOICE_UNAVAILABLE', 'No trusted audio transport is attached', { reason: 'no-audio-transport' });
      const who = await authorize(ctx, 'voice.realtime.start', p, true), chat = d.session(p.chatSessionId);
      if (!chat || chat.owner !== who.userId || chat.agentId !== p.agentId || chat.archivedAt !== null) throw new RpcError('E_NOT_FOUND', 'Voice chat session not found');
      if (sessions.size >= 16) throw new RpcError('E_VOICE_UNAVAILABLE', 'Voice session capacity reached');
      const sessionId = randomUUID(); const s = { connection: ctx.connectionId, person: who.userId, agentId: p.agentId, closed: false } as NonNullable<ReturnType<typeof sessions.get>>; sessions.set(sessionId, s);
      emit(s.connection, 'voice.realtime.state', { sessionId, agentId: s.agentId, state: 'starting' });
      s.opening = (async () => {
        try { s.channel = await d.openTalk({ sessionId: p.chatSessionId, signal: AbortSignal.any([signal,ctx.signal]) }, { sessionId: p.chatSessionId, principal: who.userId, caller: { channel: 'cli', accountId: 'voice', userId: who.userId }, approver: { person: who.userId, surface: 1 }, receive: chunk => s.closed ? Promise.resolve() : d.audio!.receive(s.connection, sessionId, chunk), stopPlayback: () => d.audio!.stop(s.connection, sessionId), transcript: (text, final) => { if (!s.closed) emit(s.connection, 'voice.realtime.transcript', { sessionId, agentId: s.agentId, text: text.slice(0,32768), final }); }, event: event => { if (event.type === 'voice.failed') { s.closed = true; emit(s.connection, 'voice.realtime.state', { sessionId, agentId: s.agentId, state: 'failed' }); void stop(sessionId).catch(() => {}); } } }); }
        catch { sessions.delete(sessionId); emit(s.connection, 'voice.realtime.state', { sessionId, agentId: s.agentId, state: 'failed' }); throw new RpcError('E_VOICE_UNAVAILABLE', 'Realtime voice could not start'); }
      })();
      await s.opening;
      if (s.closed || closed || signal.aborted) { await s.channel?.close(); sessions.delete(sessionId); throw new RpcError('E_VOICE_UNAVAILABLE', 'Voice session closed during start'); }
      emit(s.connection, 'voice.realtime.state', { sessionId, agentId: s.agentId, state: 'running' }); return { sessionId, state: 'running' };
    },
    'voice.realtime.stop': async (p, ctx) => { const s = sessions.get(p.sessionId), who = await authorize(ctx, 'voice.realtime.stop', p, true); if (!s || s.person !== who.userId || s.connection !== ctx.connectionId) throw new RpcError('E_NOT_FOUND', 'Voice session not found'); await stop(p.sessionId); return { sessionId: p.sessionId, state: 'stopped' }; },
  };
  const writes = new Set(Object.keys(raw).filter(n => /\.(set|clear|start|stop|install)$/.test(n)));
  const methods = Object.fromEntries(Object.entries(raw).map(([name, inner]) => [name, async (p: unknown, ctx: CallContext) => {
    await authorize(ctx, name, p, writes.has(name));
    if (closed || signal.aborted) throw new RpcError('E_VOICE_UNAVAILABLE', 'Voice is closed');
    const work = inner(p, ctx); pending.add(work); try { return await work; } finally { pending.delete(work); }
  }])) as Record<string, Handler>;
  return { methods, async connectionClosed(id: string) { await Promise.allSettled([...sessions].filter(([,s]) => s.connection === id).map(([sid]) => stop(sid))); }, channel(sessionId: string, connectionId: string): VoiceChannel | undefined { const s = sessions.get(sessionId); return s && !s.closed && s.connection === connectionId ? s.channel : undefined; }, async close() { if (closed) return; closed = true; operations.abort(); await Promise.allSettled([...sessions.keys()].map(stop)); await Promise.allSettled([...pending]); } };
}
