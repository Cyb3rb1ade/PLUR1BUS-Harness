import { LiveHandles, type LiveBinding, type MediaChannel } from './handles.ts';
import type { VoiceRequest } from './ports.ts';
import type { VoiceBroker } from './broker.ts';
import { OpenAIError, type AuditPort, type Sensitive } from '../openai-auth/ports.ts';
export interface LiveClient { authenticated: boolean; person: string; session: string; model: string; surface: string; trust: 2 | 3; receive(frame: Uint8Array): Promise<void>; closed(): Promise<void> }
/** The authenticated surface owns these callbacks. Neither provider credential nor provider session id leaves this API. */
export class LiveService {
  readonly #handles: LiveHandles; readonly #broker: VoiceBroker; readonly #relay: { connect(sessionId: string, client: LiveClient): Promise<MediaChannel> };
  constructor(o: { broker: VoiceBroker; relay: { connect(sessionId: string, client: LiveClient): Promise<MediaChannel> }; clock: () => number; ttlSeconds: number; audit: AuditPort }) { this.#broker = o.broker; this.#relay = o.relay; this.#handles = new LiveHandles(o); }
  #binding(client: LiveClient): LiveBinding { if (!client.authenticated || ![2,3].includes(client.trust) || !/^(desktop|web):[^:]+$/.test(client.surface)) throw new OpenAIError('surface-denied'); return { person: client.person, session: client.session, model: client.model, surface: client.surface }; }
  issue(request: VoiceRequest, client: LiveClient) {
    const binding = this.#binding(client);
    if (request.provider !== 'openai:gpt-live' || request.transport !== 'websocket' || request.user !== client.person || request.model !== client.model || request.surface.kind !== client.surface.split(':')[0] || request.surface.trust !== client.trust || !request.surface.authenticated) throw new OpenAIError('handle-binding');
    let closed = false; const delivery = { ...client, async closed() { if (closed) return; closed = true; await client.closed(); } };
    const savedRequest = structuredClone(request);
    return this.#handles.issue(binding, async () => {
      const result = await this.#broker.create(savedRequest); // existing broker calls budget reserve before provider creation
      try { const relay = await this.#relay.connect(result.sessionId, delivery); return { send: frame => relay.send(frame), close: async () => { try { await this.#broker.close(result.sessionId); } finally { try { await relay.close(); } finally { await delivery.closed(); } } } }; }
      catch (e) { await this.#broker.close(result.sessionId); throw e; }
    });
  }
  redeem(handle: Sensitive, client: LiveClient) { return this.#handles.redeem(handle, this.#binding(client)); }
  endSession(session: string, client: LiveClient) { this.#binding(client); if (client.session !== session) throw new OpenAIError('handle-binding'); return this.#handles.revokeSession(session, client.person); }
  async sweep() { await this.#handles.sweep(); await this.#broker.sweep(); }
  async close() { await this.#handles.close(); await this.#broker.dispose(); }
}
