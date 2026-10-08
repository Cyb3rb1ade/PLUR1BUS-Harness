// Defence in depth. Phone numbers, uuids and socket paths are personal data: the channel logs only short hashes of ids
// (see channel.ts), and this scrubber removes anything shaped like them from every string that reaches a log.
const E164 = /\+\d{7,15}/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SOCKET_PATH = /(?:\/[\w.@-]+){2,}\.sock\b|\/(?:run|var|tmp|home|Users)\/[^\s"']+/g;

export function redactString(s: string, ...known: readonly string[]): string {
  let out = s;
  for (const k of known) if (k) out = out.split(k).join("[redacted]");
  return out.replace(UUID, "[uuid]").replace(E164, "+[redacted]").replace(SOCKET_PATH, "[path]");
}

export function redactAttrs(
  attrs: Readonly<Record<string, string | number | boolean>>,
  ...known: readonly string[]
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) out[k] = typeof v === "string" ? redactString(v, ...known) : v;
  return out;
}
