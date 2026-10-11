import type { VoiceLanguageSetParams, VoiceLanguage } from '@plur1bus/rpc-schema';
import { RpcError } from '../rpc/errors.ts';
export const SETUP_STEPS = [
  { id: 'account', skippable: false, unavailable: false },
  { id: 'persona', skippable: false, unavailable: false },
  { id: 'model', skippable: true, unavailable: false },
  { id: 'switchboard', skippable: true, unavailable: true },
  { id: 'memory', skippable: true, unavailable: false },
  { id: 'voice', skippable: true, unavailable: false },
  { id: 'backup', skippable: true, unavailable: false },
  { id: 'import', skippable: true, unavailable: true },
] as const;
export const setupStepsFor = (bundled: boolean) => SETUP_STEPS.filter(step => !bundled || step.id !== 'account');
/** The Sprache step uses the canonical language RPC; a research model always needs the person's explicit selection. */
export function voiceSetupSelection(languages: readonly VoiceLanguage[], locale: string): VoiceLanguageSetParams | null {
  const code = locale.toLowerCase().split(/[-_]/)[0];
  const language = languages.find(l => l.language === code);
  if (!language) return null;
  const order = language.language === 'en' ? ['quality','fast'] as const : ['fast','quality'] as const;
  const profile = order.find(p => language.profiles[p]?.models.length && language.profiles[p]!.models.every(m => !m.needsConfirmation));
  return profile ? { language: language.language, profile } : null;
}
export function validateVoiceSetupSelection(p: VoiceLanguageSetParams): void {
  if (!['de','en'].includes(p.language) || !['fast','quality'].includes(p.profile)) throw new RpcError('E_INVALID_PARAMS', 'Unsupported setup voice selection');
}
