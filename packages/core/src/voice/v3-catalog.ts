import { loadCatalog, type Catalog } from '../../../voice-providers/src/index.ts';
/** English fast voice: owner decision pending. */
export const EN_FAST_TTS_MODEL = 'kokoro-multi';
export const V3_TTS_DEFAULTS = { de: { fast: 'piper-de-thorsten-low', quality: 'kokoro-multi' }, en: { fast: EN_FAST_TTS_MODEL, quality: 'kokoro-multi' } } as const;
/** Keep verified packages/licences from V2; replace its legacy TTS preselection. */
export function voiceV3Catalog(override?: unknown, profiles: Record<'de' | 'en', Record<'fast' | 'quality', string>> = V3_TTS_DEFAULTS): Catalog {
  const catalog = structuredClone(loadCatalog(override));
  for (const language of ['de', 'en'] as const) {
    const entry = catalog.languages[language];
    if (entry) entry.tts = { fast: profiles[language].fast, quality: profiles[language].quality };
  }
  return catalog;
}
