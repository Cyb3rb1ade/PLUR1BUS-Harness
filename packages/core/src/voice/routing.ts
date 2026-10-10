import { CLOUD_PROVIDER_IDS, type CloudProviderId, type VoiceOperation } from '../../../voice-providers/src/index.ts';
export interface VoicePreferences { realtime?: CloudProviderId; asr?: CloudProviderId; tts?: CloudProviderId }
export type VoiceRoute = { kind: 'realtime'; provider: CloudProviderId } | { kind: 'cascade'; asr: CloudProviderId; tts: CloudProviderId } | { kind: 'local' };
export interface RouteOptions {
  available: { realtime: readonly string[]; asr: readonly string[]; tts: readonly string[]; local: boolean };
  privacyPin?: boolean; preferences?: VoicePreferences;
  allowed: (provider: CloudProviderId, operation: VoiceOperation) => Promise<boolean>;
}
/** Trusted admission occurs before discovery, secret leasing or any provider I/O. Privacy is an absolute pin. */
export async function selectVoiceRoute(o: RouteOptions): Promise<VoiceRoute> {
  if (!o.privacyPin) {
    const pick = async (kind: VoiceOperation): Promise<CloudProviderId | undefined> => {
      const preferred = o.preferences?.[kind];
      for (const id of preferred ? [preferred] : CLOUD_PROVIDER_IDS) if (o.available[kind].includes(id) && await o.allowed(id, kind)) return id;
      return undefined;
    };
    const provider = await pick('realtime'); if (provider) return { kind: 'realtime', provider };
    const asr = await pick('asr'); const tts = asr ? await pick('tts') : undefined;
    if (asr && tts) return { kind: 'cascade', asr, tts };
  }
  if (o.available.local) return { kind: 'local' };
  throw new Error('voice-unavailable');
}
