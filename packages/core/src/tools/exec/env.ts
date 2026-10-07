// The child's environment: built from an allowlist of names, never inherited wholesale.
import { ExecFailure } from "./types.ts";

export const DEFAULT_ENV_ALLOW: readonly string[] = Object.freeze([
  "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM",
  // Windows cannot start most programs without these.
  "SystemRoot", "SYSTEMROOT", "PATHEXT", "COMSPEC", "TEMP", "TMP",
]);

// RULING: even a name the person allowlisted is not passed *from the inherited environment* when it looks like a
// credential; a secret reaches a child only as an explicit request value, which the caller sees in the audit names.
const SECRETISH = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|(^|_)KEY$|AUTH|COOKIE|SESSION)/i;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isSecretishName(name: string): boolean {
  return SECRETISH.test(name);
}

export function buildEnv(o: {
  allow: readonly string[];
  base: Readonly<Record<string, string | undefined>>;
  requested?: Readonly<Record<string, string>> | undefined;
  windows: boolean;
}): Record<string, string> {
  const fold = (s: string) => (o.windows ? s.toUpperCase() : s);
  const allowed = new Set(o.allow.map(fold));
  const out = new Map<string, [string, string]>(); // folded -> [name, value]
  for (const [name, value] of Object.entries(o.base)) {
    if (value === undefined || !allowed.has(fold(name)) || isSecretishName(name)) continue;
    out.set(fold(name), [name, value]);
  }
  for (const [name, value] of Object.entries(o.requested ?? {})) {
    if (!NAME.test(name)) throw new ExecFailure("env-refused", `invalid environment variable name`);
    if (!allowed.has(fold(name))) throw new ExecFailure("env-refused", `environment variable ${name} is not on the allowlist`);
    if (typeof value !== "string" || value.includes("\0")) throw new ExecFailure("env-refused", `invalid value for ${name}`);
    out.set(fold(name), [name, value]);
  }
  return Object.fromEntries([...out.values()]);
}
