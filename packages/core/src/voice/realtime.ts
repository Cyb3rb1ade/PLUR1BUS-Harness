import { inspect } from 'node:util';
import type { VoiceBroker, EphemeralSecret } from './broker.ts';
import type { VoiceRequest } from './ports.ts';
import { OpenAIError } from '../openai-auth/ports.ts';
import type { LiveClient } from './live.ts';
const binding = (c: LiveClient) => { if (!c.authenticated || c.surface.split(':')[0] !== 'desktop' || ![2,3].includes(c.trust)) throw new OpenAIError('surface-denied'); return JSON.stringify([c.person,c.session,c.model,c.surface]); };
/** The delivery object never serializes a provider secret; only the original authenticated path can redeem it. */
export class EphemeralDelivery {
  readonly #secret: EphemeralSecret; readonly #binding: string;
  constructor(secret: EphemeralSecret, client: LiveClient) { this.#secret=secret;this.#binding=binding(client); }
  deliver(client: LiveClient) { if(binding(client)!==this.#binding)throw new OpenAIError('handle-binding');return this.#secret.consume(); }
  toJSON(){return this.#secret.toJSON();}
  [inspect.custom](){return this.toJSON();}
}
export class RealtimeService {
  readonly #broker: VoiceBroker; readonly #sessions=new Map<string,Set<string>>();
  constructor(broker:VoiceBroker){this.#broker=broker;}
  async mint(request:VoiceRequest,client:LiveClient){
    const key=binding(client);if(request.provider!=='openai:realtime'||request.user!==client.person||request.model!==client.model||request.surface.kind!=='desktop'||request.surface.trust!==client.trust||!request.surface.authenticated)throw new OpenAIError('handle-binding');
    const secret=await this.#broker.mint(request);const refs=this.#sessions.get(key)??new Set();refs.add(secret.reservation);this.#sessions.set(key,refs);return new EphemeralDelivery(secret,client);
  }
  async endSession(client:LiveClient){const key=binding(client);for(const ref of this.#sessions.get(key)??[])await this.#broker.revokeEphemeral(ref);this.#sessions.delete(key);}
}
