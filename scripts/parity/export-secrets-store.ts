// Parity vectors (mode V) for the stateful parts of the secret store (P4-20, library): the redaction registry
// (`secrets/redaction.ts`: named slots, groups, the bound of retired values, subscribers, `mask`, `contains`) and the encrypted
// file backend (`secrets/file-backend.ts`: the bytes of `store.json` and `store.key` after every operation) and the store itself
// (`secrets/store.ts`: scenarios over the memory backend in the keyring's place and the real file backend) and the keyring
// backend (`secrets/keyring-backend.ts`: every call it makes on a fake keyring, and the index it writes).
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
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";

// Lease ids are 16 random bytes (`leases.ts`). While a store scenario runs, a draw of 16 bytes from `node:crypto` is a counting
// pattern and is recorded; every other draw stays real. Wrapped before the source files are imported; they stay untouched.
const leaseIds = { on: false, next: 0, drawn: [] as string[] };
const realRandomBytes = crypto.randomBytes;
(crypto as any).randomBytes = (n: number, ...rest: any[]) => {
  if (!leaseIds.on || n !== 16) return (realRandomBytes as any)(n, ...rest);
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) bytes[i] = (leaseIds.next * 16 + i) & 0xff;
  leaseIds.next++;
  leaseIds.drawn.push(bytes.toString("hex"));
  return bytes;
};
syncBuiltinESMExports();

const SRC = "../../packages/core/src/secrets";
const { createSecretRedaction, MAX_REGISTERED_SECRETS } = await import(`${SRC}/redaction.ts`);
const { createFileBackend, FILE_SCHEMA, MAX_TOMBSTONES } = await import(`${SRC}/file-backend.ts`);
const { createKeyringBackend } = await import(`${SRC}/keyring-backend.ts`);
const { SecretError } = await import(`${SRC}/types.ts`);
const { createMemoryBackend } = await import(`${SRC}/memory-backend.ts`);
const { createSecretStore } = await import(`${SRC}/store.ts`);

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

// --- store -------------------------------------------------------------------------------------------------------------------------
// A scenario drives the real store (`store.ts`) over the memory backend in the keyring's place (its `available` switch is the
// keyring going away) and the real file backend in a fresh directory with scripted random draws. The clock, `performance.now`
// and the lease ids are scripted. After every step the fixture holds the answer, the audit records the sink received, the log
// lines, the names the change listener heard, the lifecycle hooks that ran (`marks`), `startupStatus()`, the registry's values,
// the keyring's content and the text of `store.json` (the last four only when they changed).
// Steps (a principal is its object, as the store receives it):
//   ["status", p], ["list", p], ["meta", p, name], ["reveal", p, name], ["delete", p, name], ["describe", p, name, text]
//   ["set", p, name, value, description | null]
//   ["lease", p, name, purpose, profileId, ttlMs | null], ["readLease", p, id], ["revokeLease", p, id], ["activeLeases", p]
//     (an id "#k" is the id of the k-th lease the scenario issued; the fixture records the id itself)
//   ["preload"], ["startup"], ["unavailable"], ["close"]
//   ["keyring", available], ["fallback", enabled], ["auditFails", on], ["tick", ms]
//   ["raw", "keyring" | "file", "put", name, value, nowMs, updatedBy | null, description | null], ["raw", which, "delete", name, tombstoneMs | null]
//   ["fail", "keyring" | "file", operation, "storage" | "outage"]: the next call of that operation on that backend fails: with a
//     storage error, or the way a helper process dies (the store is told first, then the call is `backend-unavailable`)
type Principal = { kind: string; id?: string; surface?: number; agentId?: string };
type SStep = [string, ...unknown[]];

async function runStore(sc: { name: string; fallback?: boolean; keyring?: boolean; steps: SStep[] }) {
  const root = mkdtempSync(join(tmpdir(), "p1b-secrets-vectors-"));
  const dir = join(root, "secrets");
  const ctl = { now: Date.UTC(2026, 0, 2, 3, 4, 5, 678), mono: 1000, fallback: sc.fallback ?? false, auditFails: false, fail: new Map<string, string>(), store: null as any };
  leaseIds.next = 0;
  let drawn = 0;
  let draws: string[] = [];
  const random = (n: number): Buffer => {
    const bytes = Buffer.alloc(n);
    for (let i = 0; i < n; i++) bytes[i] = (drawn * 16 + i) & 0xff;
    drawn++;
    draws.push(bytes.toString("hex"));
    return bytes;
  };
  const memory = createMemoryBackend({ available: sc.keyring ?? true });
  const fileBackend = createFileBackend({ dir, secure: (() => undefined) as any, random });
  const wrap = (inner: any, which: string): any => {
    const call = (op: string) => async (...args: unknown[]) => {
      const mode = ctl.fail.get(`${which}.${op}`);
      if (mode !== undefined) {
        ctl.fail.delete(`${which}.${op}`);
        if (mode === "outage") { ctl.store.backendUnavailable(); throw new SecretError("backend-unavailable", "the helper went away"); }
        throw new SecretError("storage", "injected failure (EIO)", { cause: "EIO" });
      }
      return inner[op](...args);
    };
    const out: any = { kind: inner.kind };
    for (const op of ["probe", "get", "put", "describe", "delete", "list"]) out[op] = call(op);
    if (inner.tombstones) { out.tombstones = call("tombstones"); out.clearTombstone = call("clearTombstone"); }
    return out;
  };
  let audit: unknown[] = [], logs: unknown[] = [], changes: string[] = [], marks: string[] = [];
  const log = (level: string) => (message: string, fields?: Record<string, unknown>) => { logs.push([level, message, fields ?? {}]); };
  const realNow = performance.now;
  Object.defineProperty(performance, "now", { value: () => ctl.mono, configurable: true, writable: true });
  leaseIds.on = true;
  const store = createSecretStore({
    keyring: wrap(memory, "keyring"), file: wrap(fileBackend, "file"), fileFallback: () => ctl.fallback,
    audit: { record(e: any) { if (ctl.auditFails) throw new SecretError("audit-unavailable", "the audit log cannot be written; no secret was released or changed"); audit.push({ action: e.action, target: e.target, principal: e.principal, detail: e.detail ?? {} }); } },
    clock: () => ctl.now, logger: { debug: log("debug"), info: log("info"), warn: log("warn") },
    startup: { budgetMs: 3000, retryAfterMs: 30_000, cancel: () => { marks.push("cancel"); }, close: async () => { marks.push("close"); } },
  });
  ctl.store = store;
  store.onChange((name: string) => { changes.push(name); });
  const issued: string[] = [];
  const leaseId = (ref: unknown): string => (typeof ref === "string" && ref.startsWith("#") ? issued[Number(ref.slice(1))] ?? ref : String(ref));
  const leaseJson = (l: any) => ({ leaseId: l.leaseId, name: l.name, value: l.value, expiresAt: l.expiresAt, purpose: l.purpose, profileId: l.profileId });
  const steps: unknown[] = [];
  try {
    for (const given of sc.steps) {
      const step: SStep = given[0] === "readLease" || given[0] === "revokeLease" ? [given[0], given[1], leaseId(given[2])] : given;
      audit = []; logs = []; changes = []; marks = []; draws = []; leaseIds.drawn = [];
      const p = step[1] as Principal;
      let result: unknown;
      try {
        switch (step[0]) {
          case "status": result = { ok: await store.status(p) }; break;
          case "list": result = { ok: await store.list(p) }; break;
          case "meta": result = { ok: await store.meta(p, step[2] as string) }; break;
          case "reveal": result = { ok: await store.reveal(p, step[2] as string) }; break;
          case "delete": result = { ok: await store.delete(p, step[2] as string) }; break;
          case "describe": result = { ok: await store.describe(p, step[2] as string, step[3] as string) }; break;
          case "set": result = { ok: await store.set(p, step[2] as string, step[3] as string, (step[4] ?? undefined) as string | undefined) }; break;
          case "lease": { const l = await store.lease(p, step[2] as string, { purpose: step[3] as string, profileId: step[4] as string, ...(step[5] === null ? {} : { ttlMs: step[5] as number }) }); issued.push(l.leaseId); result = { ok: leaseJson(l) }; break; }
          case "readLease": result = { ok: leaseJson(store.readLease(p, step[2] as string)) }; break;
          case "revokeLease": result = { ok: store.revokeLease(p, step[2] as string) }; break;
          case "activeLeases": result = { ok: store.activeLeases(p) }; break;
          case "preload": await store.preloadRedaction(); result = { ok: null }; break;
          case "startup": result = { ok: null }; break;
          case "unavailable": store.backendUnavailable(); result = { ok: null }; break;
          case "close": await store.close(); result = { ok: null }; break;
          case "keyring": memory.available = step[1] as boolean; result = { ok: null }; break;
          case "fallback": ctl.fallback = step[1] as boolean; result = { ok: null }; break;
          case "auditFails": ctl.auditFails = step[1] as boolean; result = { ok: null }; break;
          case "tick": ctl.now += step[1] as number; ctl.mono += step[1] as number; result = { ok: null }; break;
          case "fail": ctl.fail.set(`${step[1]}.${step[2]}`, step[3] as string); result = { ok: null }; break;
          case "raw": {
            const backend: any = step[1] === "keyring" ? memory : fileBackend;
            if (step[2] === "put") await backend.put(step[3], step[4], new Date(step[5] as number), step[6] ?? undefined, step[7] ?? undefined);
            else await backend.delete(step[3], step[4] === null ? undefined : new Date(step[4] as number));
            result = { ok: null };
            break;
          }
          default: throw new Error(`unknown step ${step[0]}`);
        }
      } catch (e: any) {
        if (!(e instanceof SecretError)) throw e;
        result = { err: { code: e.code, message: e.message, detail: { ...e.detail } } };
      }
      steps.push({
        op: step, result, audit, logs, changes, marks, startup: store.startupStatus(), values: [...store.redaction.values()],
        keyring: [...memory.dump()], store: existsSync(join(dir, "store.json")) ? readFileSync(join(dir, "store.json"), "utf8") : null,
        draws, ids: leaseIds.drawn,
      });
    }
  } finally {
    leaseIds.on = false;
    Object.defineProperty(performance, "now", { value: realNow, configurable: true, writable: true });
    rmSync(root, { recursive: true, force: true });
  }
  // What did not change since the step before is left out; the replay keeps the last recorded state.
  const last: Record<string, string> = {};
  for (const step of steps as Record<string, unknown>[]) for (const key of ["startup", "values", "keyring", "store"]) {
    const text = JSON.stringify(step[key]);
    if (last[key] === text) delete step[key]; else last[key] = text;
  }
  return { name: sc.name, fallback: sc.fallback ?? false, keyring: sc.keyring ?? true, steps };
}

async function buildStore() {
  const OWNER: Principal = { kind: "owner", id: "owner-1", surface: 1 };
  const OWNER_T3: Principal = { kind: "owner", id: "owner-3", surface: 3 };
  const OWNER_T0: Principal = { kind: "owner", id: "owner-1", surface: 0 };
  const OWNER_HERE: Principal = { kind: "owner", id: "owner-here" };
  const OWNER_NAMELESS: Principal = { kind: "owner" };
  const CORE: Principal = { kind: "core" };
  const AGENT: Principal = { kind: "agent", agentId: "agent-7" };
  const AGENT_NAMELESS: Principal = { kind: "agent" };
  const V = (n: number): string => `value number ${n} in plain words`;
  const T0 = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
  const everything = (p: Principal): SStep[] => [
    ["status", p], ["list", p], ["meta", p, "api"], ["reveal", p, "api"], ["set", p, "extra", V(90), null], ["describe", p, "api", "described by this principal"],
    ["lease", p, "api", "a-purpose", "a-profile", null], ["activeLeases", p], ["readLease", p, "lse_unknown"], ["revokeLease", p, "lse_unknown"], ["delete", p, "extra"],
    ["set", p, "not a name", V(91), null], ["reveal", p, "not a name"], ["delete", p, ""],
  ];
  const scenarios: { name: string; fallback?: boolean; keyring?: boolean; steps: SStep[] }[] = [
    { name: "an-owner-on-the-keyring", steps: [
      ["startup"], ["status", OWNER], ["list", OWNER], ["meta", OWNER, "api"], ["reveal", OWNER, "api"], ["delete", OWNER, "api"], ["describe", OWNER, "api", "text"],
      ["set", OWNER, "api", V(1), "what it is for"], ["tick", 1000], ["meta", OWNER, "api"], ["reveal", OWNER, "api"], ["status", OWNER], ["list", OWNER],
      ["set", OWNER, "zeta", V(2), null], ["set", OWNER_HERE, "Alpha", V(3), "  spaces around  "], ["set", OWNER_NAMELESS, "123", V(4), ""], ["list", OWNER], ["status", CORE],
      ["tick", 1000], ["set", OWNER, "api", V(5), null], ["reveal", OWNER, "api"], ["set", OWNER_T3, "api", V(5), ""], ["meta", OWNER, "api"],
      ["describe", OWNER, "api", "  a new text  "], ["describe", OWNER_NAMELESS, "api", "by nobody in particular"], ["describe", OWNER, "api", ""], ["describe", OWNER, "missing", "text"],
      ["set", OWNER, "bad name", V(6), null], ["set", OWNER, "api", "", null], ["set", OWNER, "api", "short", null], ["reveal", OWNER, "api"],
      ["set", OWNER, "api", V(7), "d".repeat(201)], ["set", OWNER, "api", V(7), `x${ch(1)}y`], ["describe", OWNER, "api", "d".repeat(201)], ["meta", OWNER, "bad name"],
      ["delete", OWNER, "zeta"], ["delete", OWNER, "zeta"], ["list", OWNER], ["status", OWNER], ["startup"],
    ] },
    { name: "who-may-do-what", steps: [
      ["set", OWNER, "api", V(1), null],
      ...[AGENT, AGENT_NAMELESS, CORE, OWNER_T0, OWNER_HERE, OWNER_T3].flatMap(everything),
      ["reveal", OWNER, "api"], ["list", OWNER],
    ] },
    { name: "a-preload-registers-every-value-before-anything-is-served", steps: [
      ["raw", "keyring", "put", "first", V(1), T0, null, null], ["raw", "keyring", "put", "second", V(2), T0, "owner-1", "a description"],
      ["raw", "file", "put", "third", V(3), T0, null, null],
      ["startup"], ["preload"], ["startup"], ["preload"], ["status", OWNER],
      ["fallback", true], ["status", OWNER], ["reveal", OWNER, "third"], ["list", OWNER],
      ["keyring", false], ["status", OWNER], ["set", OWNER, "fourth", V(4), null], ["reveal", OWNER, "first"],
      ["fallback", false], ["status", OWNER], ["status", CORE], ["set", OWNER, "fifth", V(5), null], ["reveal", OWNER, "first"], ["list", OWNER], ["meta", OWNER, "first"], ["lease", CORE, "first", "a-purpose", "a-profile", null],
      ["keyring", true], ["status", OWNER], ["reveal", OWNER, "first"], ["fallback", true], ["list", OWNER], ["startup"],
      // A value read at an earlier preload stays in the start-up snapshot after its secret is gone.
      ["raw", "keyring", "delete", "second", null], ["unavailable"], ["tick", 30_000], ["status", OWNER], ["startup"],
    ] },
    { name: "a-start-without-any-backend", keyring: false, steps: [
      ["preload"], ["startup"], ["status", OWNER], ["set", OWNER, "api", V(1), null], ["list", OWNER], ["reveal", OWNER, "api"], ["lease", CORE, "api", "a-purpose", "a-profile", null], ["readLease", CORE, "lse_unknown"],
      ["tick", 29_999], ["status", OWNER], ["tick", 1], ["status", OWNER], ["startup"],
      ["keyring", true], ["status", OWNER], ["tick", 30_000], ["preload"], ["startup"], ["set", OWNER, "api", V(1), null], ["status", OWNER],
      ["keyring", false], ["reveal", OWNER, "api"], ["status", OWNER], ["fallback", true], ["set", OWNER, "api", V(2), null], ["status", OWNER], ["startup"],
    ] },
    { name: "the-file-serves-while-the-keyring-is-away", fallback: true, steps: [
      ["set", OWNER, "kept", V(1), "stays where it is"], ["set", OWNER, "rotated", V(2), null], ["set", OWNER, "deleted", V(3), null], ["set", OWNER, "tie", V(4), null], ["set", OWNER, "leased", V(5), null],
      ["lease", CORE, "leased", "a-purpose", "a-profile", 300_000], ["status", OWNER],
      ["keyring", false], ["tick", 60_000], ["status", OWNER], ["list", OWNER], ["reveal", OWNER, "kept"],
      ["set", OWNER, "rotated", V(6), "rotated while the keyring was away"], ["set", OWNER, "deleted", V(7), null], ["tick", 1000], ["delete", OWNER, "deleted"],
      ["set", OWNER, "newcomer", V(8), null], ["set", OWNER, "leased", V(9), null], ["raw", "file", "put", "tie", V(10), T0, null, "the file's copy of a tie"],
      ["list", OWNER], ["status", OWNER], ["reveal", OWNER, "rotated"], ["delete", OWNER, "missing"],
      ["keyring", true], ["tick", 1000],
      ["reveal", OWNER, "rotated"], ["reveal", OWNER, "deleted"], ["reveal", OWNER, "tie"], ["reveal", OWNER, "kept"], ["meta", OWNER, "newcomer"], ["meta", OWNER, "deleted"],
      ["lease", CORE, "rotated", "a-purpose", "a-profile", null], ["readLease", CORE, "#0"],
      ["status", OWNER], ["status", OWNER], ["list", OWNER], ["reveal", OWNER, "rotated"], ["reveal", OWNER, "newcomer"], ["readLease", CORE, "#1"],
      ["set", OWNER, "newcomer", V(11), null], ["set", OWNER, "kept", V(12), null], ["delete", OWNER, "tie"],
      // A keyring copy written after the delete is not a deleted one: the tombstone only hides what is not newer.
      ["keyring", false], ["set", OWNER, "phoenix", V(30), null], ["tick", 1000], ["delete", OWNER, "phoenix"], ["keyring", true], ["tick", 1000],
      ["raw", "keyring", "put", "phoenix", V(31), T0 + 36_000_000, null, null], ["reveal", OWNER, "phoenix"], ["meta", OWNER, "phoenix"], ["status", OWNER], ["reveal", OWNER, "phoenix"],
      ["fallback", false], ["raw", "file", "put", "kept", V(13), T0, null, null], ["delete", OWNER, "kept"], ["delete", OWNER, "kept"], ["list", OWNER],
      ["fallback", true], ["list", OWNER], ["status", OWNER],
    ] },
    { name: "a-description-holds-no-value-of-the-store", fallback: true, steps: [
      ["set", OWNER, "first", V(1), null], ["set", OWNER, "second", V(2), `it says ${V(1)} here`], ["set", OWNER, "second", V(2), "harmless"],
      ["describe", OWNER, "second", `again ${V(1)}`], ["describe", OWNER, "second", `its own ${V(2)}`], ["describe", OWNER, "second", "number 2 in plain"],
      // Words only the value that is being replaced holds ("ber 1 in"), words of the new one, and neither.
      ["set", OWNER, "first", V(3), "see ber 1 in"], ["set", OWNER, "first", V(3), "number 3 in plain"], ["set", OWNER, "first", V(3), "harmless too"],
      // A value the store holds but this process has not read yet (written behind its back) is found by reading every name.
      ["raw", "keyring", "put", "hidden", V(20), T0, null, null], ["set", OWNER, "second", V(2), `it says ${V(20)} here`], ["describe", OWNER, "second", `and ${V(20)} again`],
      ["raw", "keyring", "put", "unseen", V(21), T0, null, null], ["describe", OWNER, "second", `it says ${V(21)} here`],
      // A description written before its words became a secret is shown masked.
      ["set", OWNER, "early", V(22), "the words later made secret appear here"], ["set", OWNER, "later", "later made secret", null], ["status", OWNER], ["list", OWNER],
      ["delete", OWNER, "first"], ["describe", OWNER, "second", `the deleted ${V(3)} is still known`], ["set", OWNER, "tiny", "short", null], ["describe", OWNER, "second", "short is short"],
      ["keyring", false], ["set", OWNER, "third", V(4), `it says ${V(2)} here`], ["set", OWNER, "third", V(4), "fine"], ["keyring", true], ["describe", OWNER, "second", `it says ${V(4)} here`],
      ["list", OWNER],
    ] },
    { name: "an-outage-revokes-every-lease-and-ends-after-the-retry", steps: [
      ["set", OWNER, "api", V(1), null], ["lease", CORE, "api", "a-purpose", "a-profile", null], ["lease", OWNER_HERE, "api", "another-purpose", "a-profile", 300_000], ["activeLeases", CORE],
      ["unavailable"], ["startup"], ["activeLeases", CORE], ["readLease", CORE, "#0"], ["revokeLease", CORE, "#1"], ["reveal", OWNER, "api"], ["set", OWNER, "api", V(2), null], ["list", OWNER], ["meta", OWNER, "api"], ["status", OWNER],
      ["tick", 29_999], ["status", OWNER], ["tick", 1], ["status", OWNER], ["startup"], ["reveal", OWNER, "api"], ["lease", CORE, "api", "a-purpose", "a-profile", null],
      ["fail", "keyring", "get", "outage"], ["reveal", OWNER, "api"], ["startup"], ["activeLeases", CORE], ["tick", 30_000],
      ["fail", "keyring", "probe", "outage"], ["status", OWNER], ["startup"], ["tick", 30_000], ["status", OWNER],
      ["fail", "keyring", "put", "outage"], ["set", OWNER, "api", V(3), null], ["tick", 30_000], ["reveal", OWNER, "api"],
      ["fail", "keyring", "list", "outage"], ["list", OWNER], ["tick", 30_000], ["fail", "keyring", "list", "outage"], ["status", OWNER], ["tick", 30_000],
      ["fail", "keyring", "delete", "outage"], ["delete", OWNER, "api"], ["tick", 30_000], ["fail", "keyring", "describe", "outage"], ["describe", OWNER, "api", "text"], ["tick", 30_000], ["reveal", OWNER, "api"],
      ["lease", CORE, "api", "a-purpose", "a-profile", null], ["close"], ["startup"], ["activeLeases", CORE], ["status", OWNER], ["set", OWNER, "api", V(4), null], ["reveal", OWNER, "api"], ["preload"], ["unavailable"], ["close"], ["startup"],
    ] },
    { name: "the-audit-line-comes-first", steps: [
      ["set", OWNER, "api", V(1), "a description"], ["lease", CORE, "api", "a-purpose", "a-profile", null], ["auditFails", true],
      ["set", OWNER, "api", V(2), null], ["set", OWNER, "other", V(3), null], ["describe", OWNER, "api", "another"], ["meta", OWNER, "api"], ["reveal", OWNER, "api"], ["list", OWNER], ["delete", OWNER, "api"],
      ["lease", CORE, "api", "a-purpose", "a-profile", null], ["readLease", CORE, "#0"], ["revokeLease", CORE, "#0"], ["activeLeases", CORE], ["status", OWNER], ["set", AGENT, "api", V(4), null],
      ["auditFails", false], ["reveal", OWNER, "api"], ["readLease", CORE, "#0"], ["list", OWNER],
    ] },
    { name: "leases", steps: [
      ["set", OWNER, "api", V(1), null],
      ["lease", CORE, "api", "a-purpose", "a-profile", null], ["lease", OWNER, "api", "p", "q", 1], ["lease", OWNER_HERE, "api", "A.b_c:d/e@f-g", "0", 300_000],
      ["lease", CORE, "api", "a-purpose", "a-profile", 0], ["lease", CORE, "api", "a-purpose", "a-profile", 300_001], ["lease", CORE, "api", "a-purpose", "a-profile", 1.5], ["lease", CORE, "api", "a-purpose", "a-profile", -5],
      ["lease", CORE, "api", "a purpose", "a-profile", null], ["lease", CORE, "api", "", "a-profile", null], ["lease", CORE, "api", "a-purpose", "-profile", null], ["lease", CORE, "api", "a-purpose", "p".repeat(129), null], ["lease", CORE, "api", "p".repeat(128), "a-profile", 1000],
      ["lease", CORE, "missing", "a-purpose", "a-profile", null], ["lease", CORE, "bad name", "a-purpose", "a-profile", null], ["lease", AGENT, "api", "a-purpose", "a-profile", null],
      ["activeLeases", CORE], ["readLease", CORE, "#0"], ["readLease", OWNER, "#2"], ["readLease", AGENT, "#0"], ["tick", 1], ["readLease", CORE, "#1"], ["activeLeases", OWNER],
      ["tick", 998], ["readLease", CORE, "#3"], ["tick", 1], ["readLease", CORE, "#3"], ["revokeLease", CORE, "#0"], ["revokeLease", CORE, "#0"], ["readLease", CORE, "#0"], ["revokeLease", AGENT, "#2"],
      ["describe", OWNER, "api", "a description does not revoke"], ["readLease", CORE, "#2"], ["set", OWNER, "api", V(2), null], ["readLease", CORE, "#2"], ["activeLeases", CORE],
      ["lease", CORE, "api", "a-purpose", "a-profile", null], ["delete", OWNER, "api"], ["readLease", CORE, "#4"], ["activeLeases", CORE], ["status", OWNER],
    ] },
    { name: "failures-that-are-warned-not-fatal", fallback: true, steps: [
      ["fail", "file", "delete", "storage"], ["set", OWNER, "first", V(1), null], ["fail", "file", "tombstones", "storage"], ["reveal", OWNER, "first"],
      ["raw", "file", "put", "first", V(2), T0 + 3_600_000, null, null], ["fail", "keyring", "put", "storage"], ["status", OWNER], ["reveal", OWNER, "first"], ["status", OWNER], ["reveal", OWNER, "first"],
      ["raw", "file", "put", "stale", V(3), T0 - 3_600_000, null, null], ["set", OWNER, "stale", V(4), null], ["raw", "file", "put", "stale", V(5), T0 - 3_600_000, null, null], ["fail", "file", "delete", "storage"], ["list", OWNER], ["list", OWNER],
      ["fail", "keyring", "list", "storage"], ["status", OWNER], ["fail", "file", "list", "storage"], ["list", OWNER], ["fail", "file", "probe", "storage"], ["status", OWNER], ["fail", "keyring", "probe", "storage"], ["reveal", OWNER, "first"],
      ["fail", "keyring", "get", "storage"], ["set", OWNER, "second", V(6), "the check skips what it cannot read"], ["fail", "keyring", "get", "storage"], ["reveal", OWNER, "first"],
      ["keyring", false], ["set", OWNER, "gone", V(7), null], ["delete", OWNER, "gone"], ["raw", "keyring", "put", "gone", V(8), T0, null, null], ["keyring", true], ["raw", "keyring", "put", "gone", V(8), T0, null, null],
      ["fail", "keyring", "delete", "storage"], ["status", OWNER], ["reveal", OWNER, "gone"],
      ["fail", "file", "clearTombstone", "storage"], ["status", OWNER], ["status", OWNER], ["fail", "file", "clearTombstone", "storage"], ["delete", OWNER, "first"],
      ["fallback", false], ["raw", "file", "put", "second", V(9), T0, null, null], ["fail", "file", "delete", "storage"], ["delete", OWNER, "second"], ["list", OWNER],
    ] },
  ];
  const dates = ["2026-01-02T03:04:05.678Z", "2026-01-02T03:04:05Z", "2026-01-02T03:04Z", "2026-01-02", "1970-01-01T00:00:00.000Z", "1969-12-31T23:59:59.999Z", "2024-02-29T12:00:00.000Z", "2026-01-02T03:04:05.678+02:00", "2026-01-02T03:04:05.678-09:30", "2026-01-02T24:00:00.000Z",
    "", "x", "2026-13-01T00:00:00.000Z", "2026-01-32T00:00:00.000Z", "2026-01-02T25:00:00.000Z", "2026-01-02T03:60:00.000Z", "2026-01-02T03:04:60.000Z", "2026-01-02T24:00:00.001Z", "20260102", "2026-01-02T03:04:05.678Zx", "2026-02-30T00:00:00.000Z", "2026-02-31", "2025-02-29T00:00:00.000Z", "2026-04-31T00:00:00.000Z", "2026-01-00T00:00:00.000Z", "2026-00-10T00:00:00.000Z"];
  return {
    dates: dates.map((text) => { const t = Date.parse(text); return [text, Number.isFinite(t) ? t : null]; }),
    scenarios: await scenarios.reduce(async (done, sc) => [...(await done), await runStore(sc)], Promise.resolve([] as unknown[])),
  };
}

// --- keyring backend ---------------------------------------------------------------------------------------------------------------
// A scenario drives the real backend (`keyring-backend.ts`) over a fake keyring module. After every step the fixture holds the
// answer, the values handed to `register`, every call the backend made on the fake (`calls`: "new:<account>", "get:<account>",
// "set:<account>", "delete:<account>", in order, joined by a space) and what the step changed in the fake (`items`: [account, text | null] pairs
// sorted by account, `null` for an item that is gone; absent when nothing changed). Steps:
//   ["probe"], ["get", name], ["list"], ["delete", name]
//   ["put", name, value, nowMs, updatedBy | null, description | null]   (null is "not given"; "" clears)
//   ["describe", name, text, nowMs, updatedBy | null]
//   ["seed", account, text | null]            writes or removes an item behind the backend's back
//   ["fail", op, account | null, code | null, skip]
//     op is "load" (the module loader), "new" (the Entry constructor), "get", "set" or "delete": after `skip` matching calls the
//     next one throws an Error with platform text and, when given, a `code`. A `load` failure is only scripted where the next
//     call loads the module (at the start, or right after a failure made the backend forget it), always with `skip` 0.
// `variant: "credential"` is a module whose entries offer `deleteCredential` and no `deletePassword`.
// A scenario with a `note` records a place where the Rust backend deliberately differs (P4D-32); the replay says how.
type KStep =
  | ["probe"] | ["get", string] | ["list"] | ["delete", string]
  | ["put", string, string, number, string | null, string | null]
  | ["describe", string, string, number, string | null]
  | ["seed", string, string | null]
  | ["fail", "load" | "new" | "get" | "set" | "delete", string | null, string | null, number];

const KEYRING_SERVICE = "plur1bus:vector-service";
const INDEX_ACCOUNT = "__plur1bus-index__", PROBE_ACCOUNT = "__plur1bus-probe__", INDEX_SCHEMA = "plur1bus.secrets-index/1";

async function runKeyring(sc: { name: string; note?: string; variant?: "credential"; steps: KStep[] }) {
  const items = new Map<string, string>();
  let calls: string[] = [];
  const fails: { op: string; account: string | null; code: string | null; skip: number }[] = [];
  const hit = (op: string, account: string): void => {
    const i = fails.findIndex(f => f.op === op && (f.account === null || f.account === account));
    if (i < 0) return;
    const f = fails[i]!;
    if (f.skip > 0) { f.skip--; return; }
    fails.splice(i, 1);
    throw Object.assign(new Error(`platform text about ${account} that must not reach an answer`), f.code === null ? {} : { code: f.code });
  };
  class Entry {
    account: string;
    constructor(service: string, account: string) {
      if (service !== KEYRING_SERVICE) throw new Error("another service");
      this.account = account;
      calls.push(`new:${account}`);
      hit("new", account);
    }
    getPassword(): string | null { calls.push(`get:${this.account}`); hit("get", this.account); return items.get(this.account) ?? null; }
    setPassword(password: string): void { calls.push(`set:${this.account}`); hit("set", this.account); items.set(this.account, password); }
  }
  (Entry.prototype as any)[sc.variant === "credential" ? "deleteCredential" : "deletePassword"] = function (this: Entry): boolean {
    calls.push(`delete:${this.account}`); hit("delete", this.account); return items.delete(this.account);
  };
  const backend = createKeyringBackend({ service: KEYRING_SERVICE, load: async () => { hit("load", ""); return { Entry } as any; } });
  let last = new Map(items);
  const steps: unknown[] = [];
  for (const step of sc.steps) {
    calls = [];
    const registered: string[] = [];
    const register = (value: string): void => { registered.push(value); };
    let result: unknown;
    try {
      switch (step[0]) {
        case "probe": result = { ok: await backend.probe() }; break;
        case "get": result = { ok: await backend.get(step[1]) }; break;
        case "list": result = { ok: await backend.list() }; break;
        case "delete": result = { ok: await backend.delete(step[1]) }; break;
        case "put": result = { ok: await backend.put(step[1], step[2], new Date(step[3]), step[4] ?? undefined, step[5] ?? undefined, register) }; break;
        case "describe": result = { ok: await backend.describe(step[1], step[2], new Date(step[3]), step[4] ?? undefined, register) }; break;
        case "seed":
          if (step[2] === null) items.delete(step[1]); else items.set(step[1], step[2]);
          result = { ok: null };
          break;
        case "fail":
          if (step[1] === "load" && (step[2] !== null || step[4] !== 0)) throw new Error(`${sc.name}: a load failure has no account and no skip`);
          fails.push({ op: step[1], account: step[2], code: step[3], skip: step[4] });
          result = { ok: null };
          break;
      }
    } catch (e: any) {
      result = e instanceof SecretError ? { err: { code: e.code, message: e.message, detail: { ...e.detail } } } : { throw: e?.name ?? typeof e };
    }
    if (step[0] !== "fail" && fails.length) throw new Error(`${sc.name}: a scripted failure did not happen in ${JSON.stringify(step)}`);
    const changed: [string, string | null][] = [];
    for (const account of [...new Set([...last.keys(), ...items.keys()])].sort()) {
      if (last.get(account) !== items.get(account)) changed.push([account, items.get(account) ?? null]);
    }
    steps.push({ op: step, result, registered, calls: calls.join(" "), ...(changed.length ? { items: changed } : {}) });
    last = new Map(items);
  }
  return { name: sc.name, ...(sc.note ? { note: sc.note } : {}), ...(sc.variant ? { variant: sc.variant } : {}), steps };
}

async function buildKeyring() {
  const T0 = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
  const MIN = 60_000;
  const INVALID_TIME = 8.64e15 + 1;
  const V1 = "the first value in plain words", V2 = "a second value after rotation", V3 = `caf${ch(0xe9)} ${EMOJI} unicode value`;
  const I = INDEX_ACCOUNT, P = PROBE_ACCOUNT;
  const at = (n: number): string => new Date(T0 + n * MIN).toISOString();
  const index = (entries: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({ schema: INDEX_SCHEMA, entries, ...extra });
  const sound = { createdAt: at(0), updatedAt: at(0) };

  const corrupt: [string, string][] = [
    ["not-json", "this is not json"],
    ["empty-text", ""],
    ["cut-off", "{"],
    ["json-null", "null"],
    ["json-number", "5"],
    ["json-string", JSON.stringify("text")],
    ["json-array", "[]"],
    ["empty-object", "{}"],
    ["other-schema", JSON.stringify({ schema: "plur1bus.secrets-index/2", entries: {} })],
    ["no-schema", JSON.stringify({ entries: {} })],
    ["schema-not-a-string", JSON.stringify({ schema: 1, entries: {} })],
    ["no-entries", JSON.stringify({ schema: INDEX_SCHEMA })],
    ["entries-array", index([])],
    ["entries-null", index(null)],
    ["entries-string", index("x")],
    ["entries-zero", index(0)],
    ["entries-false", index(false)],
    ["entry-string", index({ api: "x" })],
    ["entry-null", index({ api: null })],
    ["entry-array", index({ api: [] })],
    ["entry-number", index({ api: 5 })],
    ["entry-empty", index({ api: {} })],
    ["created-not-a-string", index({ api: { createdAt: 5, updatedAt: at(0) } })],
    ["no-updated", index({ api: { createdAt: at(0) } })],
    ["updated-null", index({ api: { createdAt: at(0), updatedAt: null } })],
    ["description-null", index({ api: { ...sound, description: null } })],
    ["description-number", index({ api: { ...sound, description: 5 } })],
    ["name-underscore", index({ _x: sound })],
    ["name-empty", index({ "": sound })],
    ["name-with-space", index({ "a b": sound })],
    ["name-too-long", index({ ["n".repeat(129)]: sound })],
    ["name-not-ascii", index({ [`caf${ch(0xe9)}`]: sound })],
    ["one-bad-among-good", index({ api: sound, other: { createdAt: at(0) } })],
  ];
  const corruptSteps: KStep[] = [["put", "api", V1, T0, null, null]];
  corrupt.forEach(([, text], n) => {
    corruptSteps.push(["seed", I, text], ["list"]);
    if (n % 5 === 0) corruptSteps.push(["put", "api", V2, T0 + MIN, null, null], ["get", "api"], ["describe", "api", "what it is for", T0 + MIN, null], ["delete", "api"], ["probe"]);
  });
  corruptSteps.push(["seed", I, index({ ["n".repeat(128)]: sound, "ext:mod/slot@1": sound })], ["list"], ["seed", I, null], ["list"], ["put", "api", V2, T0 + MIN, null, null], ["list"]);

  // Members this version does not know, an unusual member order and a repeated key: all of it survives a write of another name.
  const foreign = `{"future":{"a":[1,2,{"b":null}]},"entries":{"zeta":{"updatedAt":"${at(1)}","extra":true,"createdAt":"${at(0)}","description":"kept as it is"},` +
    `"api":{"createdAt":"${at(0)}","updatedAt":"${at(0)}","more":{"x":1}},"blank":{"createdAt":"${at(0)}","updatedAt":"${at(0)}","description":"","updatedBy":""},"zeta":{"createdAt":"${at(0)}","updatedAt":"${at(2)}","extra":false}},` +
    `"schema":"${INDEX_SCHEMA}","7":"an integer-like member"}`;

  const scenarios: { name: string; note?: string; variant?: "credential"; steps: KStep[] }[] = [
    { name: "lifecycle", steps: [
      ["probe"], ["get", "api"], ["list"], ["delete", "api"],
      ["put", "api", V1, T0, null, null],
      ["put", "Zeta.key", V2, T0 + MIN, "owner:local", "what the zeta key is for"],
      ["put", "api", V2, T0 + 2 * MIN, "owner:local", null],
      ["put", "api", V1, T0 + 3 * MIN, "", "the api key"],
      ["put", "api", V1, T0 + 4 * MIN, null, null],
      ["put", "api", V1, T0 + 5 * MIN, null, ""],
      ["describe", "Zeta.key", "  now described again  ", T0 + 6 * MIN, "owner:local"],
      ["describe", "Zeta.key", "", T0 + 7 * MIN, null],
      ["describe", "Zeta.key", "a third text", T0 + 8 * MIN, ""],
      ["put", "mail/smtp@host", V3, T0 + 9 * MIN, null, `the m${ch(0xe9)}l ${EMOJI}${NBSP}account`],
      ["list"], ["get", "api"], ["get", "Zeta.key"], ["get", "mail/smtp@host"],
      ["delete", "api"], ["delete", "api"], ["get", "api"], ["list"], ["probe"],
      ["put", "api", V3, T0 + 10 * MIN, null, null], ["list"],
    ] },
    { name: "the-order-of-names", steps: [
      ...["b", "10", "7", "a", "B", "a.b", "a-b", "a_b", "A"].map((name, n): KStep => ["put", name, `${V1} ${n}`, T0 + n * MIN, null, null]),
      ["list"], ["delete", "10"], ["put", "10", V2, T0 + 20 * MIN, null, null], ["put", "3", V2, T0 + 21 * MIN, null, null], ["list"],
      ["describe", "7", "the seventh", T0 + 22 * MIN, null], ["delete", "b"], ["put", "b", V2, T0 + 23 * MIN, null, null], ["list"],
    ] },
    { name: "descriptions", steps: [
      ["put", "api", V1, T0, null, `contains ${V1} whole`],
      ["put", "api", V1, T0, null, "first value in plain"],
      ["put", "api", V1, T0, null, "x".repeat(201)],
      ["put", "api", V1, T0, null, "what it is for"],
      ["put", "api", V2, T0 + MIN, null, null],
      ["put", "api", "an unrelated third value", T0 + 2 * MIN, null, "second value after"],
      ["put", "api", "what it is for, said the value", T0 + 2 * MIN, null, null],
      ["get", "api"], ["list"],
      ["describe", "api", V2, T0 + 3 * MIN, null],
      ["describe", "api", "value after rotation", T0 + 3 * MIN, null],
      ["describe", "api", "x".repeat(201), T0 + 3 * MIN, null],
      ["describe", "api", `two${ch(10)}lines`, T0 + 3 * MIN, null],
      ["describe", "absent", "a text", T0 + 3 * MIN, null],
      ["describe", "api", "a text", INVALID_TIME, null],
      ["put", "api", V2, T0 + 4 * MIN, null, "   "],
      ["put", "padded", V1, T0 + 5 * MIN, null, "  padded text  "],
      ["describe", "padded", "   ", T0 + 6 * MIN, null],
      ["list"],
    ] },
    { name: "failures", steps: [
      ["fail", "load", null, null, 0], ["probe"],
      ["fail", "load", null, "ERR_MODULE_NOT_FOUND", 0], ["get", "api"],
      ["fail", "new", P, null, 0], ["probe"],
      ["fail", "load", null, null, 0], ["list"],
      ["fail", "get", P, "EACCES", 0], ["probe"],
      ["probe"],
      ["put", "api", V1, T0, "owner:local", "the api key"],
      ["fail", "new", "api", null, 0], ["get", "api"],
      ["fail", "get", "api", "ENOENT", 0], ["get", "api"],
      ["fail", "get", "api", null, 0], ["get", "api"],
      ["fail", "new", I, null, 0], ["list"],
      ["fail", "get", I, "EIO", 0], ["list"],
      ["fail", "new", I, null, 0], ["put", "api", V2, T0 + MIN, null, null],
      ["fail", "get", I, "EIO", 0], ["put", "api", V2, T0 + MIN, null, null],
      ["fail", "new", "api", null, 0], ["put", "api", V2, T0 + MIN, null, null],
      ["fail", "get", "api", "EIO", 0], ["put", "api", V2, T0 + MIN, null, null],
      ["fail", "set", "api", "EIO", 0], ["put", "api", V2, T0 + MIN, null, null],
      ["fail", "set", I, "ENOSPC", 0], ["put", "api", V2, T0 + MIN, null, null],
      ["fail", "new", I, null, 1], ["put", "api", V2, T0 + MIN, null, null],
      ["fail", "set", I, "ENOSPC", 0], ["put", "fresh", V2, T0 + MIN, null, null],
      ["get", "api"], ["get", "fresh"], ["list"],
      ["fail", "set", I, "ENOSPC", 0], ["fail", "set", "api", "EIO", 1], ["put", "api", V2, T0 + MIN, null, null],
      ["get", "api"], ["list"],
      ["fail", "set", I, null, 0], ["fail", "delete", "fresh2", "EIO", 0], ["put", "fresh2", V2, T0 + MIN, null, null],
      ["get", "fresh2"], ["list"],
      ["put", "api", V1, T0 + 2 * MIN, null, null],
      ["fail", "get", I, "EIO", 0], ["describe", "api", "a text", T0 + 3 * MIN, null],
      ["fail", "new", "api", null, 0], ["describe", "api", "a text", T0 + 3 * MIN, null],
      ["fail", "get", "api", "EIO", 0], ["describe", "api", "a text", T0 + 3 * MIN, null],
      ["fail", "set", I, "ENOSPC", 0], ["describe", "api", "a text", T0 + 3 * MIN, null],
      ["fail", "new", I, null, 1], ["describe", "api", "a text", T0 + 3 * MIN, null],
      ["list"],
      ["fail", "get", I, "EIO", 0], ["delete", "api"],
      ["fail", "new", "api", null, 0], ["delete", "api"],
      ["fail", "delete", "api", "EBUSY", 0], ["delete", "api"],
      ["fail", "set", I, "ENOSPC", 0], ["delete", "api"],
      ["get", "api"], ["list"],
      ["describe", "api", "a text", T0 + 4 * MIN, null],
      ["delete", "api"], ["delete", "api"], ["delete", "fresh2"], ["list"],
    ] },
    { name: "a-corrupt-index", steps: corruptSteps },
    { name: "members-this-version-does-not-know", steps: [
      ["seed", I, foreign], ["seed", "api", V1], ["seed", "zeta", V2],
      ["put", "other", V3, T0 + 3 * MIN, null, null],
      ["put", "api", V2, T0 + 4 * MIN, "owner:local", null],
      ["describe", "zeta", "a new text", T0 + 5 * MIN, null],
      ["delete", "other"],
      ["put", "9", V3, T0 + 6 * MIN, null, null],
      ["delete", "zeta"],
      ["put", "blank", V1, T0 + 7 * MIN, null, null],
    ] },
    { name: "entries-that-delete-a-credential", variant: "credential", steps: [
      ["put", "api", V1, T0, null, null], ["delete", "api"], ["delete", "api"],
      ["fail", "set", I, "ENOSPC", 0], ["put", "fresh", V2, T0 + MIN, null, null], ["get", "fresh"],
      ["put", "api", V1, T0 + 2 * MIN, null, null],
      ["fail", "delete", "api", "EBUSY", 0], ["delete", "api"], ["delete", "api"], ["list"],
    ] },
    { name: "foreign-members-in-an-answer", note: "P4D-32: TypeScript spreads the whole index entry into the answer of `list`, so `name`, `backend` and any other member written from outside show; Rust answers with the known members, the name being the key", steps: [
      ["seed", I, index({ api: { ...sound, name: "another-name", backend: "file", extra: 1, updatedBy: 5 }, plain: { ...sound, updatedBy: "" } })],
      ["list"],
    ] },
    { name: "a-time-no-date-can-hold", note: "P4D-32: TypeScript writes the value, then throws at toISOString, and the index never learns of it; Rust fails before the write", steps: [
      ["put", "api", V1, T0, null, null],
      ["put", "api", V2, INVALID_TIME, null, null],
      ["get", "api"], ["list"],
      ["put", "fresh", V2, INVALID_TIME, null, null],
      ["get", "fresh"], ["list"],
    ] },
  ];
  const run: unknown[] = [];
  for (const sc of scenarios) run.push(await runKeyring(sc));
  return { service: KEYRING_SERVICE, schema: INDEX_SCHEMA, indexAccount: INDEX_ACCOUNT, probeAccount: PROBE_ACCOUNT, scenarios: run };
}

// --- main ----------------------------------------------------------------------------------------------------------------------
export async function buildSecretsStoreVectors(): Promise<Record<string, any>> {
  return { registry: buildRegistry(), "file-backend": await buildFileBackend(), "keyring-backend": await buildKeyring(), store: await buildStore() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "secrets-store", build: buildSecretsStoreVectors });
}
