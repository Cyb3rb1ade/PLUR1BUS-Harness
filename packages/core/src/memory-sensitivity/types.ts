export const SENSITIVITY_CATEGORIES = [
  "health",
  "financial",
  "credential",
  "identity",
  "personal",
] as const;

export type SensitivityCategory = (typeof SENSITIVITY_CATEGORIES)[number];

export const SENSITIVITY_SOURCES = ["rule", "manual", "model"] as const;
export type SensitivitySource = (typeof SENSITIVITY_SOURCES)[number];

export function isSensitivityCategory(cat: string): cat is SensitivityCategory {
  return (SENSITIVITY_CATEGORIES as readonly string[]).includes(cat);
}

export interface MemorySensitivityRecord {
  cardId: string;
  contentHash: string;
  categories: SensitivityCategory[];
  source: SensitivitySource;
  updatedAt: number;
}
