import { FAKE_APP_TOKEN, FAKE_BOT_TOKEN, FAKE_SOCKET_URL } from "./fake-slack.ts";

/**
 * Plain-substring leak scanner for the redaction catalogue. It deliberately shares nothing with src/redact.ts: that module is
 * the object under test, so the expectations here are written independently of it.
 *
 * Why the markers are parts of the existing fake tokens and not free text: the channel validates the xoxb-/xapp- shape of a
 * secret before it uses it, so a free-text marker would be rejected at start and never travel through the code under test.
 * The marker therefore has to live inside a well-formed token. The part after the prefix is what is checked, because the
 * prefix alone is not a secret. Every character of these tokens is [A-Za-z0-9-], so a JSON or URL-encoded copy of a marker
 * is byte-identical to the plain one and a plain substring search cannot be dodged by escaping.
 */
export interface Marker {
  label: string;
  value: string;
}

const afterPrefix = (token: string): string => token.slice(token.indexOf("-") + 1);
const distinctive = (token: string): string => token.split("-").at(-1)!;

export const BOT_DISTINCTIVE = distinctive(FAKE_BOT_TOKEN);
export const APP_DISTINCTIVE = distinctive(FAKE_APP_TOKEN);
/**
 * Leading fragments. The channel logs a 40-character window of one server-supplied string (the Socket Mode disconnect
 * reason), and 40 characters of a token is shorter than the whole distinctive part but still 20 characters of secret.
 * A full-marker scan alone would call that clean, so the first 12 characters are markers of their own.
 */
const FRAGMENT = 12;
export const BOT_FRAGMENT = BOT_DISTINCTIVE.slice(0, FRAGMENT);
export const APP_FRAGMENT = APP_DISTINCTIVE.slice(0, FRAGMENT);
export const SOCKET_TICKET = new URL(FAKE_SOCKET_URL).searchParams.get("ticket")!;

export const MARKERS: readonly Marker[] = [
  { label: "bot token (distinctive part)", value: BOT_DISTINCTIVE },
  { label: "bot token (everything after the prefix)", value: afterPrefix(FAKE_BOT_TOKEN) },
  { label: "app token (distinctive part)", value: APP_DISTINCTIVE },
  { label: "app token (everything after the prefix)", value: afterPrefix(FAKE_APP_TOKEN) },
  { label: "bot token (leading fragment)", value: BOT_FRAGMENT },
  { label: "app token (leading fragment)", value: APP_FRAGMENT },
  { label: "socket mode ticket", value: SOCKET_TICKET },
  { label: "socket mode url", value: FAKE_SOCKET_URL },
];

/** Label of the first marker found in `haystack` (plain, case-sensitive substring search), or undefined. */
export function findMarker(haystack: string, markers: readonly Marker[] = MARKERS): string | undefined {
  for (const m of markers) if (m.value !== "" && haystack.includes(m.value)) return m.label;
  return undefined;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

/** Everything an error exposes to a reader: name, message, own enumerable fields (code, status, ...), the whole cause chain. */
export function errorText(err: unknown, depth = 0): string {
  if (err === undefined || err === null) return "";
  if (depth > 6) return "[cause chain too deep]";
  if (err instanceof Error) {
    const parts = [err.name, err.message, safeJson({ ...err }), errorText(err.cause, depth + 1)];
    if (err instanceof AggregateError) for (const inner of err.errors) parts.push(errorText(inner, depth + 1));
    return parts.join("\n");
  }
  return typeof err === "string" ? err : safeJson(err);
}

const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\]+/gi;

/** Every scheme://... run in a text, as written. */
export function urlsIn(text: string): string[] {
  return text.match(URL_IN_TEXT) ?? [];
}

/** Reasons a URL must not be present in a log line: it carries a marker, a query string, or credentials. */
export function urlProblems(url: string, markers: readonly Marker[] = MARKERS): string[] {
  const problems: string[] = [];
  const hit = findMarker(url, markers);
  if (hit) problems.push(`contains the ${hit}`);
  if (url.includes("?")) problems.push("carries a query string (Socket Mode puts its ticket there)");
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(url)) problems.push("carries credentials in the authority");
  return problems;
}
