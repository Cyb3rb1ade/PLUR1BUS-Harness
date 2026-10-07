export const MODEL_CLASSES = ['small', 'medium', 'large', 'frontier'] as const;
export type ModelClass = typeof MODEL_CLASSES[number];
export type ClassDistribution = Record<ModelClass, number>;
/** Profile labels, not live vendor model IDs. Deployment maps allowed profiles into these rows. */
export const CLASS_TABLE: Readonly<Record<string, Readonly<Partial<Record<ModelClass, string>>>>> = Object.freeze({
  openai: Object.freeze({ small: 'fast', medium: 'general', large: 'reasoning', frontier: 'frontier' }),
  anthropic: Object.freeze({ small: 'haiku', medium: 'sonnet', large: 'opus', frontier: 'frontier' }),
  google: Object.freeze({ small: 'flash-lite', medium: 'flash', large: 'pro', frontier: 'frontier' }),
  xai: Object.freeze({ small: 'fast', medium: 'general', large: 'reasoning', frontier: 'frontier' }),
  deepseek: Object.freeze({ small: 'fast', medium: 'chat', large: 'reasoner' }),
  openrouter: Object.freeze({ small: 'fast', medium: 'general', large: 'reasoning', frontier: 'frontier' }),
  local: Object.freeze({ small: '3-8b', medium: '14-32b', large: '70b-plus' }),
});
export function resolveClass(modelClass: ModelClass, providers: readonly string[], allowedProfiles: ReadonlySet<string>): { provider: string; profile: string } | undefined {
  for (const provider of providers) { const profile = CLASS_TABLE[provider]?.[modelClass]; if (profile && allowedProfiles.has(`${provider}:${profile}`)) return { provider, profile }; } return undefined;
}
