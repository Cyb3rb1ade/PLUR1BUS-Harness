export type ProviderFamily = 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';
export interface ModelQuirks { family: ProviderFamily; parallel: boolean; strict: boolean; maxTools: number; namePattern: string; maxNameLength: number; maxDescriptionLength: number; malformedArguments: readonly string[] }
/** Conservative defaults; model overrides are explicit data, never inferred from arbitrary substrings. */
export const QUIRKS: Readonly<Record<string, Readonly<ModelQuirks>>> = Object.freeze({
  'openai-chat': Object.freeze({ family: 'openai-chat', parallel: true, strict: true, maxTools: 128, namePattern: '^[A-Za-z0-9_-]+$', maxNameLength: 64, maxDescriptionLength: 1024, malformedArguments: Object.freeze(['unwrap-json-string', 'trailing-comma', 'numeric-string']) }),
  'openai-responses': Object.freeze({ family: 'openai-responses', parallel: true, strict: true, maxTools: 128, namePattern: '^[A-Za-z0-9_-]+$', maxNameLength: 64, maxDescriptionLength: 1024, malformedArguments: Object.freeze(['numeric-string']) }),
  anthropic: Object.freeze({ family: 'anthropic', parallel: true, strict: false, maxTools: 64, namePattern: '^[A-Za-z0-9_-]+$', maxNameLength: 64, maxDescriptionLength: 4096, malformedArguments: Object.freeze(['numeric-string']) }),
  gemini: Object.freeze({ family: 'gemini', parallel: true, strict: false, maxTools: 64, namePattern: '^[A-Za-z_][A-Za-z0-9_-]*$', maxNameLength: 64, maxDescriptionLength: 1024, malformedArguments: Object.freeze(['numeric-string']) }),
  'local-small': Object.freeze({ family: 'openai-chat', parallel: false, strict: false, maxTools: 8, namePattern: '^[A-Za-z0-9_-]+$', maxNameLength: 64, maxDescriptionLength: 1024, malformedArguments: Object.freeze(['unwrap-json-string', 'trailing-comma', 'numeric-string']) }),
});
const FALLBACK: Readonly<ModelQuirks> = Object.freeze({ ...QUIRKS['local-small']!, maxTools: 4 });
export function lookupQuirks(modelFamily: string): Readonly<ModelQuirks> { return QUIRKS[modelFamily] ?? FALLBACK; }
