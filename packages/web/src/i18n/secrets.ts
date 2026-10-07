// secrets area catalogue (Settings > Secrets): keys `secrets.<topic>`; en and de have the same keys and {placeholders}.
export const en = {} as const;

export const de: Record<keyof typeof en, string> = {};
