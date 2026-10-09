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
export function configure(c: ConfigInput = {}): HostctlConfig {
  return { ...DEFAULT_CONFIG, ...c, shell: { ...DEFAULT_CONFIG.shell, ...c.shell }, exec: { timeoutMs: Math.max(1, Math.min(300000, c.exec?.timeoutMs ?? 30000)) }, output: { maxBytes: Math.max(32, Math.min(1048576, c.output?.maxBytes ?? 65536)) }, env: { allow: [...(c.env?.allow ?? DEFAULT_CONFIG.env.allow)] }, denyPatterns: [...(c.denyPatterns ?? [])], search: { maxResults: Math.max(1, Math.min(1000, c.search?.maxResults ?? 100)) } };
}
