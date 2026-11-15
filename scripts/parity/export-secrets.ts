// Parity vectors (mode V) for the pure parts of the secret store (P4-20, first library commit): `secrets/types.ts` (the name,
// value and description rules, `shortValueWarning`, `nextDescription`, `backendFailure`, the constants), `leases.ts` (the lease
// table over a scripted clock and scripted ids), `memory-backend.ts` (operation sequences, including the order of `list`, which
// is `localeCompare`) and, from `audit.ts`, `sanitizeDetail` and the actor's `user` string. `crates/plur1bus-core/src/secrets/vectors.rs`
// replays every file. Recorded, never edited by hand.
//
// STRINGS. An input string is a *spec*: a JSON string, `{"u16": [units]}` (a string that is not well-formed UTF-16, which JSON cannot
// hold), `{"rep": [spec, n]}` (the spec n times; a value at its 64 KiB limit is not written out) or `{"cat": [spec, ...]}`. An input that
// may be absent is `{"undefined": true}`; any other JSON value (a number, `null`, an object) is a non-string input. A result string
// is a JSON string or `{"u16": [...]}`. A result is `{"ok": ...}`, `{"err": {code, message, detail}}` (a SecretError) or
// `{"throw": name}` (anything else the TypeScript throws).
//
// RANDOMNESS AND TIME. `randomBytes` of `node:crypto` is wrapped (before `leases.ts` draws, then `syncBuiltinESMExports`) to return
// scripted values when a script is queued, as `export-identity.ts` does; the source files stay untouched. The lease clock is a
// closure that returns the scripted time of the step and counts its calls (`clockCalls`): the Rust table must read its clock as
// often as the TypeScript one does. A secret name is ordered by `localeCompare` of the machine's ICU (root collation for these
// characters; the exporter checks it against `Intl.Collator("en-US")`).
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-secrets.ts [--check]
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";

const realRandomBytes = crypto.randomBytes;
const scriptedBytes: Buffer[] = [];
(crypto as any).randomBytes = (n: number, ...rest: any[]) => {
  const next = scriptedBytes.shift();
  if (next === undefined) return (realRandomBytes as any)(n, ...rest);
  if (next.length !== n) throw new Error(`scripted ${next.length} bytes for a draw of ${n}`);
  return Buffer.from(next);
};
syncBuiltinESMExports();

const SRC = "../../packages/core/src/secrets";
const T = await import(`${SRC}/types.ts`);
const { createLeaseTable, DEFAULT_LEASE_TTL_MS, MAX_LEASE_TTL_MS } = await import(`${SRC}/leases.ts`);
const { createMemoryBackend } = await import(`${SRC}/memory-backend.ts`);
const A = await import(`${SRC}/audit.ts`);
const { SecretError } = T;

// --- encoding --------------------------------------------------------------------------------------------------------------------
/** A string for a fixture: as is when well-formed, else its code units. */
const codec = (s: string): unknown => (s.isWellFormed() ? s : { u16: Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)) });
/** A result value: `undefined` is `{undefined: true}`, a string is `codec`, anything else as is. */
const enc = (x: unknown): unknown => (x === undefined ? { undefined: true } : typeof x === "string" ? codec(x) : x);
/** A string input with its spec: `v` goes to the TypeScript, `spec` to the fixture. */
class Sv { v: string; spec: unknown; constructor(v: string, spec: unknown) { this.v = v; this.spec = spec; } }
const lit = (s: string) => new Sv(s, codec(s));
const asSv = (x: string | Sv): Sv => (x instanceof Sv ? x : lit(x));
const rep = (x: string | Sv, n: number) => { const p = asSv(x); return new Sv(p.v.repeat(n), { rep: [p.spec, n] }); };
const cat = (...xs: (string | Sv)[]) => { const ps = xs.map(asSv); return new Sv(ps.map((p) => p.v).join(""), { cat: ps.map((p) => p.spec) }); };
/** An input that may be any JavaScript value. */
interface In { v: unknown; spec: unknown }
const I = (x: unknown): In => (x instanceof Sv ? x : typeof x === "string" ? lit(x) : x === undefined ? { v: undefined, spec: { undefined: true } } : { v: x, spec: x });
const errOf = (e: any) => (e instanceof SecretError ? { err: { code: e.code, message: e.message, detail: { ...e.detail } } } : { throw: e?.name ?? typeof e });
const run = (fn: () => unknown, ok: (v: any) => unknown = enc) => { try { return { ok: ok(fn()) }; } catch (e) { return errOf(e); } };
const table = (fields: string[], cases: unknown[][]) => ({ fields, cases });
const dedupe = <X extends { spec: unknown }>(list: X[]): X[] => { const seen = new Set<string>(); return list.filter((x) => { const k = JSON.stringify(x.spec); if (seen.has(k)) return false; seen.add(k); return true; }); };
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const SPACES: string[] = (() => { const out: string[] = []; for (let c = 0; c <= 0xffff; c++) if (/\s/.test(String.fromCharCode(c))) out.push(String.fromCharCode(c)); if (out.length !== 25) throw new Error(`\\s has ${out.length} members`); return out; })();
const ASCII: string[] = Array.from({ length: 128 }, (_, c) => String.fromCharCode(c));
const EMOJI = "\u{1F600}";
const CONTROLS: string[] = [...Array.from({ length: 0x20 }, (_, c) => String.fromCharCode(c)), ...Array.from({ length: 0x21 }, (_, c) => String.fromCharCode(0x7f + c)), " ", " "];

// --- constants -------------------------------------------------------------------------------------------------------------------
/** The key names `sanitizeDetail` reads, in the order it reads them (a proxy that records the reads). */
function detailKeys(): string[] {
  const keys: string[] = [];
  A.sanitizeDetail(new Proxy({}, { get: (_t, k) => { keys.push(String(k)); return "x"; } }) as any);
  return keys;
}
function buildConstants() {
  return {
    constants: { MAX_VALUE_BYTES: T.MAX_VALUE_BYTES, MIN_SECRET_SURFACE: T.MIN_SECRET_SURFACE, MAX_DESCRIPTION_CHARS: T.MAX_DESCRIPTION_CHARS, MIN_REDACTED_VALUE_CHARS: T.MIN_REDACTED_VALUE_CHARS,
      MIN_DESCRIPTION_VALUE_CHARS: T.MIN_DESCRIPTION_VALUE_CHARS, DEFAULT_LEASE_TTL_MS, MAX_LEASE_TTL_MS },
    detailKeys: detailKeys(),
    // `SecretErrorCode` and `AuditAction` are TypeScript types (erased), so these two lists are written out here; the Rust enums are
    // checked against them, and every code the slice raises is recorded as a result in the other files.
    errorCodes: ["denied", "not-found", "invalid-name", "invalid-value", "invalid-description", "invalid-ttl", "no-backend", "backend-unavailable", "corrupt", "storage", "audit-unavailable", "lease-invalid"],
    auditActions: ["secret.describe", "secret.set", "secret.get", "secret.reveal", "secret.delete", "secret.list", "secret.lease", "secret.lease.read", "secret.lease.revoke", "secret.denied"],
    backendKinds: ["keyring", "file", "memory"],
  };
}

// --- validation ------------------------------------------------------------------------------------------------------------------
function nameInputs(): In[] {
  const out: In[] = [];
  const push = (...xs: unknown[]) => { for (const x of xs) out.push(I(x)); };
  push("a", "A", "0", "9", "a.b", "a_b", "a:b", "a/b", "a@b", "a-b", "a b", "", " ", "name", "Name-1", "x.y_z:1/2@3-4", "a/b/c", "a--", "9-", "0a", "A0");
  for (const c of ASCII) push(c, `a${c}`, `${c}a`, `a${c}b`);
  push(rep("a", 127), rep("a", 128), rep("a", 129), cat("a", rep("-", 126)), cat("a", rep("-", 127)), cat("a", rep("-", 128)), rep("0", 128), rep("0", 129), cat(rep("a", 127), "\n"), cat(rep("a", 128), "\n"));
  push("é", "aé", "éa", "ａ", "aａ", EMOJI, `a${EMOJI}`, "\ud800", "a\ud800", "a\udc00", "a\n", "a\r\n", "\na", "a ", "a ", " a", "a\u0000", "aİ", "aK");
  push("ext:x:Y", "ext:x:y", "ext:X:Y", "ext:-:Y", "ext:.:Y", "ext:_:Y", "ext:x:1", "ext:x:_", "ext:x:", "ext::Y", "ext:x", "ext:", "ext", "Ext:x:Y", "ext:x:Y:z", "ext:x y:Y", "ext:x:Y y", "ext:x:Y-z", "ext:x:Y.z", "ext:x:Y_z");
  // Slots over the generic 128 limit: only the extension rule can accept them (segment of 1..64, slot of 1..64).
  const seg = (first: string, n: number, rest = "b") => cat(first, rep(rest, n - 1));
  for (const n1 of [1, 63, 64, 65]) for (const n2 of [1, 63, 64, 65]) {
    push(cat("ext:", seg("x", n1), ":", seg("Y", n2, "z")), cat("ext:", seg("x", n1), ":", seg("Y", n2, "_")), cat("ext:", seg("x", n1, "."), ":", seg("Y", n2, "9")));
  }
  for (const first of ["x", "0", "X", "-", ".", "_"]) for (const slot of ["Y", "y", "1", "_", "-"]) push(cat("ext:", seg(first, 64), ":", seg(slot, 64, "z")));
  for (const rest of ["-", ".", "_", ":", "/", "@", "A", " "]) push(cat("ext:", seg("x", 64, rest), ":", seg("Y", 64, "z")), cat("ext:", seg("x", 64), ":", seg("Y", 64, rest)));
  push(undefined, null, 5, 0, true, {}, [], ["a"], { a: 1 });
  return dedupe(out);
}
function valueInputs(): In[] {
  const out: In[] = [];
  const push = (...xs: unknown[]) => { for (const x of xs) out.push(I(x)); };
  push("", "a", "ab", "correct horse battery", "a b c", " ", "\u0000", "a\u0000", "\u0000a", "a\u0000b", "\u0001", "\n", "\u007f", " ", "\ud800", "\udc00", "\udc00\ud800", "😀", EMOJI, "é");
  push(rep("a", 65535), rep("a", 65536), rep("a", 65537), rep("é", 32767), rep("é", 32768), rep("é", 32769), rep("€", 21845), rep("€", 21846));
  push(rep(EMOJI, 16383), rep(EMOJI, 16384), rep(EMOJI, 16385), rep("\ud800", 21845), rep("\ud800", 21846), rep("\udc00", 21845), rep("\udc00", 21846));
  push(cat(rep("\ud800", 21845), "a"), cat(rep("\ud800", 21845), "ab"), cat(rep("a", 65532), EMOJI), cat(rep("a", 65533), EMOJI), cat(rep("a", 65533), "\ud800"), cat(rep("a", 65534), "\ud800"));
  push(cat(rep("a", 65537), "\u0000"), cat("\u0000", rep("a", 65537)), cat(rep("a", 65536), "\u0000"), cat(rep("€", 21845), "\u0000"));
  push(undefined, null, 5, true, {}, [], ["a"]);
  return dedupe(out);
}
function shortInputs(): Sv[] {
  const out: Sv[] = [];
  for (let n = 0; n <= 10; n++) out.push(rep("a", n), rep(EMOJI, n), rep("é", n), rep("\ud800", n));
  out.push(lit("correct horse battery"), lit("a\u0000b"), lit("1234567"), lit("12345678"), lit("1234567é"), lit("123😀"), lit("1234😀"), lit("12345😀"));
  return dedupe(out);
}
function descriptionCases(): [In, In][] {
  const V = "correct horse battery";
  const out: [In, In][] = [];
  const add = (d: unknown, v?: unknown) => out.push([I(d), I(v)]);
  add(undefined); add(""); add(" "); add("  x  "); add("x"); add("a b c"); add("a\tb"); add("What it is for");
  for (const sp of SPACES) add(sp), add(`${sp}x${sp}`), add(`x${sp}y`), add(cat(sp, rep("a", 200), sp));
  for (const c of CONTROLS) add(c), add(`a${c}b`), add(`${c}a`), add(`a${c}`), add(`${c}a${c}`);
  for (const n of [199, 200, 201, 202]) { add(rep("a", n)); add(rep(EMOJI, n)); add(rep("\ud800", n)); add(rep("é", n)); add(rep("\udc00", n)); }
  add(cat(" ", rep("a", 200), " ")); add(cat(" ", rep("a", 201), " ")); add(cat(rep("a", 199), EMOJI)); add(cat(rep("a", 200), EMOJI)); add(cat(rep("a", 198), "😀", "b"));
  add("😀"); add("\ude00\ud83d"); add(cat(rep("\ude00\ud83d", 100))); add(cat(rep("\ude00\ud83d", 101)));
  add(cat(rep("a", 201), "\n")); add(cat(rep("a", 201), "\u0000")); add(cat("\u0000", rep("a", 201))); add(cat(rep("a", 200), "\u0000"));
  for (const bad of [5, 0, null, true, {}, [], ["a"]]) { add(bad); add(bad, V); }
  // With the secret's value: its whole, a fragment of eight code points, and what is not.
  add(undefined, V); add("", V); add("uses correct horse battery here", V); add(V, V); add("correct horse battery", V);
  for (const frag of ["correct ", "orrect h", "rect hor", "ttery", "battery", "t horse b", "horse ba", "e battery", "correct", "correc", "Correct ", "correct "]) { add(frag, V); add(`x ${frag}`, V); add(`${frag} y`, V); }
  add("cor rect hor se batt ery", V); add("correct hors", V); add("horse b", V); add("a horse ba", V);
  const SHORT = "abc1234";
  add("token abc1234 here", SHORT); add("abc1234", SHORT); add("abc12345", SHORT);
  const EIGHT = "abcd1234";
  add("x abcd1234 y", EIGHT); add("abcd123", EIGHT); add("bcd1234 ", EIGHT); add("zabcd1234", EIGHT);
  add("abcdefgh", " abcdefgh"); add(" abcdefgh", " abcdefgh"); add("abcdefg", " abcdefgh"); add("bcdefgh ", "abcdefgh ");
  const ASTRAL = "\u{1F600}\u{1F601}\u{1F602}\u{1F923}\u{1F603}\u{1F604}\u{1F605}\u{1F606}\u{1F607}\u{1F608}";
  add("\u{1F600}\u{1F601}\u{1F602}\u{1F923}\u{1F603}\u{1F604}\u{1F605}\u{1F606}", ASTRAL); add("\u{1F600}\u{1F601}\u{1F602}\u{1F923}\u{1F603}\u{1F604}\u{1F605}", ASTRAL);
  add("\u{1F601}\u{1F602}\u{1F923}\u{1F603}\u{1F604}\u{1F605}\u{1F606}\u{1F607}", ASTRAL); add("\u{1F601}\u{1F602}\u{1F923}\u{1F603}\u{1F604}\u{1F605}\u{1F606}x", ASTRAL); add(`x${ASTRAL}`, ASTRAL);
  add(rep(EMOJI, 4), rep(EMOJI, 4)); add(rep(EMOJI, 3), rep(EMOJI, 3)); add(`a${rep(EMOJI, 3).v}`, rep(EMOJI, 3)); add(rep(EMOJI, 8), rep(EMOJI, 4)); add(rep(EMOJI, 7), rep(EMOJI, 4));
  add("\ud800abcdefg", "\ud800abcdefg"); add("xabcdefg\ud800", "\ud800abcdefg"); add("\ud800abcdefgh", "\ud800abcdefg"); add("abcdefgh", "\ud800abcdefgh"); add("\udc00abcdefg", "ab\udc00abcdefg");
  add("\u{1F600}cdefgh", "ab\u{1F600}cdefgh"); add("b\u{1F600}cdefgh", "ab\u{1F600}cdefgh"); add("b\u{1F600}cdefg", "ab\u{1F600}cdefgh");
  add("", ""); add("abcdefgh", ""); add("a", "a"); add("abcdefgh", "abcdefgh");
  add(rep("a", 8), rep("a", 65536)); add(rep("b", 200), rep("a", 65536)); add("abcdefgh", rep("a", 65536)); add(cat(rep("a", 7), "b"), rep("a", 65536));
  add("a\nb", V); add("\u0000correct ", V); add(cat(rep("a", 201), V), V); add("uses correct horse battery\n", V); add("\ncorrect horse battery", V); add("\u0085correct horse battery", V);
  return out;
}
function backendFailureCases() {
  const cases: unknown[][] = [];
  const add = (desc: unknown, err: unknown, what: string) => cases.push([desc, what, run(() => { throw T.backendFailure(err, what); }, () => 0)]);
  const sec = (code: string, message: string, detail?: Record<string, string | number | boolean>) => add({ kind: "secret", code, message, detail: detail ?? {} }, new SecretError(code as any, message, detail), "reading the file");
  sec("corrupt", "secret file is corrupt"); sec("storage", "write failed (EIO)", { cause: "EIO" }); sec("denied", "not allowed"); sec("invalid-name", "secret name must match x");
  for (const code of ["ENOENT", "EACCES", "EPERM", "EIO", "ENOSPC", "", "ERR_X", "é", "a b"]) add({ kind: "code", code }, Object.assign(new Error("platform text that must not be forwarded"), { code }), "writing the secret file");
  add({ kind: "none" }, new Error("boom"), "reading the keyring"); add({ kind: "none" }, null, "reading the keyring"); add({ kind: "none" }, undefined, "x"); add({ kind: "none" }, "text", "x"); add({ kind: "none" }, 5, "x");
  add({ kind: "none" }, { code: 5 }, "a thing"); add({ kind: "none" }, { code: null }, "a thing"); add({ kind: "none" }, { code: ["ENOENT"] }, "a thing"); add({ kind: "code", code: "EEXIST" }, { code: "EEXIST" }, "");
  add({ kind: "code", code: "E" }, { code: "E" }, "deleting \"a\""); add({ kind: "none" }, {}, "a thing");
  return cases;
}
export function buildValidation() {
  const names = nameInputs(), values = valueInputs(), shorts = shortInputs(), descs = descriptionCases();
  const given = [undefined, "", "x", "y"];
  return {
    isName: table(["input", "expected"], names.map((n) => [n.spec, T.isSecretName(n.v)])),
    checkName: table(["input", "expected"], names.map((n) => [n.spec, run(() => T.checkName(n.v))])),
    checkValue: table(["input", "expected"], values.map((v) => [v.spec, run(() => T.checkValue(v.v), () => true)])),
    shortValue: table(["input", "expected"], shorts.map((s) => [s.spec, T.shortValueWarning(s.v) ?? { undefined: true }])),
    checkDescription: table(["description", "value", "expected"], descs.map(([d, v]) => [d.spec, v.spec, run(() => T.checkDescription(d.v, v.v as string | undefined))])),
    nextDescription: table(["old", "given", "expected"], given.flatMap((o) => given.map((g) => [enc(o), enc(g), enc(T.nextDescription(o, g))]))),
    backendFailure: table(["cause", "what", "expected"], backendFailureCases()),
  };
}

// --- name order (`localeCompare`, the order of `list`) -----------------------------------------------------------------------------
function buildNameOrder() {
  const names = new Set<string>();
  const alpha = ["a", "A", "b", "B", "z", "Z", "0", "1", "9", ".", "_", ":", "/", "@", "-"];
  const small = ["a", "A", "b", "0", ".", "_", "/", "-"];
  for (const x of alpha) { names.add(x); for (const y of alpha) names.add(x + y); }
  for (const x of small) for (const y of small) for (const z of small) names.add(x + y + z);
  for (const n of ["a", "a-", "a-b", "a.b", "a_b", "a:b", "a/b", "a@b", "ab", "aB", "Ab", "AB", "a-B", "A-b", "a1", "a10", "a2", "a-1", "a_1", "a.1", "a:1", "a/1", "A1", "a1a", "a1A", "abc", "abC", "aBc", "aBC", "Abc", "AbC", "ABc", "ABC",
    "ext:x:Y", "ext:x:y", "ext:X:Y", "ext:x:y1", "ext:x:y_1", "ext:x.y:Z", "ext:x-y:Z", "ext:xy:Z", "ext:x_y:Z", "ext", "ext:", "extx", "ext-x", "ext.x", "ext_x", "ext/x", "ext@x", "openai", "OpenAI", "open-ai", "open_ai", "open.ai", "open:ai", "open/ai", "open@ai",
    "provider/key", "provider/Key", "Provider/key", "provider:key", "provider.key", "provider_key", "provider-key", "provider@key", "a".repeat(128), "a".repeat(127), "A".repeat(128), "a".repeat(127) + "A", "a".repeat(127) + "b", "a".repeat(127) + "-", "0".repeat(128), "9".repeat(127), "z".repeat(60) + "-" + "a".repeat(60)]) names.add(n);
  const all = [...names];
  const sorted = [...all].sort((a, b) => a.localeCompare(b));
  // The machine's order must be the root collation the Rust function reproduces, and must tie nothing.
  const collator = new Intl.Collator("en-US");
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!, b = sorted[i + 1]!;
    if (a.localeCompare(b) >= 0 || collator.compare(a, b) >= 0) throw new Error(`name order is not the root collation at ${JSON.stringify([a, b])}`);
  }
  // The same order from the real backend (`list`), for the names a backend can hold.
  const valid = sorted.filter((n) => T.isSecretName(n));
  const rand = mulberry32(0x5ec7e75);
  const shuffled = (list: string[]) => { const out = [...list]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; } return out; };
  const input = shuffled(all);
  const pairs: unknown[][] = [];
  const pick = () => all[Math.floor(rand() * all.length)]!;
  for (let i = 0; i < 300; i++) { const a = pick(), b = pick(); pairs.push([a, b, Math.sign(a.localeCompare(b))]); }
  for (const [a, b] of [["a", "a"], ["a", "A"], ["A", "a"], ["a-", "a"], ["a", "a-"], ["a_", "a-"], ["a-", "a:"], ["a:", "a."], ["a.", "a@"], ["a@", "a/"], ["a/", "a0"], ["a9", "aa"], ["aZ", "ba"], ["Ab", "aB"], ["aB", "Ab"], ["ab", "aB"], ["aB", "ab"], ["a-B", "a-b"], ["ab-", "aB-"], ["a_a", "a-a"], ["_", "a"], ["-", "_"], [".", ":"]])
    pairs.push([a, b, Math.sign(a!.localeCompare(b!))]);
  return { valid, file: { input, sorted, pairs: { fields: ["a", "b", "expected"], cases: pairs } } };
}

// --- leases ----------------------------------------------------------------------------------------------------------------------
type Step = Record<string, any>;
function runLeases(sc: { name: string; ids: string[]; steps: Step[] }) {
  let now = 0, calls = 0;
  const table = createLeaseTable(() => { calls++; return now; });
  scriptedBytes.length = 0;
  for (const id of sc.ids) scriptedBytes.push(Buffer.from(id, "hex"));
  const info = (l: any) => ({ leaseId: l.leaseId, name: l.name, expiresAt: l.expiresAt, purpose: enc(l.purpose), profileId: enc(l.profileId) });
  const lease = (l: any, value: string) => {
    const json = JSON.stringify(l), shown = inspect(l);
    if ((value.length >= 8 && (json.includes(value) || shown.includes(value))) || !json.includes("[redacted]") || !shown.includes("[redacted]") || !Object.isFrozen(l) || l.value !== value) throw new Error(`lease leaks or is not frozen: ${json} ${shown}`);
    return { ...info(l), value: enc(l.value), json: enc(json), inspect: enc(shown), frozen: true };
  };
  const steps = sc.steps.map((s) => {
    now = s.now; calls = 0;
    let out: unknown;
    switch (s.op) {
      case "issue": { const o: any = { purpose: s.purpose, profileId: s.profileId }; if (s.ttl !== undefined) o.ttlMs = Number(s.ttl); if (s.ttlNull) o.ttlMs = null; out = run(() => table.issue(s.name, s.value, o), (l) => lease(l, s.value)); break; }
      case "read": out = run(() => table.read(s.leaseId), (l) => lease(l, l.value)); break;
      case "revoke": out = run(() => table.revoke(s.leaseId)); break;
      case "revokeName": out = run(() => table.revokeName(s.name)); break;
      case "active": out = run(() => table.active().map(info)); break;
      default: throw new Error(`unknown op ${s.op}`);
    }
    return { ...s, out, clockCalls: calls };
  });
  if (scriptedBytes.length) throw new Error(`${sc.name}: ${scriptedBytes.length} scripted ids unused`);
  return { name: sc.name, ids: sc.ids, steps };
}
function buildLeases() {
  const rand = mulberry32(0x1ea5e);
  const id = () => Buffer.from(Array.from({ length: 16 }, () => Math.floor(rand() * 256))).toString("hex");
  const ids = (n: number) => Array.from({ length: n }, id);
  const V = "correct horse battery";
  const issue = (now: number, name: string, value: string, o: Step = {}): Step => ({ op: "issue", now, name, value, purpose: "deploy", profileId: "p1", ...o });
  const read = (now: number, leaseId: string): Step => ({ op: "read", now, leaseId });
  const lseIds = ids(40);
  const lse = (i: number) => `lse_${lseIds[i]}`;
  const T0 = 1_800_000_000_000;
  const scenarios = [
    { name: "default-ttl-expiry", ids: lseIds.slice(0, 1), steps: [issue(T0, "openai", V), read(T0, lse(0)), read(T0 + 59_999, lse(0)), read(T0 + 60_000, lse(0)), read(T0 + 60_000, lse(0)), read(T0, lse(0)), { op: "active", now: T0 }] },
    { name: "ttl-rules", ids: lseIds.slice(0, 8), steps: [
      issue(T0, "n", V, { ttl: "1" }), issue(T0, "n", V, { ttl: "300000" }), issue(T0, "n", V, { ttl: "0" }), issue(T0, "n", V, { ttl: "-1" }), issue(T0, "n", V, { ttl: "300001" }), issue(T0, "n", V, { ttl: "1.5" }), issue(T0, "n", V, { ttl: "NaN" }),
      issue(T0, "n", V, { ttl: "Infinity" }), issue(T0, "n", V, { ttl: "-Infinity" }), issue(T0, "n", V, { ttl: "1e3" }), issue(T0, "n", V, { ttl: "2.0" }), issue(T0, "n", V, { ttl: "-0" }), issue(T0, "n", V, { ttl: "1e21" }), issue(T0, "n", V, { ttl: "0.5" }),
      issue(T0, "n", V, { ttlNull: true }), issue(T0, "n", V), issue(T0, "n", V, { ttl: "299999" }), issue(T0, "n", V, { ttl: "60000" }), { op: "active", now: T0 }, { op: "active", now: T0 + 1 }, { op: "active", now: T0 + 1_000 }, { op: "active", now: T0 + 60_000 }, { op: "active", now: T0 + 300_000 }] },
    { name: "revoke-and-revoke-name", ids: lseIds.slice(8, 12), steps: [
      issue(T0, "a", "value-a-one"), issue(T0 + 10, "b", "value-b-one", { purpose: "x", profileId: "p2" }), issue(T0 + 20, "a", "value-a-two", { ttl: "5000" }), issue(T0 + 30, "c", "value-c-one"),
      { op: "active", now: T0 + 40 }, { op: "revoke", now: T0 + 40, leaseId: lse(9) }, { op: "revoke", now: T0 + 40, leaseId: lse(9) }, { op: "revoke", now: T0 + 40, leaseId: "lse_unknown" }, { op: "revoke", now: T0 + 40, leaseId: "" },
      read(T0 + 41, lse(9)), read(T0 + 41, lse(8)), { op: "revokeName", now: T0 + 50, name: "a" }, { op: "revokeName", now: T0 + 50, name: "a" }, { op: "revokeName", now: T0 + 50, name: "zz" }, { op: "revokeName", now: T0 + 50, name: "" },
      read(T0 + 51, lse(10)), { op: "active", now: T0 + 52 }, { op: "revokeName", now: T0 + 53, name: "c" }, { op: "active", now: T0 + 54 }, { op: "revoke", now: T0 + 55, leaseId: lse(11) }, { op: "active", now: T0 + 56 }] },
    { name: "sweep-on-issue-and-active", ids: lseIds.slice(14, 18), steps: [
      issue(T0, "a", "value-a-one", { ttl: "1000" }), issue(T0, "b", "value-b-one", { ttl: "2000" }), issue(T0, "c", "value-c-one", { ttl: "3000" }), { op: "active", now: T0 + 999 }, { op: "active", now: T0 + 1000 },
      issue(T0 + 2000, "d", "value-d-one", { ttl: "10" }), { op: "active", now: T0 + 2001 }, { op: "active", now: T0 + 2010 }, issue(T0 + 2010, "e", "value-e-one", { ttl: "0" }), { op: "active", now: T0 + 2010 },
      read(T0 + 2999, lse(15)), read(T0 + 3000, lse(16)), read(T0 + 3000, lse(16))] },
    { name: "unknown-and-odd-ids", ids: [], steps: [read(T0, "lse_unknown"), read(T0, ""), read(T0, "LSE_UPPER"), { op: "revoke", now: T0, leaseId: "lse_unknown" }, { op: "revokeName", now: T0, name: "x" }, { op: "active", now: T0 }] },
    { name: "json-and-inspect-forms", ids: lseIds.slice(20, 26), steps: [
      issue(T0, "q", V, { purpose: 'say "hi" \\ back', profileId: "line\nbreak" }), issue(T0, "q", V, { purpose: "u+2028   and   and del \u007f", profileId: "pé" }), issue(T0, "q", V, { purpose: `emoji ${EMOJI} and tab\t`, profileId: "" }),
      issue(T0, "q", V, { purpose: "", profileId: "p" }), issue(T0, "q", V, { purpose: "x".repeat(300), profileId: "y".repeat(300) }), issue(T0, "ext:x:Y", V, { ttl: "123" }),
      read(T0 + 1, lse(20)), read(T0 + 1, lse(21)), read(T0 + 1, lse(22)), { op: "active", now: T0 + 2 }] },
    { name: "clock-edges", ids: lseIds.slice(26, 29), steps: [
      issue(0, "zero", "value-zero-one", { ttl: "1" }), read(0, lse(26)), read(1, lse(26)), issue(-5_000, "neg", "value-neg-one", { ttl: "5000" }), read(-1, lse(27)), read(0, lse(27)),
      issue(8_640_000_000_000_000 - 1, "late", "value-late-one", { ttl: "1" }), read(8_640_000_000_000_000 - 1, lse(28)), { op: "active", now: 8_640_000_000_000_000 }] },
  ];
  return { scenarios: scenarios.map(runLeases) };
}

// --- memory backend --------------------------------------------------------------------------------------------------------------
async function runMemory(sc: { name: string; available?: boolean; steps: Step[] }) {
  const b = createMemoryBackend(sc.available === undefined ? {} : { available: sc.available });
  const meta = (m: any) => ({ name: m.name, backend: m.backend, createdAt: m.createdAt, updatedAt: m.updatedAt, ...(m.updatedBy !== undefined ? { updatedBy: enc(m.updatedBy) } : {}), ...(m.description !== undefined ? { description: enc(m.description) } : {}) });
  const steps: Step[] = [];
  for (const s of sc.steps) {
    const registered: unknown[] = [];
    const reg = s.register ? (v: string) => { registered.push(enc(v)); } : undefined;
    let out: unknown;
    try {
      switch (s.op) {
        case "probe": out = { ok: await b.probe() }; break;
        case "get": out = { ok: enc(await b.get(s.name)) }; break;
        case "put": out = { ok: meta(await b.put(s.name, s.value, new Date(s.now), s.by, s.desc, reg)) }; break;
        case "describe": out = { ok: meta(await b.describe(s.name, s.desc, new Date(s.now), s.by, reg)) }; break;
        case "delete": out = { ok: await b.delete(s.name) }; break;
        case "list": out = { ok: (await b.list()).map(meta) }; break;
        case "dump": out = { ok: [...b.dump()].map(([k, v]) => [k, enc(v)]) }; break;
        case "setAvailable": b.available = s.available; out = { ok: true }; break;
        default: throw new Error(`unknown op ${s.op}`);
      }
    } catch (e) { out = errOf(e); }
    steps.push({ ...s, out, ...(s.register ? { registered } : {}) });
  }
  return { name: sc.name, ...(sc.available === undefined ? {} : { available: sc.available }), steps };
}
async function buildMemory() {
  const T0 = 1_800_000_000_000;
  const put = (now: number, name: string, value: string, o: Step = {}): Step => ({ op: "put", now, name, value, ...o });
  const describe = (now: number, name: string, desc: string, o: Step = {}): Step => ({ op: "describe", now, name, desc, ...o });
  const get = (name: string): Step => ({ op: "get", name });
  const del = (name: string): Step => ({ op: "delete", name });
  const list: Step = { op: "list" }, dump: Step = { op: "dump" };
  const V = "correct horse battery";
  const order = ["b", "B", "a", "A", "a-b", "a_b", "a.b", "a:b", "a/b", "a@b", "ab", "aB", "Ab", "a1", "a10", "a2", "A1", "z", "0", "9", "ext:x:Y", "ext:x:y", "openai", "OpenAI", "open-ai", "open_ai", "provider/key", "provider/Key", "Provider/key"];
  const scenarios = [
    { name: "put-overwrite-describe-delete", steps: [
      get("k1"), put(T0, "k1", V, { by: "alice", desc: "first", register: true }), get("k1"), list,
      put(T0 + 1000, "k1", "second value here", { register: true }), list, put(T0 + 2000, "k1", "third value here", { by: "bob", desc: "new words", register: true }), list,
      put(T0 + 3000, "k1", "fourth value here", { desc: "" }), list, put(T0 + 4000, "k1", "fifth value here", { desc: "  padded  " }), list,
      describe(T0 + 5000, "k1", "  trimmed  ", { register: true }), list, describe(T0 + 6000, "k1", "", { by: "carol" }), list, describe(T0 + 7000, "k1", "again", {}), list,
      describe(T0 + 8000, "missing", "x", { register: true }), dump, del("k1"), del("k1"), get("k1"), list, dump] },
    { name: "updated-by-and-empty-by", steps: [
      put(T0, "a", "value-a-one", { by: "" }), list, put(T0 + 1, "a", "value-a-two", { by: "x" }), list, put(T0 + 2, "a", "value-a-three"), list, put(T0 + 3, "b", "value-b-one", { by: "who" }), describe(T0 + 4, "b", "text"), list,
      describe(T0 + 5, "b", "more", { by: "" }), list, describe(T0 + 6, "b", "more", { by: "z" }), list] },
    { name: "list-order-is-locale-compare", steps: [...order.map((n, i) => put(T0 + i, n, `value-${i}-of-set`)), list, put(T0 + 100, "a", "value-again-a"), put(T0 + 101, "ab", "value-again-ab"), del("a-b"), del("A"), put(T0 + 102, "a-b", "value-back-a-b"), list, dump] },
    { name: "unavailable-and-back", available: false, steps: [
      { op: "probe" }, get("k"), put(T0, "k", "value-k-one"), describe(T0, "k", "x"), del("k"), list, dump, { op: "setAvailable", available: true }, { op: "probe" }, put(T0, "k", "value-k-one", { desc: "d" }), list,
      { op: "setAvailable", available: false }, get("k"), put(T0 + 1, "k", "value-k-two"), describe(T0 + 1, "k", "e", { register: true }), del("k"), list, dump, { op: "probe" }, { op: "setAvailable", available: true }, get("k"), dump] },
    { name: "description-checks-inside-the-backend", steps: [
      put(T0, "k", V, { desc: "uses correct horse battery here", register: true }), list, get("k"), put(T0, "k", V, { desc: "a\nb", register: true }), put(T0, "k", V, { desc: "correct " }), put(T0, "k", V, { desc: "x".repeat(201) }), put(T0, "k", V, { desc: "x".repeat(200) }), list,
      put(T0 + 1, "k", "newvalue-two", { desc: "mentions correct horse battery", register: true }), get("k"), put(T0 + 2, "k", "newvalue-two", { register: true }), list,
      describe(T0 + 3, "k", "now mentions newvalue-two", { register: true }), describe(T0 + 3, "k", "mentions newvalue", { register: true }), describe(T0 + 3, "k", "x\ty", { register: true }), describe(T0 + 3, "k", "y".repeat(201), { register: true }), describe(T0 + 3, "k", "  ok  ", { register: true }), list,
      put(T0 + 4, "k", "newvalue-three", { desc: "ok" }), list, put(T0 + 5, "j", "short", { desc: "short" }), put(T0 + 5, "j2", "abc", { desc: "x abc y" }), list] },
    { name: "time-forms", steps: [
      put(0, "t0", "value-t0-one"), put(1_700_000_000_123, "t1", "value-t1-one"), put(253_402_300_800_000, "t2", "value-t2-one"), put(-62_198_755_200_000, "t3", "value-t3-one"), put(8_640_000_000_000_000, "t4", "value-t4-one"), put(-8_640_000_000_000_000, "t5", "value-t5-one"),
      put(8_640_000_000_000_001, "t6", "value-t6-one"), put(-8_640_000_000_000_001, "t7", "value-t7-one"), put(8_640_000_000_000_001, "t0", "value-t0-two"), get("t0"), list,
      describe(8_640_000_000_000_001, "t0", "new words", { register: true }), describe(8_640_000_000_000_001, "t0", "x\ny", { register: true }), describe(8_640_000_000_000_001, "gone", "x", { register: true }), get("t0"), list, describe(1, "t0", "fine"), list] },
    { name: "unicode-values", steps: [
      put(T0, "u1", "pässwörd-😀", { by: "jürgen", desc: "café 😀" }), get("u1"), list, put(T0, "u2", "é".repeat(1000), { desc: "éééééééé" }), put(T0, "u3", "é".repeat(1000), { desc: "ééééééé" }),
      put(T0, "u4", "😀".repeat(10), { desc: "😀".repeat(8) }), put(T0, "u5", "😀".repeat(10), { desc: "😀".repeat(7) }), list, dump] },
  ];
  const out = [];
  for (const sc of scenarios) out.push(await runMemory(sc));
  return { scenarios: out };
}

// --- audit -----------------------------------------------------------------------------------------------------------------------
function sanitizeCases() {
  const d = (entries: Record<string, unknown>): In => {
    const v: Record<string, unknown> = {}, spec: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(entries)) { const i = I(x); v[k] = i.v; spec[k] = i.spec; }
    return { v, spec };
  };
  const cases: In[] = [I(undefined), d({}), I(null)];
  const KEYS = ["backend", "purpose", "profileId", "leaseId", "ttlMs", "reason", "count", "method"];
  for (const k of KEYS) for (const x of ["x", "", "a b", "café", rep("x", 127), rep("x", 128), rep("x", 129), rep("x", 300), rep(EMOJI, 64), rep(EMOJI, 65), cat("a", rep(EMOJI, 64)), cat(rep("a", 127), EMOJI), cat(rep("a", 128), EMOJI), "line\nbreak", 0, 1, -1, 1.5, 60000, 2 ** 53, 1e21, 5e-324, 1.7976931348623157e308, true, false, null, [], ["x"], { a: 1 }, {}]) cases.push(d({ [k]: x }));
  cases.push(d(Object.fromEntries(KEYS.map((k, i) => [k, i % 2 ? `v${i}` : i]))), d({ backend: "keyring", purpose: "deploy", profileId: "p1", leaseId: "lse_00", ttlMs: 60000, reason: "denied", count: 3, method: "secret.get" }));
  cases.push(d({ value: "x", secret: "y", token: "z", extra: 1 }), d({ value: "x", backend: "file" }), d({ method: "m", extra: true, backend: "b" }), d({ ttlMs: 0, count: 0, reason: "", method: "" }), d({ backend: undefined, purpose: "p" }));
  return dedupe(cases);
}
function actorCases(): { desc: unknown; principal: unknown }[] {
  const out: { desc: unknown; principal: unknown }[] = [];
  const owner = (id?: unknown, surface?: number) => { const i = I(id); out.push({ desc: { kind: "owner", ...(id !== undefined ? { id: i.spec } : {}), ...(surface !== undefined ? { surface } : {}) }, principal: { kind: "owner", ...(id !== undefined ? { id: i.v } : {}), ...(surface !== undefined ? { surface } : {}) } }); };
  const agent = (agentId?: unknown) => { const i = I(agentId); out.push({ desc: { kind: "agent", ...(agentId !== undefined ? { agentId: i.spec } : {}) }, principal: { kind: "agent", ...(agentId !== undefined ? { agentId: i.v } : {}) } }); };
  for (const id of [undefined, "", "alice", "A b", "core", "unknown", "agent:x", "café", EMOJI, rep("a", 127), rep("a", 128), rep("a", 129), rep("a", 300), rep(EMOJI, 64), rep(EMOJI, 65), cat("a", rep(EMOJI, 64)), cat(rep("a", 127), EMOJI), cat(rep("a", 128), EMOJI)]) owner(id);
  for (const s of [0, 1, 2, 3]) owner("alice", s), owner(undefined, s);
  for (const id of [undefined, "", "bot-a", "a b", "x:y", EMOJI, rep("a", 127), rep("a", 128), rep("a", 129), cat("a", rep(EMOJI, 64)), cat(rep("a", 127), EMOJI)]) agent(id);
  out.push({ desc: { kind: "core" }, principal: { kind: "core" } });
  return out;
}
function buildAudit() {
  const marker = "@os-user@";
  const sanitize = sanitizeCases().map((c) => [c.spec, run(() => A.sanitizeDetail(c.v as any), (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)])))]);
  const dir = mkdtempSync(join(tmpdir(), "p1b-secrets-export-"));
  let actors: unknown[][];
  try {
    const file = join(dir, "logs", "audit.log");
    const sink = A.createFileAuditSink({ file, secure: () => ({ applied: true }), clock: () => 0 });
    const cases = actorCases();
    for (const c of cases) sink.record({ action: "secret.get", target: null, principal: c.principal as any, detail: {} });
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    if (lines.length !== cases.length) throw new Error(`${lines.length} audit lines for ${cases.length} principals`);
    const me = userInfo().username;
    actors = cases.map((c, i) => {
      const user: string = lines[i].actor.user;
      const given = (c.principal as any).id ?? (c.principal as any).agentId;
      if (typeof given === "string" && given === me) throw new Error(`an id equals the OS user name ${JSON.stringify(me)}`);
      return [c.desc, enc(user === me ? marker : user)];
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const memory = A.createMemoryAuditSink();
  memory.record({ action: "secret.get", target: "n", principal: { kind: "core" }, detail: { backend: "file", value: "x", purpose: "p".repeat(200) } as any });
  const failing = A.createMemoryAuditSink();
  failing.failNext = true;
  return {
    sanitize: table(["detail", "expected"], sanitize),
    actor: { osUserMarker: marker, ...table(["principal", "expected"], actors!) },
    memorySink: { event: { ...memory.events[0], detail: Object.fromEntries(Object.entries(memory.events[0]!.detail ?? {}).map(([k, v]) => [k, enc(v)])) } },
    auditUnavailable: run(() => failing.record({ action: "secret.get", target: null, principal: { kind: "core" } }), () => 0),
  };
}

// --- main ------------------------------------------------------------------------------------------------------------------------
export async function buildSecretsVectors(): Promise<Record<string, any>> {
  const order = buildNameOrder();
  // The real backend's `list` gives the same order for the names it can hold (put in shuffled order, listed).
  const be = createMemoryBackend();
  for (const n of [...order.valid].reverse()) await be.put(n, "value-of-the-name", new Date(0));
  const listed = (await be.list()).map((m: any) => m.name);
  if (JSON.stringify(listed) !== JSON.stringify(order.valid)) throw new Error("memory backend list order differs from localeCompare");
  return { constants: buildConstants(), validation: buildValidation(), "name-order": order.file, leases: buildLeases(), "memory-backend": await buildMemory(), "audit-detail": buildAudit() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "secrets", build: buildSecretsVectors });
}
