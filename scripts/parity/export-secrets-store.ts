// Parity vectors (mode V) for the stateful parts of the secret store (P4-20, library): the redaction registry
// (`secrets/redaction.ts`: named slots, groups, the bound of retired values, subscribers, `mask`, `contains`) and the encrypted
// file backend (`secrets/file-backend.ts`: the bytes of `store.json` and `store.key` after every operation).
// `crates/plur1bus-core/src/secrets/store_vectors.rs` replays every file. Recorded, never edited by hand.
//
// REGISTRY. A scenario is a list of steps. After every step the fixture holds what the registry answers: `values` (the
// pinned ones, then the retired ones, oldest first), the `events` a subscribed sink heard during the step (`[value, pinned]`)
// and, for `mask` and `contains`, the `result`. Steps:
//   ["register", value, name | null]         `register(value, name)`
//   ["many", prefix, from, count]            `register(prefix + 4 digits)` for `count` numbers, without a name
//   ["rotate", prefix, from, count, name]    the same values, one after the other, as the value of one name
//   ["group", label, [values]]               `replaceGroup(symbol of label, values)`
//   ["mask", text], ["contains", text], ["subscribe"], ["unsubscribe"]
// A scenario with a `note` records a place where the Rust registry deliberately differs (P4D-26); the replay says how.
//
// The values are plain words, never credential-shaped. Characters that the file transport or an editor could change
// (U+00A0, U+FEFF, U+0085, an emoji) are built from their code points.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-secrets-store.ts [--check]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";

const SRC = "../../packages/core/src/secrets";
const { createSecretRedaction, MAX_REGISTERED_SECRETS } = await import(`${SRC}/redaction.ts`);
const { createFileBackend, FILE_SCHEMA, MAX_TOMBSTONES } = await import(`${SRC}/file-backend.ts`);
const { SecretError } = await import(`${SRC}/types.ts`);

const ch = (...points: number[]): string => String.fromCodePoint(...points);
const NBSP = ch(0xa0), BOM = ch(0xfeff), NEL = ch(0x85), EMOJI = ch(0x1f600);

// --- registry ----------------------------------------------------------------------------------------------------------------
type Step =
  | ["register", string, string | null]
  | ["many", string, number, number]
  | ["rotate", string, number, number, string]
  | ["group", string, string[]]
  | ["mask", string]
  | ["contains", string]
  | ["subscribe"]
  | ["unsubscribe"];

const numbered = (prefix: string, i: number): string => `${prefix}${String(i).padStart(4, "0")}`;

function runRegistry(sc: { name: string; note?: string; steps: Step[] }) {
  const r = createSecretRedaction();
  const groups = new Map<string, symbol>();
  const group = (label: string): symbol => { let g = groups.get(label); if (!g) { g = Symbol(label); groups.set(label, g); } return g; };
  let events: [string, boolean][] = [];
  const sink = (value: string, info: { pinned: boolean }): void => { events.push([value, info.pinned]); };
  let off: (() => void) | undefined;
  const steps = sc.steps.map((op) => {
    events = [];
    let result: unknown;
    switch (op[0]) {
      case "register": r.register(op[1], op[2] ?? undefined); break;
      case "many": for (let i = op[2]; i < op[2] + op[3]; i++) r.register(numbered(op[1], i)); break;
      case "rotate": for (let i = op[2]; i < op[2] + op[3]; i++) r.register(numbered(op[1], i), op[4]); break;
      case "group": r.replaceGroup(group(op[1]), op[2]); break;
      case "mask": result = r.mask(op[1]); break;
      case "contains": result = r.contains(op[1]); break;
      case "subscribe": off = r.subscribe(sink); break;
      case "unsubscribe": off?.(); off = undefined; break;
    }
    return { op, ...(result !== undefined ? { result } : {}), events, values: [...r.values()] };
  });
  return { name: sc.name, ...(sc.note ? { note: sc.note } : {}), steps };
}

function buildRegistry() {
  const A = "alpha-value-one", B = "bravo-value-two", C = "charlie-value-three", D = "delta-value-four", E = "echo-value-five";
  const HEADER = "Bearer fixture-words-for-a-header";
  const BARE = "fixture-words-for-a-header";
  const scenarios: { name: string; note?: string; steps: Step[] }[] = [
    { name: "length-is-counted-in-utf16-units", steps: [
      ["subscribe"],
      ["register", "short", null],
      ["register", "sevench", null],
      ["register", "eightchr", null],
      ["register", "eightchr", null],
      ["register", EMOJI.repeat(4), null],
      ["register", `${EMOJI.repeat(3)}x`, null],
      ["register", "", null],
      ["register", "nameless-value", ""],
      ["contains", "an eightchr in a line"], ["contains", "eightch"], ["contains", ""],
      ["mask", `x eightchr y ${EMOJI.repeat(4)} z sevench`],
    ] },
    { name: "a-header-value-registers-its-bare-credential", steps: [
      ["subscribe"],
      ["register", HEADER, null],
      ["register", "bearer lower-case-scheme-words", null],
      ["register", "BASIC upper-case-scheme-words", null],
      ["register", `Basic${NBSP}no-break-space-words`, null],
      ["register", `Bearer\t\n tab-newline-space-words`, null],
      ["register", `Bearer${BOM}byte-order-mark-words`, null],
      ["register", `Bearer${NEL}next-line-is-no-space`, null],
      ["register", "Bearerno-space-after-scheme", null],
      ["register", "Bearer tiny", null],
      ["register", "Basic  ", null],
      ["register", "Token not-a-known-scheme-words", null],
      ["register", "xBearer scheme-not-at-the-start", null],
      ["mask", `Authorization: ${HEADER} and ${BARE} alone`],
    ] },
    { name: "a-name-pins-its-current-value-and-retires-the-old-one", steps: [
      ["subscribe"],
      ["register", A, "api"],
      ["register", A, "api"],
      ["register", B, "api"],
      ["register", A, "other"],
      ["register", C, "other"],
      ["register", B, "second"],
      ["register", D, "api"],
      ["register", E, "second"],
      ["register", "short", "api"],
      ["register", HEADER, "hdr"],
      ["register", BARE, "hdr"],
      ["register", HEADER, "hdr"],
      ["register", "Bearer tiny", "hdr2"],
      ["register", D, null],
    ] },
    { name: "groups-are-replaced-as-a-whole-and-never-collide-with-names", steps: [
      ["subscribe"],
      ["group", "startup", [A, B]],
      ["group", "startup", [B, A]],
      ["group", "startup", [B, C]],
      ["group", "config", [C, "short", HEADER, C]],
      ["register", D, "startup"],
      ["group", "startup", []],
      ["group", "startup", []],
      ["group", "config", ["tiny", ""]],
      ["group", "config", [A]],
      ["register", A, "startup"],
      ["group", "config", []],
    ] },
    { name: "retired-values-are-bounded-pinned-ones-are-not", steps: [
      ["register", A, "kept"],
      ["group", "startup", [B]],
      ["subscribe"],
      ["many", "anonymous-value-", 0, MAX_REGISTERED_SECRETS + 44],
      ["unsubscribe"],
      ["rotate", "rotating-value-", 0, MAX_REGISTERED_SECRETS + 5, "refresh"],
      ["contains", `first ${numbered("anonymous-value-", 0)}`],
      ["contains", `kept ${A} and ${B}`],
      ["contains", `current ${numbered("rotating-value-", MAX_REGISTERED_SECRETS + 4)}`],
      ["contains", `oldest rotated ${numbered("rotating-value-", 0)}`],
    ] },
    { name: "a-late-subscriber-hears-what-is-known-and-nothing-after-it-left", steps: [
      ["register", A, "api"],
      ["register", B, null],
      ["register", C, "api"],
      ["subscribe"],
      ["register", D, null],
      ["unsubscribe"],
      ["register", E, null],
      ["unsubscribe"],
    ] },
    { name: "mask-replaces-the-longest-value-first", steps: [
      ["register", "abcdefgh", null],
      ["register", "abcdefghij", "long"],
      ["register", "hijklmno", null],
      ["register", "[redacted]", null],
      ["mask", "x abcdefghij y abcdefgh z abcdefghijklmno"],
      ["mask", "nothing to mask here"],
      ["mask", "already [redacted] stays"],
      ["mask", ""],
    ] },
    { name: "a-retired-value-registered-again", note: "P4D-26: TypeScript leaves a retired value where it is when it is registered again; Rust moves it to the newest place, so the values are the same set in another order", steps: [
      ["register", A, null],
      ["register", B, null],
      ["register", A, null],
      ["register", C, null],
    ] },
  ];
  return { maxRegistered: MAX_REGISTERED_SECRETS, scenarios: scenarios.map(runRegistry) };
}

// --- file backend ----------------------------------------------------------------------------------------------------------------
// A scenario runs against a fresh directory. `random` is scripted (draw k is the bytes k*16, k*16+1, ...: a counting pattern, never
// a real key); every draw of a step is recorded (`draws`, hex), and the Rust replay feeds exactly those. After every step the
// fixture holds the text of `store.json` and `store.key` (`null` when absent): with the same draws Rust writes the same bytes.
// Steps:
//   ["probe"], ["get", name], ["list"], ["tombstones"], ["clear", name]
//   ["put", name, value, nowMs, updatedBy | null, description | null]   (null is "not given"; "" clears)
//   ["describe", name, text, nowMs, updatedBy | null]
//   ["delete", name, tombstoneMs | null]
//   ["seed", { store?: text | null, key?: text | null }]                (writes or removes a file as it is; recorded as given)
// A `{ tamper, with }` step of a scenario below rewrites the current file with a function; the fixture records the result as a seed.
type FStep =
  | ["probe"] | ["get", string] | ["list"] | ["tombstones"] | ["clear", string]
  | ["put", string, string, number, string | null, string | null]
  | ["describe", string, string, number, string | null]
  | ["delete", string, number | null]
  | ["seed", { store?: string | null; key?: string | null }]
  | { tamper: "store" | "key"; with: (text: string) => string };

async function runFile(sc: { name: string; maxTombstones?: number; steps: FStep[] }) {
  const root = mkdtempSync(join(tmpdir(), "p1b-secrets-vectors-"));
  const dir = join(root, "secrets");
  let drawn = 0;
  let draws: string[] = [];
  const random = (n: number): Buffer => {
    const bytes = Buffer.alloc(n);
    for (let i = 0; i < n; i++) bytes[i] = (drawn * 16 + i) & 0xff;
    drawn++;
    draws.push(bytes.toString("hex"));
    return bytes;
  };
  const backend = createFileBackend({ dir, secure: (() => undefined) as any, random, ...(sc.maxTombstones !== undefined ? { maxTombstones: sc.maxTombstones } : {}) });
  const FILES = { store: "store.json", key: "store.key" } as const;
  const text = (file: string): string | null => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : null);
  const steps: unknown[] = [];
  try {
    for (const given of sc.steps) {
      const step: Exclude<FStep, { tamper: string }> = Array.isArray(given) ? given : ["seed", { [given.tamper]: given.with(text(FILES[given.tamper]) ?? "") }];
      draws = [];
      const registered: string[] = [];
      const register = (value: string): void => { registered.push(value); };
      let result: unknown;
      try {
        switch (step[0]) {
          case "probe": result = { ok: await backend.probe() }; break;
          case "get": result = { ok: await backend.get(step[1]) }; break;
          case "list": result = { ok: await backend.list() }; break;
          case "tombstones": result = { ok: await backend.tombstones() }; break;
          case "clear": await backend.clearTombstone(step[1]); result = { ok: null }; break;
          case "put": result = { ok: await backend.put(step[1], step[2], new Date(step[3]), step[4] ?? undefined, step[5] ?? undefined, register) }; break;
          case "describe": result = { ok: await backend.describe(step[1], step[2], new Date(step[3]), step[4] ?? undefined, register) }; break;
          case "delete": result = { ok: await backend.delete(step[1], step[2] === null ? undefined : new Date(step[2])) }; break;
          case "seed":
            mkdirSync(dir, { recursive: true });
            for (const which of ["store", "key"] as const) {
              const value = step[1][which];
              if (value === null) rmSync(join(dir, FILES[which]), { force: true });
              else if (value !== undefined) writeFileSync(join(dir, FILES[which]), value);
            }
            result = { ok: null };
            break;
        }
      } catch (e: any) {
        result = e instanceof SecretError ? { err: { code: e.code, message: e.message, detail: { ...e.detail } } } : { throw: e?.name ?? typeof e };
      }
      steps.push({ op: step, result, registered, draws, store: text("store.json"), key: text("store.key") });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { name: sc.name, ...(sc.maxTombstones !== undefined ? { maxTombstones: sc.maxTombstones } : {}), steps };
}

async function buildFileBackend() {
  const T0 = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
  const MIN = 60_000;
  const INVALID_TIME = 8.64e15 + 1;
  const V1 = "the first value in plain words", V2 = "a second value after rotation", V3 = `caf${ch(0xe9)} ${EMOJI} unicode value`;
  const edit = (fn: (doc: any) => any) => (text: string): string => JSON.stringify(fn(JSON.parse(text)));
  const otherKey = `${Buffer.alloc(32, 0x41).toString("base64")}\n`;
  const corruptStores: [string, string][] = [
    ["not-json", "this is not json"],
    ["empty-file", ""],
    ["json-null", "null"],
    ["json-array", "[]"],
    ["empty-object", "{}"],
    ["other-schema", JSON.stringify({ schema: "plur1bus.secrets-file/2", entries: {} })],
    ["entries-array", JSON.stringify({ schema: FILE_SCHEMA, entries: [] })],
    ["entries-null", JSON.stringify({ schema: FILE_SCHEMA, entries: null })],
    ["entries-string", JSON.stringify({ schema: FILE_SCHEMA, entries: "x" })],
    ["entry-not-an-object", JSON.stringify({ schema: FILE_SCHEMA, entries: { api: "x" } })],
    ["entry-null", JSON.stringify({ schema: FILE_SCHEMA, entries: { api: null } })],
    ["entry-array", JSON.stringify({ schema: FILE_SCHEMA, entries: { api: [] } })],
    ["entry-without-tag", JSON.stringify({ schema: FILE_SCHEMA, entries: { api: { createdAt: "a", updatedAt: "b", nonce: "c", ct: "d" } } })],
    ["entry-with-a-number-description", JSON.stringify({ schema: FILE_SCHEMA, entries: { api: { createdAt: "a", updatedAt: "b", nonce: "c", ct: "d", tag: "e", description: 7 } } })],
    ["entry-with-a-name-that-is-none", JSON.stringify({ schema: FILE_SCHEMA, entries: { ok: { createdAt: "a", updatedAt: "b", nonce: "c", ct: "d", tag: "e" }, " bad": {} } })],
    ["second-entry-bad", JSON.stringify({ schema: FILE_SCHEMA, entries: { ok: { createdAt: "a", updatedAt: "b", nonce: "c", ct: "d", tag: "e" }, worse: 1 } })],
    ["tombstones-null", JSON.stringify({ schema: FILE_SCHEMA, entries: {}, tombstones: null })],
    ["tombstones-array", JSON.stringify({ schema: FILE_SCHEMA, entries: {}, tombstones: [] })],
    ["tombstone-with-a-name-that-is-none", JSON.stringify({ schema: FILE_SCHEMA, entries: {}, tombstones: { "bad name": "2026-01-01T00:00:00.000Z" } })],
    ["tombstone-time-not-a-string", JSON.stringify({ schema: FILE_SCHEMA, entries: {}, tombstones: { api: 5 } })],
    ["byte-order-mark", `${BOM}${JSON.stringify({ schema: FILE_SCHEMA, entries: {} })}`],
    ["trailing-text", `${JSON.stringify({ schema: FILE_SCHEMA, entries: {} })} x`],
  ];
  const scenarios: { name: string; maxTombstones?: number; steps: FStep[] }[] = [
    { name: "round-trip-format-and-member-order", steps: [
      ["probe"], ["get", "api"], ["list"], ["tombstones"], ["delete", "api", null], ["clear", "api"],
      ["put", "api", V1, T0, "owner-1", "what the api credential is for"],
      ["get", "api"],
      ["put", "zeta", V3, T0 + MIN, null, null],
      ["put", "123", "a value under a numeric name", T0 + 2 * MIN, "", ""],
      ["put", "7", "a value under another numeric name", T0 + 3 * MIN, "owner-2", null],
      ["put", "Api", "a value under a capital name", T0 + 4 * MIN, null, "  kept with its spaces  "],
      ["list"], ["get", "zeta"], ["get", "123"], ["get", "7"],
      ["put", "api", V2, T0 + 5 * MIN, null, null],
      ["get", "api"],
      ["put", "api", V2, T0 + 6 * MIN, "owner-3", ""],
      ["put", "api", V1, T0 + 7 * MIN, null, "a new description"],
      ["describe", "api", "   trimmed by describe   ", T0 + 8 * MIN, null],
      ["describe", "api", "by another writer", T0 + 9 * MIN, "owner-4"],
      ["describe", "zeta", "the first description of zeta", T0 + 10 * MIN, "owner-4"],
      ["describe", "api", "", T0 + 11 * MIN, null],
      ["describe", "missing", "nothing to describe", T0 + 12 * MIN, null],
      ["list"],
      ["delete", "7", null], ["delete", "7", null], ["delete", "missing", T0],
      ["list"], ["probe"],
    ] },
    { name: "tombstones-are-bounded-and-cleared-by-a-write", maxTombstones: 3, steps: [
      ...["a1", "b2", "c3", "d4", "e5", "f6"].map((n, i): FStep => ["put", n, `the value of ${n} in words`, T0 + i, null, null]),
      ["delete", "a1", T0 + 100], ["tombstones"],
      ["delete", "b2", T0 + 50], ["delete", "c3", T0 + 100], ["tombstones"],
      ["delete", "d4", T0 + 100], ["tombstones"],
      ["delete", "e5", T0 + 10], ["tombstones"],
      ["delete", "missing", T0 + 500], ["tombstones"],
      ["put", "a1", "the value of a1 again", T0 + 600, null, null], ["tombstones"],
      ["clear", "c3"], ["clear", "c3"], ["tombstones"],
      ["delete", "f6", null], ["tombstones"],
      ["clear", "d4"], ["tombstones"],
      ["delete", "a1", T0 + 700], ["delete", "a1", T0 + 800], ["tombstones"],
    ] },
    { name: "what-this-version-does-not-know-survives", steps: [
      ["put", "api", V1, T0, "owner-1", "a description"],
      ["put", "other", V2, T0 + MIN, null, null],
      { tamper: "store", with: edit((d) => ({
        future: { list: [1, 2.5, null, true, "text"], nested: { z: 1, a: 2 } },
        tombstones: { gone: "2026-01-01T00:00:00.000Z" },
        entries: {
          other: { ...d.entries.other, colour: "blue" },
          api: { tag: d.entries.api.tag, extra: { kept: true }, ct: d.entries.api.ct, nonce: d.entries.api.nonce, updatedAt: d.entries.api.updatedAt, updatedBy: d.entries.api.updatedBy, createdAt: d.entries.api.createdAt, description: d.entries.api.description },
        },
        schema: d.schema,
      })) },
      ["get", "api"], ["list"], ["tombstones"],
      ["describe", "api", "changed in place", T0 + 2 * MIN, null],
      ["describe", "other", "a member added at the end", T0 + 3 * MIN, "owner-2"],
      ["put", "third", V3, T0 + 4 * MIN, null, null],
      ["put", "api", V2, T0 + 5 * MIN, null, null],
      ["delete", "other", T0 + 6 * MIN],
      ["clear", "gone"], ["clear", "other"],
    ] },
    { name: "a-file-that-is-not-what-it-should-be-is-corrupt", steps: corruptStores.flatMap(([, store]): FStep[] => [
      ["seed", { store }], ["probe"], ["get", "api"], ["list"], ["tombstones"], ["put", "api", V1, T0, null, null], ["delete", "api", null], ["clear", "api"],
    ]) },
    { name: "the-key-file", steps: [
      ["put", "api", V1, T0, null, null],
      ["seed", { key: null }], ["get", "api"], ["put", "other", V2, T0, null, null], ["put", "api", V2, T0, null, null], ["describe", "api", "text", T0, null], ["list"], ["probe"], ["delete", "other", null],
      ["seed", { key: "c2hvcnQ=\n" }], ["get", "api"], ["put", "other", V2, T0, null, null],
      ["seed", { key: "" }], ["get", "api"], ["put", "other", V2, T0, null, null],
      ["seed", { key: otherKey }], ["get", "api"], ["put", "other", V2, T0 + MIN, null, null], ["get", "other"], ["get", "api"],
      ["delete", "api", null], ["delete", "other", null],
      // Nothing left to orphan: a short key file is started over, an absent one is created.
      ["seed", { key: "c2hvcnQ=\n" }], ["get", "api"], ["put", "fresh", V1, T0 + 2 * MIN, null, null], ["get", "fresh"],
      ["delete", "fresh", null], ["seed", { key: null }], ["put", "fresh", V2, T0 + 3 * MIN, null, null], ["get", "fresh"],
      // The key as Node reads it: white space, the URL-safe alphabet, no padding, a second line.
      { tamper: "key", with: (t) => ` ${t.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").replace(/(.{7})/g, "$1\n ")}\t\n` },
      ["get", "fresh"],
      { tamper: "key", with: (t) => `${t.replace(/\s/g, "")}=\nsecond line` },
      ["get", "fresh"],
    ] },
    { name: "every-failure-to-authenticate-is-corrupt", steps: [
      ["put", "left", V1, T0, null, null], ["put", "right", V2, T0, null, null],
      { tamper: "store", with: edit((d) => { const { nonce, ct, tag } = d.entries.left; Object.assign(d.entries.left, { nonce: d.entries.right.nonce, ct: d.entries.right.ct, tag: d.entries.right.tag }); Object.assign(d.entries.right, { nonce, ct, tag }); return d; }) },
      ["get", "left"], ["get", "right"], ["describe", "left", "text", T0, null], ["put", "left", V3, T0, null, "a description forces a read"], ["put", "right", V3, T0 + MIN, null, null], ["get", "right"],
      { tamper: "store", with: edit((d) => { d.entries.right.tag = (d.entries.right.tag[0] === "A" ? "B" : "A") + d.entries.right.tag.slice(1); return d; }) }, ["get", "right"],
      ["put", "right", V1, T0 + 2 * MIN, null, null],
      { tamper: "store", with: edit((d) => { d.entries.right.ct = (d.entries.right.ct[0] === "A" ? "B" : "A") + d.entries.right.ct.slice(1); return d; }) }, ["get", "right"],
      ["put", "right", V1, T0 + 3 * MIN, null, null],
      { tamper: "store", with: edit((d) => { d.entries.right.nonce = Buffer.from(d.entries.right.nonce, "base64").subarray(0, 11).toString("base64"); return d; }) }, ["get", "right"],
      ["put", "right", V1, T0 + 4 * MIN, null, null],
      { tamper: "store", with: edit((d) => { d.entries.right.tag = Buffer.from(d.entries.right.tag, "base64").subarray(0, 15).toString("base64"); return d; }) }, ["get", "right"],
      ["put", "right", V1, T0 + 5 * MIN, null, null],
      { tamper: "store", with: edit((d) => { d.entries.right.ct = ""; return d; }) }, ["get", "right"],
      ["put", "right", V1, T0 + 6 * MIN, null, null],
      { tamper: "store", with: edit((d) => { d.entries.renamed = d.entries.right; delete d.entries.right; return d; }) }, ["get", "renamed"], ["get", "right"], ["list"],
    ] },
    { name: "the-description-rules-inside-the-backend", steps: [
      ["put", "api", V1, T0, null, `it holds ${V1} inside`],
      ["put", "api", V1, T0, null, "says first value in passing"],
      ["put", "api", V1, T0, null, "a harmless description"],
      // The text may not echo the value that is being replaced either (only that one holds these words) ...
      ["put", "api", V2, T0 + MIN, null, "names the first value in plain"],
      // ... and a description that is kept must fit the new value.
      ["describe", "api", "second value after", T0 + MIN, null],
      ["put", "api", V2, T0 + MIN, null, null],
      ["describe", "api", "a harmless description", T0 + MIN, null],
      ["put", "api", V2, T0 + MIN, null, null],
      ["put", "api", V2, T0 + 2 * MIN, null, "names the first value in plain"],
      ["put", "api", V2, T0 + 3 * MIN, null, `x${ch(1)}y`],
      ["put", "api", V2, T0 + 3 * MIN, null, "d".repeat(201)],
      ["describe", "api", `it holds ${V2} inside`, T0 + 4 * MIN, null],
      ["describe", "api", "second value after", T0 + 4 * MIN, null],
      ["describe", "api", "d".repeat(201), T0 + 4 * MIN, null],
      ["describe", "api", "fine", T0 + 5 * MIN, null],
      ["get", "api"], ["list"],
    ] },
    { name: "an-invalid-time-is-a-storage-failure", steps: [
      ["put", "api", V1, INVALID_TIME, null, null],
      ["probe"], ["list"],
      ["put", "api", V1, T0, null, null],
      ["describe", "api", "text", INVALID_TIME, null],
      ["delete", "api", INVALID_TIME],
      ["get", "api"], ["list"],
    ] },
    { name: "names-that-live-on-the-object-prototype-are-ordinary-names", steps: [
      ...["constructor", "toString", "hasOwnProperty", "valueOf"].flatMap((n, i): FStep[] => [["get", n], ["delete", n, null], ["describe", n, "text", T0, null], ["put", n, `the value of ${n} in words`, T0 + i * MIN, null, null], ["get", n]]),
      ["list"], ["delete", "constructor", T0 + MIN], ["tombstones"], ["get", "constructor"], ["clear", "toString"],
    ] },
  ];
  const base64Inputs = ["", "A", "AA", "AAA", "AAAA", "QUJD", "QUJDRA==", "QUJDRA", "QUJDRA=", "QUJDR", "QUJD RA==", "QUJD\nRA==\n", "QU-_", "QU+/", "Q!U@J#D", "QUJD=RA==", "=QUJD", "QUJDRA==QUJD", "QUJ=D", "Q=U=", "====", "Q", `QUJD${ch(0xe9)}RA`, `${EMOJI}QUJD`, " \t QUJD \r\n", "QUJD.RA", "QUJD,RA~~",
    // Node looks at the low byte of every UTF-16 unit: U+0144 counts as "D", U+0151 as "Q", U+023D and the first half of an emoji as "=".
    `QUJ${ch(0x144)}`, `${ch(0x151)}UJD`, `QUJD${ch(0x23d)}RA`, `QU${EMOJI}JD`, `QUJD${ch(0x100)}${ch(0xfffd)}RA`];
  return {
    schema: FILE_SCHEMA, maxTombstones: MAX_TOMBSTONES, corruptStores: corruptStores.map(([name]) => name),
    base64: base64Inputs.map((input) => [input, Buffer.from(input, "base64").toString("hex")]),
    scenarios: await Promise.all(scenarios.map(runFile)),
  };
}

// --- main ----------------------------------------------------------------------------------------------------------------------
export async function buildSecretsStoreVectors(): Promise<Record<string, any>> {
  return { registry: buildRegistry(), "file-backend": await buildFileBackend() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "secrets-store", build: buildSecretsStoreVectors });
}
