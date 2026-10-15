import { loadCatalog, parseCatalog, type Catalog } from '../../../voice-providers/src/index.ts';
/** English fast voice: owner decision pending. */
export const EN_FAST_TTS_MODEL = 'kokoro-multi';
export const V3_TTS_DEFAULTS = { de: { fast: 'piper-de-thorsten-low', quality: 'kokoro-multi' }, en: { fast: EN_FAST_TTS_MODEL, quality: 'kokoro-multi' } } as const;
/**
 * Keep verified packages/licences from V2; replace its legacy TTS preselection by the profiles. The language's declared
 * tts fallback tier is kept. The profile ids are checked: the result is validated as a whole, so an unknown id or a model of
 * the wrong kind is a `catalog` error naming it.
 */
export function voiceV3Catalog(override?: unknown, profiles: Record<'de' | 'en', Record<'fast' | 'quality', string>> = V3_TTS_DEFAULTS): Catalog {
  const catalog = structuredClone(loadCatalog(override));
  for (const language of ['de', 'en'] as const) {
    const entry = catalog.languages[language];
    if (entry) entry.tts = { fast: profiles[language].fast, quality: profiles[language].quality, ...(entry.tts.fallback !== undefined ? { fallback: entry.tts.fallback } : {}) };
  }
  return parseCatalog(catalog);
}
