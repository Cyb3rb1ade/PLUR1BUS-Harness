// SPDX-License-Identifier: MIT
/** Deterministic private seed expansion. Only tag, n and profile enter materialized input metadata. */
import { createHash } from "node:crypto";

/** Derive opaque public names, numeric constants and three distinct text-frame algorithms for the declared seeds. */
export function seedValues(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("seed must be uint32");
  const digest = createHash("sha256").update(String(seed)).digest();
  const tag = `item_${digest.subarray(0, 4).toString("hex")}`;
  const n = 3 + ((Math.imul(seed, 2654435761) >>> 0) % 11);
  return { seed, tag, n, profile: digest[0] % 3 };
}

/** Expand private semantic cases without deriving expected output from candidate code. */
export function expandCases(template, seed) {
  const { tag, n } = seedValues(seed);
  const values = {
    TAG: tag,
    TAGWORD: tag.replaceAll("_", " "),
    N: n,
    N2: n * 2,
    N3: n * 3,
    N4: n * 4,
    N5: n * 5,
    N6: n * 6,
    NM1: n - 1,
    NP1: n + 1,
    NP2: n + 2,
    NP3: n + 3,
    N100: n * 100,
    N119: n * 119,
    N119EUR: ((n * 119) / 100).toFixed(2),
    TAGLEN: Buffer.byteLength(tag),
    TAGHEX: Buffer.from(tag).toString("hex"),
    TAGSUM: [...Buffer.from(tag)]
      .reduce((a, b) => (a + b) % 256, 0)
      .toString(16)
      .padStart(2, "0"),
  };
  const expand = (value) =>
    value.replace(/__([A-Z0-9]+)__/g, (_, key) => {
      if (!(key in values)) throw new Error(`unknown seed placeholder ${key}`);
      return String(values[key]);
    });
  return Object.fromEntries(
    Object.entries(template).map(([scope, cases]) => [
      scope,
      cases.map(([input, expected], index) => ({
        id: `${scope}-${index + 1}`,
        input: expand(input),
        expected: expand(expected),
      })),
    ]),
  );
}

/** Public optional transport frame, independently implemented here for the host oracle. */
export function frameInput(input, seed) {
  const { n, profile } = seedValues(seed);
  const bytes = Buffer.from(input);
  const sum = [...bytes].reduce((total, value) => (total + value) % 256, n);
  const suffix = profile === 0 ? "" : profile === 1 ? `:${bytes.length}` : `:${bytes.length}:${sum}`;
  return `@TEXT${suffix}\n${input}`;
}

/** Add valid/invalid frame boundaries plus the authored coupled-prefix oracle, retaining every semantic case. */
export function checkedCases(template, seed, prefixes = {}) {
  const result = expandCases(template, seed);
  for (const [scope, cases] of Object.entries(result)) {
    const valid = cases.filter((item) => item.expected !== "error");
    const framed = valid.slice(0, 2);
    const preserved = valid.find((item) => item.input.includes("\r"));
    if (preserved && !framed.includes(preserved)) framed.push(preserved);
    for (const item of framed) {
      cases.push({ ...item, id: `${item.id}-frame`, input: frameInput(item.input, seed) });
    }
    cases.push({ id: `${scope}-frame-invalid`, input: "@TEXT:invalid\nvalue", expected: "error" });
    if (valid.length) {
      const input = valid[0].input;
      const { profile } = seedValues(seed);
      const framed = frameInput(input, seed);
      const end = framed.indexOf("\n");
      const fields = framed.slice(0, end).split(":");
      if (profile === 0) fields.push("0");
      else fields[profile] = String(Number(fields[profile]) + 1);
      cases.push({ id: `${scope}-frame-integrity`, input: fields.join(":") + "\n" + input, expected: "error" });
      if (prefixes[scope] && Object.keys(prefixes).indexOf(scope) > 0) {
        for (const state of ["stale", "corrupt"]) {
          cases.push({ id: `${scope}-state-${state}`, input, state, expected: "error" });
        }
      }
    }
    cases.push(...(prefixes[scope] ?? []));
  }
  return result;
}

/** Private generator helper, never copied into a candidate tree. */
export function instanceForSeed(seed) {
  return { taskId: "_shared", ...seedValues(seed) };
}
