// Parity vectors (mode V) for the stateful parts of the secret store (P4-20, library): the redaction registry
// (`secrets/redaction.ts`: named slots, groups, the bound of retired values, subscribers, `mask`, `contains`).
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
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";

const SRC = "../../packages/core/src/secrets";
const { createSecretRedaction, MAX_REGISTERED_SECRETS } = await import(`${SRC}/redaction.ts`);

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

// --- main ----------------------------------------------------------------------------------------------------------------------
export async function buildSecretsStoreVectors(): Promise<Record<string, any>> {
  return { registry: buildRegistry() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "secrets-store", build: buildSecretsStoreVectors });
}
