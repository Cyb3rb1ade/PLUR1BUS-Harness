import { createHash } from "node:crypto";

/** Text rendered into a prompt zone: NFC, LF line ends, no lone surrogates (they would reach JSON as `\ud83d`, which
 *  serde_json refuses, and they make the byte stream depend on how a string was sliced). RULING: CRLF and CR become LF. */
export function normalizeText(text: string): string {
  return text.toWellFormed().normalize("NFC").replace(/\r\n?/g, "\n");
}

const utf8 = (s: string): Buffer => Buffer.from(s, "utf8");

/** Code-point order of two NFC strings = byte order of their UTF-8, unlike `<`, which compares UTF-16 code units. */
const byCodePoint = (a: string, b: string): number => Buffer.compare(utf8(a), utf8(b));

function render(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return JSON.stringify(normalizeText(value));
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`);
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "object": break;
    default: throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new TypeError("canonicalJson: cycle");
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((v) => {
        if (v === undefined) throw new TypeError("canonicalJson: undefined array item");
        return render(v, seen);
      }).join(",")}]`;
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("canonicalJson: only plain objects and arrays");
    const entries = Object.entries(obj as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [normalizeText(k), v] as const)
      .sort(([a], [b]) => byCodePoint(a, b));
    for (let i = 1; i < entries.length; i += 1) {
      if (entries[i]![0] === entries[i - 1]![0]) throw new TypeError(`canonicalJson: duplicate key after normalisation: ${entries[i]![0]}`);
    }
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${render(v, seen)}`).join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/**
 * ADR-010 R3, deterministic serialisation: sorted keys (code-point order, every depth), NFC strings, well-formed UTF-16,
 * finite numbers in V8's shortest round-trip form with `-0` as `0`, no whitespace. `undefined` object properties are
 * omitted (optional fields); anything JSON cannot express (non-finite numbers, bigint, functions, Date/Map, cycles)
 * is refused rather than guessed at, because a guess here becomes a silent cache miss.
 */
export function canonicalJson(value: unknown): string {
  return render(value, new Set());
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(utf8(text)).digest("hex");
}
