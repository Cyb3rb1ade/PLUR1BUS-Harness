import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { boundary, call, object, text, positive, Sensitive, OpenAIError } from '../openai-auth/ports.ts';
import { endpoint, safetyIdentifier } from '../openai-auth/profiles.ts';
import type { VoicePorts, VoiceRequest, VoiceEvent, VoiceUsage, SidebandConnection } from './ports.ts';
interface Session { request: VoiceRequest; reservation: string; sideband: SidebandConnection; expiresAt: number; events: Set<string>; tools: Set<string>; totals: VoiceUsage; backend: Set<Promise<void>> }
/** Only the authenticated desktop delivery boundary may call consume. Inspection never reveals the secret. */
export class EphemeralSecret {
  readonly #secret: Sensitive; readonly #clock: () => number; #consumed = false; #revoked = false;
  readonly ttlSeconds: number; readonly expiresAt: number; readonly reservation: string;
  constructor(secret: Sensitive, ttlSeconds: number, expiresAt: number, reservation: string, clock: () => number) { this.#secret = secret; this.ttlSeconds = ttlSeconds; this.expiresAt = expiresAt; this.reservation = reservation; this.#clock = clock; }
  consume() { if (this.#revoked || this.#consumed || this.#clock() >= this.expiresAt) throw new OpenAIError('ephemeral-consumed'); this.#consumed = true; return this.#secret; }
  revoke() { this.#revoked = true; }
  toJSON() { return { kind: 'minted_ephemeral', ttlSeconds: this.ttlSeconds, expiresAt: this.expiresAt, secret: '[redacted]' }; }
  [inspect.custom]() { return this.toJSON(); }
}
/** In-process session broker. Runtime integration must call sweep periodically and dispose during shutdown. */
export class VoiceBroker {
  readonly #p: VoicePorts; readonly #sessions = new Map<string, Session>();
  readonly #pending = new Map<string, { request: VoiceRequest; expiresAt: number; secret: EphemeralSecret }>();
  readonly #buffered = new Map<string, VoiceEvent[]>();
  readonly #flights = new Map<string, Promise<void>>(); #starting = 0;
  constructor(ports: VoicePorts) { if (!Number.isInteger(ports.capacity) || ports.capacity < 1) throw new OpenAIError('invalid-request'); this.#p = ports; }
  async #validate(r: VoiceRequest) {
    if (!r.surface.authenticated || ![2,3].includes(r.surface.trust) || r.surface.kind === 'group') throw new OpenAIError('surface-denied');
    if (!['openai:realtime','openai:gpt-live'].includes(r.provider) || !['api_key','federated_token'].includes(r.parent.kind) || !r.agent || !r.user || !r.model || !['webrtc','websocket','sip'].includes(r.transport)) throw new OpenAIError('invalid-request');
    endpoint(r.parent.region);
    if (r.transport === 'sip') throw new OpenAIError('transport-unavailable');
    if (r.transport === 'webrtc' && (typeof r.sdp !== 'string' || !r.sdp.startsWith('v=0') || r.sdp.length > 128 * 1024)) throw new OpenAIError('invalid-request');
    if (r.provider === 'openai:gpt-live' && r.model !== 'gpt-live-1') throw new OpenAIError('invalid-request');
    if (r.delegation !== undefined && !['client','responses'].includes(r.delegation)) throw new OpenAIError('invalid-request');
    if (!await this.#p.models.allowed(r.provider, r.model, r.parent)) throw new OpenAIError('invalid-request');
  }
  async #reserve(r: VoiceRequest, reservation: string) {
    if (!await this.#p.budget.reserve({ agent: r.agent, user: r.user, reservation, model: r.model, provider: r.provider })) {
      await this.#p.policy.spend({ effect: 'money.spend', agent: r.agent, user: r.user, trust: 3, approval: 'once', originTrust: r.surface.trust });
      throw new OpenAIError('budget-exceeded');
    }
  }
  async #attach(id: string, r: VoiceRequest, authorization: Sensitive) {
    const base = endpoint(r.parent.region).replace('https:', 'wss:');
    const url = r.provider === 'openai:gpt-live' ? base + '/live/sessions/' + encodeURIComponent(id) + '/attach' : base + '/realtime?call_id=' + encodeURIComponent(id);
    return this.#p.sideband.attach({ url, authorization, ...(r.instructions === undefined ? {} : { instructions: r.instructions }), tracing: false, onEvent: async e => { if (this.#sessions.has(id)) await this.event(id, e); else { const queue = this.#buffered.get(id) ?? []; if (queue.length >= 128) throw new OpenAIError('invalid-request'); queue.push(e); this.#buffered.set(id, queue); } } });
  }
  async #activate(id: string) { const events = this.#buffered.get(id) ?? []; this.#buffered.delete(id); for (const e of events) await this.event(id, e); }
  async create(input: VoiceRequest): Promise<{ sessionId: string; sdpAnswer?: string }> {
    return boundary(async () => {
      const r = structuredClone(input); await this.#validate(r);
      if (this.#sessions.size + this.#pending.size + this.#starting >= this.#p.capacity) throw new OpenAIError('capacity-exceeded');
      this.#starting++; const reservation = randomUUID(); let sessionId: string | undefined; let sideband: SidebandConnection | undefined;
      try {
        await this.#reserve(r, reservation);
        const authorization = await this.#p.credentials.lease(r.parent), base = endpoint(r.parent.region);
        const live = r.provider === 'openai:gpt-live';
        const json = { model: r.model, store: false, ...(live ? { delegation: { type: r.delegation ?? 'client' } } : { tracing: false }), ...(r.instructions === undefined ? {} : { instructions: r.instructions }), transport: { type: r.transport, ...(r.sdp === undefined ? {} : { sdp: r.sdp }) } };
        // HttpPort encodes Realtime WebRTC as multipart SDP+session JSON; Live is JSON.
        const raw = r.transport === 'websocket'
          ? object(await (() => { if (!this.#p.websocket) throw new OpenAIError('transport-unavailable'); return this.#p.websocket.start({ url: base.replace('https:', 'wss:') + (live ? '/live/sessions' : '/realtime'), authorization, firstMessage: { type: 'session.start', session: json } }); })())
          : object(await call(this.#p.http, { method: 'POST', url: base + (live ? '/live/sessions' : '/realtime/calls'), json, ...(r.sdp === undefined ? {} : { sdp: r.sdp }), authorization, headers: { 'OpenAI-Safety-Identifier': safetyIdentifier(r.user) } }));
        sessionId = text(raw.id);
        const answer = r.transport === 'webrtc' ? textSdp(raw.sdp) : undefined;
        if (this.#sessions.has(sessionId)) { sessionId = undefined; throw new OpenAIError('endpoint-rejected'); }
        sideband = await this.#attach(sessionId, r, authorization);
        this.#p.audit({ kind: 'session-start', provider: r.provider, agentRef: safetyIdentifier(r.agent), surface: r.surface.kind, sessionRef: safetyIdentifier(sessionId) });
        this.#sessions.set(sessionId, { request: r, reservation, sideband, expiresAt: this.#p.clock.now() + 3600000, events: new Set(), tools: new Set(), totals: zero(), backend: new Set() });
        await this.#activate(sessionId);
        if (!this.#sessions.has(sessionId)) throw new OpenAIError('budget-exceeded');
        return { sessionId, ...(answer === undefined ? {} : { sdpAnswer: answer }) };
      } catch (e) { if (sessionId) this.#buffered.delete(sessionId); if (sessionId) await this.#p.sessions.close(sessionId, r.provider, r.parent).catch(() => {}); await sideband?.close().catch(() => {}); await this.#p.budget.release(reservation); throw e; }
      finally { this.#starting--; }
    });
  }
  async mint(input: VoiceRequest & { ttlSeconds?: number }): Promise<EphemeralSecret> {
    return boundary(async () => {
      const r = structuredClone(input); await this.#validate(r);
      if (r.provider !== 'openai:realtime' || r.transport !== 'webrtc' || r.surface.kind !== 'desktop') throw new OpenAIError('surface-denied');
      const ttl = r.ttlSeconds ?? 60;
      if (!Number.isInteger(ttl) || ttl < 10 || ttl > 600) throw new OpenAIError('invalid-request');
      if (this.#sessions.size + this.#pending.size + this.#starting >= this.#p.capacity) throw new OpenAIError('capacity-exceeded');
      this.#starting++; const reservation = randomUUID();
      try {
        await this.#reserve(r, reservation);
        const raw = object(await call(this.#p.http, { method: 'POST', url: endpoint(r.parent.region) + '/realtime/client_secrets', authorization: await this.#p.credentials.lease(r.parent), headers: { 'OpenAI-Safety-Identifier': safetyIdentifier(r.user) }, json: { expires_after: { anchor: 'created_at', seconds: ttl }, session: { type: 'realtime', model: r.model, tracing: false, ...(r.instructions === undefined ? {} : { instructions: r.instructions }) } } }));
        const expiresAt = positive(raw.expires_at) * 1000;
        if (expiresAt <= this.#p.clock.now() || expiresAt > this.#p.clock.now() + ttl * 1000) throw new OpenAIError('endpoint-rejected');
        const value = new Sensitive(text(raw.value));
        this.#p.audit({ kind: 'mint', provider: r.provider, ttlSeconds: ttl, agentRef: safetyIdentifier(r.agent), surface: r.surface.kind, sessionRef: safetyIdentifier(reservation) });
        const secret = new EphemeralSecret(value, ttl, expiresAt, reservation, () => this.#p.clock.now());
        this.#pending.set(reservation, { request: r, expiresAt, secret });
        return secret;
      } catch (e) { await this.#p.budget.release(reservation); throw e; }
      finally { this.#starting--; }
    });
  }
  /** Server-authenticated call-id notification after direct WebRTC connects. Never accept an arbitrary client call id.
   * Production port must authenticate that call belongs to this reservation before invoking this method. */
  async attachEphemeral(reservation: string, callId: string) {
    await boundary(async () => {
      const pending = this.#pending.get(reservation);
      if (!pending || pending.expiresAt <= this.#p.clock.now() || this.#sessions.has(callId)) throw new OpenAIError('ephemeral-consumed');
      const id = text(callId), r = pending.request;
      this.#pending.delete(reservation); // claim before any await: one sideband per reservation
      let sideband: SidebandConnection;
      try { sideband = await this.#attach(id, r, await this.#p.credentials.lease(r.parent)); } catch (e) { this.#pending.set(reservation, pending); throw e; }
      this.#sessions.set(id, { request: r, reservation, sideband, expiresAt: this.#p.clock.now() + 3600000, events: new Set(), tools: new Set(), totals: zero(), backend: new Set() });
      this.#pending.delete(reservation);
      await this.#activate(id);
    });
  }
  /** Serialize sideband events per session so duplicate tools/usage cannot race. */
  async event(id: string, event: VoiceEvent): Promise<void> {
    const previous = this.#flights.get(id) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => boundary(async () => { try { await this.#event(id, event); } catch (e) { await this.close(id, 'failure'); throw e; } })).finally(() => { if (this.#flights.get(id) === work) this.#flights.delete(id); });
    this.#flights.set(id, work); return work;
  }
  async #event(id: string, e: VoiceEvent) {
    const s = this.#sessions.get(id); if (!s) throw new OpenAIError('session-unknown');
    if (e.type === 'delegation.request') {
      if (s.tools.has(e.requestId)) return;
      if (s.request.provider !== 'openai:gpt-live' || s.request.delegation === 'responses' || !this.#p.policy.delegate) throw new OpenAIError('policy-denied');
      s.tools.add(e.requestId);
      const work = this.#p.policy.delegate({ agent: s.request.agent, user: s.request.user, event: e.payload, sessionId: id }).then(async result => {
        if (this.#sessions.get(id) === s) await s.sideband.send({ type: 'delegation.result', requestId: e.requestId, result });
      }).catch(async () => { await this.close(id, 'failure').catch(() => {}); }).finally(() => s.backend.delete(work));
      s.backend.add(work); return; // media and usage events continue while the backend reasons

    }
    if (e.type === 'tool.call') {
      if (s.tools.has(e.callId)) return;
      s.tools.add(e.callId);
      if (!await this.#p.policy.authorize({ agent: s.request.agent, user: s.request.user, callId: e.callId, name: e.name, arguments: e.arguments })) { await s.sideband.send({ type: 'tool.result', callId: e.callId, error: 'policy-denied' }); return; }
      const result = await this.#p.policy.tool({ agent: s.request.agent, user: s.request.user, name: e.name, arguments: e.arguments });
      await s.sideband.send({ type: 'tool.result', callId: e.callId, result }); return;
    }
    const eventId = e.type === 'session.closed' ? (e.eventId ?? 'session-final') : e.eventId;
    if (eventId) {
      if (s.events.has(eventId)) return;
      const usage = usageOf(e);
      // Live usage/final are cumulative; response.done and delegated backend usage are deltas.
      const cumulative = e.type === 'session.usage.updated' || e.type === 'session.closed';
      const delta = { ...usage };
      if (cumulative) for (const k of Object.keys(delta) as (keyof VoiceUsage)[]) { delta[k] = Math.max(0, usage[k] - s.totals[k]); s.totals[k] = Math.max(s.totals[k], usage[k]); }
      const allowed = await this.#p.budget.record({ agent: s.request.agent, user: s.request.user, reservation: s.reservation, eventId, usage: delta });
      s.events.add(eventId);
      if (!allowed) { await this.close(id, 'budget'); return; }
    }
    if (e.type === 'session.closed') await this.close(id);
  }
  async close(id: string, notice?: 'budget' | 'failure') {
    await boundary(async () => {
      const s = this.#sessions.get(id); if (!s) return;
      // First stop provider spend. Retain session for retry if the close fails.
      const final = await this.#p.sessions.close(id, s.request.provider, s.request.parent);
      if (final && !s.events.has(final.eventId)) {
        const cumulative = usageOf(final.usage), delta = { ...cumulative };
        for (const key of Object.keys(delta) as (keyof VoiceUsage)[]) delta[key] = Math.max(0, cumulative[key] - s.totals[key]);
        await this.#p.budget.record({ agent: s.request.agent, user: s.request.user, reservation: s.reservation, eventId: final.eventId, usage: delta }); s.events.add(final.eventId);
      }

      try { if (notice) { const message = notice === 'budget' ? 'Voice budget reached. This session is closing.' : 'Voice session stopped because server-side enforcement is unavailable.'; await this.#p.notice({ agent: s.request.agent, user: s.request.user, spoken: message, written: message }); } }
      finally { try { await s.sideband.close(); } finally { await this.#p.budget.release(s.reservation); this.#sessions.delete(id); this.#buffered.delete(id); this.#p.audit({ kind: 'session-close', provider: s.request.provider }); } }
    });
  }
  async revokeEphemeral(reservation: string) { const pending = this.#pending.get(reservation); if (pending) { pending.secret.revoke(); await this.#p.budget.release(reservation); this.#pending.delete(reservation); } for (const [id, s] of this.#sessions) if (s.reservation === reservation) await this.close(id); }
  async sweep() { for (const [id,s] of this.#sessions) if (s.expiresAt <= this.#p.clock.now()) await this.close(id); for (const [id,p] of this.#pending) if (p.expiresAt <= this.#p.clock.now()) { p.secret.revoke(); await this.#p.budget.release(id); this.#pending.delete(id); } }
  async dispose() { for (const id of this.#sessions.keys()) await this.close(id); for (const [id, p] of this.#pending) { p.secret.revoke(); await this.#p.budget.release(id); } this.#pending.clear(); }
}
function zero(): VoiceUsage { return { seconds: 0, costMicros: 0, inputTokens: 0, outputTokens: 0 }; }
function usageOf(e: { seconds?: number; costMicros?: number; inputTokens?: number; outputTokens?: number }): VoiceUsage { const v = zero(); for (const k of Object.keys(v) as (keyof VoiceUsage)[]) { const n = e[k] ?? 0; if (!Number.isFinite(n) || n < 0) throw new OpenAIError('invalid-request'); v[k] = n; } return v; }
function textSdp(v: unknown): string { if (typeof v !== 'string' || !v.startsWith('v=0') || v.length > 128 * 1024) throw new OpenAIError('endpoint-rejected'); return v; }
