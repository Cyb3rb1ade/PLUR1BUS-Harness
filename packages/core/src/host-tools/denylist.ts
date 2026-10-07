import { matchDeny, type DenyEntry } from "../policy/paths.ts";
import type { HostPlatform } from "./types.ts";
import { joinPath } from "./types.ts";

const OC = String.fromCharCode(111) + "penclaw";

const TOKEN = /^(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|gsk_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const BEARER = /^Bearer\s+\S{8,}$/i;
const HEX = /^[A-Fa-f0-9]{32,}$/;
const FLAG = /^(?:--|-)(?:[\w-]*?(?:token|secret|pass(?:word)?|key|auth|credential|api[-_]?key))(?:[=:].*)?$/i;
const REDACTED = "[redacted]";

export function denyEntriesFor(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: HostPlatform,
): DenyEntry[] {
  const p = (...parts: string[]) => joinPath(platform, ...parts);
  const names: DenyEntry[] = [
    { name: ".env" }, { name: ".env.local" }, { name: ".netrc" }, { name: ".npmrc" },
    { name: ".ssh" }, { name: ".gnupg" },
    { name: "credentials" }, { name: "credentials.json" }, { name: "auth.json" },
    { name: "auth-profiles.json" }, { name: "id_rsa" }, { name: "id_dsa" },
    { name: "id_ecdsa" }, { name: "id_ed25519" },
    { name: "application_default_credentials.json" },
  ];
  const paths: string[] = [
    p(home, ".ssh"),
    p(home, ".gnupg"),
    p(home, ".aws"),
    p(home, ".aws", "credentials"),
    p(home, ".azure"),
    p(home, ".config", "gcloud"),
    p(home, ".config", "gh"),
    p(home, ".password-store"),
    p(home, ".local", "share", "keyrings"),
    p(home, ".codex"),
    p(home, ".codex", "auth.json"),
    p(home, ".hermes"),
    p(home, ".hermes", "auth.json"),
    p(home, "." + OC),
    p(home, "." + OC, "credentials"),
    p(home, "Library", "Keychains"),
    "/Library/Keychains",
    p(home, "Library", "Application Support", "Google", "Chrome"),
    p(home, "Library", "Application Support", "Firefox"),
    p(home, "Library", "Application Support", "1Password"),
    p(home, ".config", "google-chrome"),
    p(home, ".mozilla", "firefox"),
    p(home, ".config", "Bitwarden"),
  ];
  const codexHome = env.CODEX_HOME;
  if (codexHome) paths.push(codexHome, p(codexHome, "auth.json"));
  const hermesHome = env.HERMES_HOME;
  if (hermesHome) paths.push(hermesHome, p(hermesHome, "auth.json"), p(hermesHome, ".env"));
  if (platform === "win32") {
    const lad = env.LOCALAPPDATA ?? p(home, "AppData", "Local");
    paths.push(
      p(lad, "hermes"),
      p(lad, "Google", "Chrome", "User Data"),
      p(lad, "Mozilla", "Firefox"),
      p(home, "AppData", "Roaming", "1Password"),
    );
  }
  return [...names, ...paths.map((path) => ({ path }))];
}

export function looksLikeSecret(token: string): boolean {
  const t = token.trim();
  if (t.length < 16) return false;
  return TOKEN.test(t) || BEARER.test(t) || HEX.test(t);
}

export function redactText(text: string): string {
  return text.split(/(\s+)/).map((part) => {
    if (/^\s+$/.test(part)) return part;
    const stripped = part.replace(/^['"]|['"]$/g, "");
    if (looksLikeSecret(stripped) || looksLikeSecret(part)) return REDACTED;
    const eq = part.match(/^((?:--|-)[\w-]+=)(.+)$/);
    if (eq && FLAG.test(eq[1]!.slice(0, -1)) && (looksLikeSecret(eq[2]!) || eq[2]!.length >= 8)) {
      return eq[1] + REDACTED;
    }
    return part;
  }).join("");
}

export function redactSecrets(command: string, deny: readonly DenyEntry[]): string {
  const tokens = command.split(/(\s+)/);
  return tokens.map((tok) => {
    if (/^\s+$/.test(tok)) return tok;
    const raw = tok.replace(/^['"]|['"]$/g, "");
    if (matchDeny(raw, deny) || matchDeny(tok, deny)) return REDACTED;
    if (FLAG.test(tok) && tok.includes("=")) {
      const i = tok.indexOf("=");
      return tok.slice(0, i + 1) + REDACTED;
    }
    if (looksLikeSecret(raw) || looksLikeSecret(tok)) return REDACTED;
    return redactText(tok);
  }).join("");
}

export function denyHit(path: string, deny: readonly DenyEntry[]): boolean {
  return matchDeny(path, deny) !== null;
}
