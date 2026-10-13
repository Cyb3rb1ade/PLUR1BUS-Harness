/**
 * Plain substring scanner for secret markers. Test-only.
 *
 * Deliberately independent of the package's own redact.ts: that file is the thing under test, so it must not decide what counts
 * as a leak. Everything here is `String.prototype.includes` over a recursive walk of the values a channel hands to the outside.
 */
export interface Needle {
  label: string;
  value: string;
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/** The spellings of one secret that count as a leak: as is, as base64, and as the AUTH PLAIN blob for `user`. */
export function needlesFor(marker: string, user: string): Needle[] {
  return [
    { label: `${marker} (raw)`, value: marker },
    { label: `${marker} (base64)`, value: b64(marker) },
    { label: `${marker} (AUTH PLAIN blob)`, value: b64(`\0${user}\0${marker}`) },
  ];
}

/**
 * Walks strings, numbers, arrays, maps, sets, byte buffers, plain objects (keys and values) and Error instances (name, message,
 * stack, cause, own properties) and returns one entry per hit: `<path>: <needle label>`. An empty list means nothing was found.
 * `JSON.stringify(new Error(...))` is `{}`, which is why errors are read field by field here.
 */
export function findLeaks(root: unknown, needles: readonly Needle[]): string[] {
  const hits: string[] = [];
  const seen = new WeakSet<object>();
  const check = (text: string, path: string): void => {
    for (const n of needles) if (text.includes(n.value)) hits.push(`${path}: ${n.label}`);
  };
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") return check(v, path);
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return check(String(v), path);
    if (typeof v === "symbol") return check(v.description ?? "", path);
    if (typeof v !== "object" || v === null) return;
    if (seen.has(v)) return;
    seen.add(v);
    if (v instanceof Uint8Array) return check(Buffer.from(v).toString("latin1"), path);
    if (v instanceof Error) {
      check(v.name, `${path}.name`);
      check(v.message, `${path}.message`);
      if (typeof v.stack === "string") check(v.stack, `${path}.stack`);
      if ("cause" in v) walk(v.cause, `${path}.cause`);
      if (v instanceof AggregateError) v.errors.forEach((e, i) => walk(e, `${path}.errors[${i}]`));
    }
    if (v instanceof Map) {
      for (const [k, val] of v) {
        walk(k, `${path}.<map key>`);
        walk(val, `${path}.<map value>`);
      }
      return;
    }
    if (v instanceof Set) {
      for (const val of v) walk(val, `${path}.<set item>`);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    for (const k of Object.keys(v)) {
      check(k, `${path}.<key ${k.length > 40 ? `${k.slice(0, 40)}...` : k}>`);
      walk((v as Record<string, unknown>)[k], `${path}.${k}`);
    }
  };
  walk(root, "$");
  return hits;
}
