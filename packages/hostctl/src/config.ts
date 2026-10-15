export interface HostctlConfig {
  enabled: boolean; shell: { allowed: boolean; default: 'bash' | 'zsh' | 'pwsh' };
  exec: { timeoutMs: number }; output: { maxBytes: number }; env: { allow: string[] };
  denyPatterns: string[]; search: { maxResults: number };
}
export type ConfigInput = { [K in keyof HostctlConfig]?: HostctlConfig[K] extends unknown[] ? HostctlConfig[K] : HostctlConfig[K] extends object ? Partial<HostctlConfig[K]> : HostctlConfig[K] };
export const DEFAULT_CONFIG: HostctlConfig = {
  enabled: true, shell: { allowed: false, default: 'bash' },
  exec: { timeoutMs: 30000 }, output: { maxBytes: 65536 },
  env: { allow: ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'SystemRoot', 'PATHEXT', 'TEMP', 'TMP'] },
  denyPatterns: [], search: { maxResults: 100 },
};
/** A number inside [lo, hi]; anything that is not a finite number (NaN, a string, an object, undefined) is the default. */
const bounded = (v: unknown, fallback: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback);
const list = (v: unknown, fallback: string[]): string[] => (Array.isArray(v) && v.every(x => typeof x === 'string') ? [...v] : [...fallback]);
export function configure(c: ConfigInput = {}): HostctlConfig {
  return { ...DEFAULT_CONFIG, ...c, shell: { ...DEFAULT_CONFIG.shell, ...c.shell }, exec: { timeoutMs: bounded(c.exec?.timeoutMs, 30000, 1, 300000) }, output: { maxBytes: bounded(c.output?.maxBytes, 65536, 32, 1048576) }, env: { allow: list(c.env?.allow, DEFAULT_CONFIG.env.allow) }, denyPatterns: list(c.denyPatterns, []), search: { maxResults: bounded(c.search?.maxResults, 100, 1, 1000) } };
}
