import { decide } from '../policy/index.ts';
import { createHash } from 'node:crypto';
import { RealtimeService } from './realtime.ts';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { VoiceBroker } from './broker.ts';
import { LiveService, type LiveClient } from './live.ts';
import { socketConnect, type JsonSocket, type SocketConnect } from './socket.ts';
import { voiceBudget } from './budget.ts';
import { Sensitive, OpenAIError, bounded, call, object, text } from '../openai-auth/ports.ts';
import { endpoint } from '../openai-auth/profiles.ts';
import { FederatedCredential } from '../openai-auth/federated.ts';
import { createAuthSecretStore } from '../auth/secret-store.ts';
import type { CompositionDeps } from '../composition/index.ts';
import type { OpenAIRuntime } from '../openai-auth/runtime.ts';
import type { CallBudget } from '../budget/index.ts';
import type { VoiceEvent, VoiceRequest } from './ports.ts';
import type { ChatProvider } from '../session/provider.ts';
/** Register once in composition. The only public delivery API is bound to a trusted authenticated surface. */
export function createVoiceRuntime(d: CompositionDeps, openai: OpenAIRuntime, budget: CallBudget | null, test?: { connect: SocketConnect }) {
  const config = d.config().auth?.openai, store = createAuthSecretStore(d.secrets), sockets = new Map<string, { socket: JsonSocket; client?: LiveClient; closing: boolean; finish?: (event: { eventId: string; usage: import('./ports.ts').VoiceUsage }) => void }>();
  const controllers = new Map<string, AbortController>();
  const connect = test?.connect ?? socketConnect(d.egress); let delegate: ChatProvider | null = null;
  const ledger = budget ? voiceBudget({ path: join(d.home, 'state', 'voice-usage.sqlite'), budget, clock: d.clock, dailySeconds: config?.voiceDailySeconds ?? 3600 }) : null;
  // Parent profile must be selected in trusted config, never supplied by the media client.
  const parentConfig = () => d.config().providers.openaiVoice as { secretRef?: string; federated?: import('../openai-auth/federated.ts').FederatedSource } | undefined;
  let federation: FederatedCredential | undefined;
  const lease = async (parent: VoiceRequest['parent']) => {
    const c = parentConfig(); if (!c) throw new OpenAIError('auth-required');
    if (parent.kind === 'federated_token') { federation ??= new FederatedCredential(c.federated ?? config?.federated ?? {}, d.clock); return federation.lease(); }
    if (!c.secretRef) throw new OpenAIError('auth-required'); const key = await store.get(c.secretRef); if (!key) throw new OpenAIError('auth-required'); return new Sensitive(key);
  };
  const usage = (raw: unknown): VoiceEvent | undefined => {
    const e = object(raw), type = String(e.type);
    if (type !== 'session.usage.updated' && type !== 'session.closed') return undefined;
    const u = object(e.usage ?? {});
    return { type, eventId: typeof e.event_id === 'string' ? e.event_id : randomUUID(), seconds: typeof u.duration_seconds === 'number' ? u.duration_seconds : typeof u.seconds === 'number' ? u.seconds : 0, costMicros: typeof u.cost_micros === 'number' ? u.cost_micros : 0 };
  };
  const broker = new VoiceBroker({ http: openai.http, clock: { now: d.clock }, credentials: { lease }, models: { async allowed(_provider, model, parent) { const data = object(await call(openai.http, { method: 'GET', url: endpoint(parent.region) + '/models', authorization: await lease(parent) })); return Array.isArray(data.data) && data.data.some(v => object(v).id === model); } },
    budget: ledger?.port ?? { reserve: async () => false, record: async () => false, release: async () => {} },
    policy: { authorize: async () => false, tool: async () => { throw new OpenAIError('policy-denied'); }, spend: async r => {
      openai.audit({ kind: 'handle-denied', code: 'budget-exceeded' });
      const actionHash = createHash('sha256').update(JSON.stringify({ agent: r.agent, person: r.user, effect: 'money.spend' })).digest('hex');
      const decision = decide({ capability: 'money.spend', tool: 'voice.session.create', flags: { outsideRoots: false, denyListHit: false }, actionHash }, { principal: { person: r.user }, subject: { kind: 'agent', agentId: r.agent }, surface: r.originTrust ?? 0 }, { clock: { now: d.clock }, grants: { get: () => undefined, list: () => [] } });
      if (decision.kind === 'ask') { const opened = await d.permissions.open(); void opened.service.request({ request: decision.request, callId: randomUUID(), tool: 'voice.session.create', args: { reason: 'budget-exceeded' }, agentId: r.agent, principal: r.user, park: false, signal: d.signal }).catch(() => d.logger.warn('voice.approval_unavailable')); }
    }, async delegate(r) {
      if (!delegate) throw new OpenAIError('policy-denied');
      const controller = r.sessionId ? controllers.get(r.sessionId) : undefined;
      const event = object(r.event); const input = text(event.text); let answer = '';
      for await (const chunk of delegate.stream({ sessionId: 'voice-' + randomUUID(), turnId: randomUUID(), agentId: r.agent, authenticatedPerson: r.user, principal: r.user, originSurface: 2, summaries: [], memory: '', messages: [{ role: 'user', text: input }], signal: controller ? AbortSignal.any([d.signal, controller.signal]) : d.signal })) if (chunk.type === 'delta') answer += chunk.text;
      return answer;
    } },
    sideband: { async attach(r) {
      let closed = false;
      const socket = await connect({ url: r.url, authorization: r.authorization, async onMessage(value) { const e = usage(value); const id = new URL(r.url).pathname.split('/').at(-2); if (e && !(id && sockets.get(id)?.closing)) await r.onEvent(e); }, onClose: () => { const url = new URL(r.url); const id = url.searchParams.get('call_id') ?? url.pathname.split('/').at(-2); if (!closed && id) void broker.close(id, 'failure').catch(() => {}); } });
      return { send: (value: unknown) => { const v = object(value); return socket.send(v.type === 'delegation.result' ? { type: 'session.commentary.append', event_id: randomUUID(), delegation_id: v.requestId, content: String(v.result).slice(0, 1800) } : v); }, async close() { closed = true; await socket.close(); } };
    } },
    websocket: { async start(r) {
      if (!new URL(r.url).pathname.endsWith('/live/sessions')) throw new OpenAIError('transport-unavailable');
      let ready!: (value: { id: string }) => void, fail!: (e: unknown) => void; let id: string | undefined; let transcript = '';
      const started = new Promise<{ id: string }>((resolve, reject) => { ready = resolve; fail = reject; });
      const socket = await connect({ url: r.url, authorization: r.authorization, async onMessage(raw) {
        const e = object(raw);
        if (e.type === 'session.started') { id = text(object(e.session).id); sockets.set(id, { socket, closing: false }); controllers.set(id, new AbortController()); ready({ id }); return; }
        if (e.type === 'error') { fail(new OpenAIError('endpoint-rejected')); if (id) await broker.close(id, 'failure'); return; }
        if (!id) return;
        const closing = sockets.get(id);
        if (closing?.closing && e.type === 'session.closed') { const u = usage(e); if (u && 'seconds' in u) closing.finish?.({ eventId: u.eventId ?? randomUUID(), usage: { seconds: u.seconds ?? 0, costMicros: u.costMicros ?? 0, inputTokens: 0, outputTokens: 0 } }); return; }
        if (closing?.closing) return;

        if (e.type === 'session.input_transcript.delta' && typeof e.delta === 'string') { transcript = (transcript + e.delta).slice(-32768); return; }
        if (e.type === 'session.delegation.created' && object(e.delegation).target === 'client') { await broker.event(id, { type: 'delegation.request', requestId: text(object(e.delegation).id), payload: { text: transcript } }); return; }
        if (e.type === 'delegation.request') { await broker.event(id, { type: 'delegation.request', requestId: text(e.request_id), payload: e.payload }); return; }
        if (e.type === 'session.output_audio.delta' && typeof e.delta === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(e.delta)) await sockets.get(id)?.client?.receive(Buffer.from(e.delta, 'base64'));
        const event = usage(e); if (event) await broker.event(id, event);
      }, onClose() { fail(new OpenAIError('transport-failed')); if (id && !sockets.get(id)?.closing) void broker.close(id, 'failure').catch(() => {}); } });
      try { const { transport: _transport, ...session } = r.firstMessage.session; await socket.send({ type: 'session.start', session }); return await bounded(started, AbortSignal.timeout(30000)); }
      catch (e) { await socket.close(); throw e; }
    } },
    sessions: { async close(id, provider, parent) {
      controllers.get(id)?.abort(); controllers.delete(id);
      const item = sockets.get(id); if (item) {
        item.closing = true;
        const final = new Promise<{ eventId: string; usage: import('./ports.ts').VoiceUsage }>(resolve => { item.finish = resolve; });
        let result: { eventId: string; usage: import('./ports.ts').VoiceUsage } | undefined;
        try { await item.socket.send({ type: 'session.close' }); result = await bounded(final, AbortSignal.timeout(5000)); }
        catch { d.logger.warn('voice.final_usage_unconfirmed'); }
        finally { await item.socket.close(); await item.client?.closed(); sockets.delete(id); }
        return result;
      }
      // Broker WebRTC sessions also need provider hangup. Primary WS closure ends WS sessions.
      if (!item) await call(openai.http, { method: 'POST', url: endpoint(parent.region) + (provider === 'openai:gpt-live' ? '/live/sessions/' : '/realtime/calls/') + encodeURIComponent(id) + '/hangup', authorization: await lease(parent), json: {} });
    } }, audit: openai.audit, notice: async r => { d.logger.warn('voice.session.notice', { agent: r.agent, message: r.written }); }, capacity: config?.voiceCapacity ?? 1 });
  const live = new LiveService({ broker, clock: d.clock, ttlSeconds: config?.liveHandleTtlSeconds ?? 60, audit: openai.audit, relay: { async connect(id, client) {
    const item = sockets.get(id); if (!item) throw new OpenAIError('transport-unavailable'); item.client = client;
    return { async send(frame) { if (item.closing) throw new OpenAIError('handle-revoked'); if (frame.byteLength > 128 * 1024 || frame.byteLength % 2) throw new OpenAIError('invalid-request'); await item.socket.send({ type: 'session.input_audio.append', audio: Buffer.from(frame).toString('base64') }); }, async close() { item.closing = true; await item.socket.close(); } };
  } } });
  const sweep = setInterval(() => { void live.sweep().catch(() => d.logger.warn('voice.sweep_failed')); }, 1000); sweep.unref();
  const runtime = { live, realtime: new RealtimeService(broker), broker, setDelegate(provider: ChatProvider | null) { delegate = provider; }, async close() { clearInterval(sweep); try { await live.close(); } finally { federation?.close(); ledger?.close(); } } };
  d.options?.onVoice?.(runtime); return runtime;
}
export type VoiceRuntime = ReturnType<typeof createVoiceRuntime>;
