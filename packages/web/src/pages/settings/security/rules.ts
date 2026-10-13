// Settings > Security & Permissions: which rules the page shows and how a raw `config.get` value is turned into words. Only keys
// that exist in config.schema.json are listed. Everything the schema has no key for (how long an approval lives, whether the OS
// confirmation is required, the break-glass limits) is fixed in the core and is deliberately not shown here.
import type { Key } from "../../../i18n.ts";

export type RuleKind = "bool" | "publish";
export type Rule = {
  /** Dotted config key, read with `config.get`. */
  key: string;
  label: Key;
  hint: Key;
  kind: RuleKind;
  /** Where the key is changed, when the UI already has a convention for it (a config section). Everything else is read-only. */
  editIn?: string;
};

export const RULES: readonly Rule[] = [
  { key: "remote.publish", label: "settings.security.rule.remote", hint: "settings.security.rule.remote.hint", kind: "publish" },
  { key: "tools.hostctl.enabled", label: "settings.security.rule.hostctl", hint: "settings.security.rule.hostctl.hint", kind: "bool" },
  { key: "tools.hostctl.shell.allowed", label: "settings.security.rule.shell", hint: "settings.security.rule.shell.hint", kind: "bool" },
  { key: "extensions.allowUnsigned", label: "settings.security.rule.unsigned", hint: "settings.security.rule.unsigned.hint", kind: "bool", editIn: "extensions" },
  { key: "secrets.fileFallback.enabled", label: "settings.security.rule.fileFallback", hint: "settings.security.rule.fileFallback.hint", kind: "bool" },
];

const at = (o: unknown, key: string): unknown =>
  key.split(".").reduce<unknown>((a, s) => (typeof a === "object" && a !== null && !Array.isArray(a) ? (a as Record<string, unknown>)[s] : undefined), o);

export type Shown = { rule: Rule; state: "on" | "off" | "local" | "tailnet" | "network" | "other" | "unset" };

/** A rule's state from the running configuration (`config.get` without a key). Anything unexpected is "other"; a missing key "unset". */
export function stateOf(rule: Rule, config: unknown): Shown["state"] {
  const v = at(config, rule.key);
  if (v === undefined || v === null) return "unset";
  if (rule.kind === "bool") return v === true ? "on" : v === false ? "off" : "other";
  return v === "local" || v === "tailnet" || v === "network" ? v : "other";
}
