// Policy sources: D110 spec §2.5 / §5.8 and docs/provider-matrix.md §4; ADR-005 §6.3.
// These are public protocol identifiers/fingerprints, never credentials. Own dynamically issued
// registration values belong in the vault; no concrete issued ID is allowed in source fixtures.
export const FOREIGN_CLIENT_RULES = [
  { id: "foreign-client-id", source: "docs/superpowers/specs/2026-09-30-openai-auth-design.md §2.5.1", re: /\bapp_EMoamEEZ73f0CkXaXp7hrann\b|\boaiapp_[A-Za-z0-9_-]{8,}\b/ },
  { id: "codex-login-override", source: "D110 §2.5.1", re: /CODEX_APP_SERVER_LOGIN_CLIENT_ID/ },
  { id: "codex-request-fingerprint", source: "D110 §2.5.1–3", re: /codex_cli_simplified_flow|originator\s*[=:]\s*["']?codex_|(?:["']User-Agent["']|userAgent)\s*:\s*["']codex[_/ -]/i },
  { id: "official-system-prompt", source: "docs/provider-matrix.md §4 / ADR-005 §6.3", re: /You are Claude Code, Anthropic.s official CLI|You are Codex, (?:a|an) (?:coding |AI )?agent|You are Gemini CLI/ },
];
// No source-file exemptions. Positive controls construct fingerprint samples in scripts tests,
// outside product roots; runtime fixtures use distinctive redact-probe-* markers instead.
export const FOREIGN_CLIENT_EXCEPTIONS = new Map();
export function foreignClientFindings(path, text) {
  if (!/^(?:packages|crates|desktop|apps\/desktop)\//.test(path)) return [];
  return text.split(/\r?\n/).flatMap((line, index) => FOREIGN_CLIENT_RULES.filter(r => r.re.test(line) && !FOREIGN_CLIENT_EXCEPTIONS.get(path)?.includes(r.id)).map(r => ({ rule: r.id, line: index + 1, source: r.source })));
}
