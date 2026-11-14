// Parity vectors (mode V) for the pure parts of identity (P4-12 task 3): `principals.ts` (`deriveUserPrincipal`, `isUserPrincipal`),
// `service.ts` (`v1PrincipalOf`, `isChannelName` and, through the public methods that call them first, the private `text`,
// `channelOf`, `identityOf`), `codes.ts`, `invite-token.ts`, `ratelimit.ts` (event sequences with a scripted clock, the row
// table dumped after every step), `authorization.ts` (`rbacAuthorizePort`, `requireAuthorization`) and `recall.ts`.
// `crates/plur1bus-core/src/identity/vectors.rs` replays every file. Recorded, never edited by hand.
//
// RANDOMNESS. `randomBytes` and `randomInt` of `node:crypto` are replaced (before `codes.ts` and `invite-token.ts` are imported,
// then `syncBuiltinESMExports`) by wrappers that return *scripted* values when a script is queued and the real function
// otherwise; the source files stay untouched. A fixture never holds a real random draw (R9: deterministic): the draws are
// the scripted ones, produced by a seeded generator plus hand-chosen edge values, and the TypeScript function computes its
// result from them. The Rust replay feeds the same values through its `RandomSource`. `randomInt`'s own rejection sampling
// is inside Node, not in the source file: the Rust helper `random_int_from_draws` implements Node's algorithm (RAND_MAX
// 2^48-1, `x < randLimit`) and is unit-tested separately.
//
// A file is `{<section>: {fields, mode, cases}}` or `{fields, mode, cases}`; `cases` is a list of strings, one case each, aligned with
// `fields` (the last field is the expected value): `mode: "json"` a JSON array text, `mode: "tsv"` the cells joined by TAB. A string
// that is not well-formed UTF-16 is stored as `{"u16": [units]}` (JSON cannot hold a lone surrogate).
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-identity.ts [--check]
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";

const realRandomBytes = crypto.randomBytes;
const realRandomInt = crypto.randomInt;
const scriptedBytes: Buffer[] = [];
const scriptedInts: number[] = [];
(crypto as any).randomBytes = (n: number, ...rest: any[]) => {
  const next = scriptedBytes.shift();
  if (next === undefined) return (realRandomBytes as any)(n, ...rest);
  if (next.length !== n) throw new Error(`scripted ${next.length} bytes for a draw of ${n}`);
  return Buffer.from(next);
};
(crypto as any).randomInt = (...args: any[]) => {
  const next = scriptedInts.shift();
  if (next === undefined) return (realRandomInt as any)(...args);
  const max = args.length >= 2 && typeof args[1] === "number" ? args[1] : args[0];
  if (!(Number.isInteger(next) && next >= 0 && next < max)) throw new Error(`scripted ${next} outside [0, ${max})`);
  return next;
};
syncBuiltinESMExports();

const SRC = "../../packages/core/src/identity";
const { deriveUserPrincipal, isUserPrincipal } = await import(`${SRC}/principals.ts`);
const { CODE_ALPHABET, CODE_LENGTH, generateCode, hashCode, hashesEqual, newSalt, normalizeCode, uuidv7 } = await import(`${SRC}/codes.ts`);
const invite = await import(`${SRC}/invite-token.ts`);
const { createLimiter, GLOBAL_KEY, GLOBAL_LIMIT, SOURCE_LIMIT } = await import(`${SRC}/ratelimit.ts`);
const { rbacAuthorizePort, requireAuthorization } = await import(`${SRC}/authorization.ts`);
const { createRecallScopeProvider } = await import(`${SRC}/recall.ts`);
const { createIdentityService, isChannelName, v1PrincipalOf, MAX_CODE_TTL_MS, DEFAULT_CODE_TTL_MS, MAX_PENDING_PER_HUMAN_CHANNEL } = await import(`${SRC}/service.ts`);
const { IdentityError } = await import(`${SRC}/store.ts`);

/** A string for a fixture: as is when well-formed, else its code units. */
export const codec = (s: string): unknown => (s.isWellFormed() ? s : { u16: Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)) });
const tf = (b: boolean) => (b ? "T" : "F");
/** One case per line: `json` mode stores each case as a JSON text in a string, `tsv` mode (cells without TAB or line breaks) joins the cells with TAB. */
const table = (fields: string[], cases: unknown[][], mode: "json" | "tsv" = "json") => ({
  fields, mode,
  cases: cases.map((c) => (mode === "json" ? JSON.stringify(c) : c.map((v) => { const t = v === null ? "" : String(v); if (/[\t\r\n]/.test(t)) throw new Error(`tsv cell ${JSON.stringify(t)}`); return t; }).join("\t"))),
});
const errText = (e: any): string =>
  e instanceof IdentityError ? `err:${e.code}|${e.field ?? ""}|${e.retryAfterMs ?? ""}|${e.message}` : `throw:${e?.name ?? typeof e}`;
const attempt = <T>(fn: () => T, ok: (v: T) => string): string => { try { return ok(fn()); } catch (e) { return errText(e); } };
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0; let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hex = (b: Buffer | Uint8Array) => Buffer.from(b).toString("hex");
/** The 25 characters `\s` matches (and `trim` removes). */
const SPACES: string[] = (() => { const out: string[] = []; for (let c = 0; c <= 0xffff; c++) if (/\s/.test(String.fromCharCode(c))) out.push(String.fromCharCode(c)); if (out.length !== 25) throw new Error(`\\s has ${out.length} members`); return out; })();
const ASCII: string[] = Array.from({ length: 128 }, (_, c) => String.fromCharCode(c));
const dedupe = (list: string[]) => [...new Set(list)];

// --- principals ------------------------------------------------------------------------------------------------------------------
const deriveText = (id: string) => attempt(() => deriveUserPrincipal(id), (p) => `ok:${p}`);
function buildPrincipals() {
  const ids: string[] = ["", "a", "A", "x".repeat(127), "x".repeat(128), "x".repeat(129), "x".repeat(1000), "\u{1F600}".repeat(63), "\u{1F600}".repeat(64), "\u{1F600}".repeat(65),
    "a".repeat(126) + "\u{1F600}", "a".repeat(127) + "\u{1F600}", "a".repeat(128) + "\u{1F600}", "\u{1F600}" + "a".repeat(126), "\u{1F600}" + "a".repeat(127), "\u{1F600}".repeat(64) + "a",
    "a".repeat(127) + "\ud83d", "a".repeat(128) + "\ud83d", "a".repeat(127) + "\ude00", "\ud83d", "\ude00", "\ude00\ud83d", "a\ud83db", "a\ude00b", "\ud83d\ud83d\ude00",
    "\u00e9".repeat(128), "\u00e9".repeat(129), "\u20ac".repeat(128), "\u20ac".repeat(129), "\u4e2d".repeat(100),
    "Alice", "alice", "ALICE", "caf\u00e9", "cafe\u0301", "\u0430lice", "\u03b1lice", "\uff21lice", "\u0131", "\u0130", "\u00df", "SS", "\u017f", "\u212a", "K", "k",
    "01890000-0000-7000-8000-000000000000", `user:v2:${"a".repeat(64)}`, "a b", " ", "\u00a0", "\u200b", "\ufeff", "\u202e", "\u200d", "\u00ad", "\u0080", "\u009f", "\u00a0a", "a\u2028", "\u2029",
    "'; DROP TABLE x;--", "__proto__", "a\\b", "a\"b", "%00", "\\u0000"];
  for (let c = 0; c < 0x20; c++) { const ch = String.fromCharCode(c); ids.push(ch, `a${ch}`, `${ch}a`, `a${ch}b`); }
  for (const ch of ["\u007f", "\u0080", "\u0085", "\u009f"]) ids.push(ch, `a${ch}`, `${ch}a`, `a${ch}b`);
  for (const sp of SPACES) ids.push(sp, sp + sp, `${sp}a`, `a${sp}`, `a${sp}b`, `${sp}a${sp}`);
  const derive = dedupe(ids).map((id) => [codec(id), deriveText(id)]);

  const h = "0123456789abcdef".repeat(4);
  const shapes = [`user:v1:${h}`, `user:v2:${h}`, `user:v1:${"a".repeat(64)}`, `user:v3:${h}`, `user:v0:${h}`, `user:v12:${h}`, `user:v:${h}`, `user:v2:${h.slice(1)}`, `user:v2:${h.slice(2)}`, `user:v2:${h}a`, `user:v2:${h}0`,
    `user:v2:${h.toUpperCase()}`, `user:v2:${"A".repeat(64)}`, `user:v2:${h.slice(0, 63)}A`, `user:v2:${h}\n`, `user:v2:${h}\r\n`, `\nuser:v2:${h}`, ` user:v2:${h}`, `user:v2:${h} `, `User:v2:${h}`, `USER:v2:${h}`, `user:V2:${h}`,
    `user:v2:${"g".repeat(64)}`, `user:v2:${h.slice(0, 63)}g`, `user:v2:${h.slice(0, 63)}\u0660`, `user:v2:${h.slice(0, 63)}\uff10`, `user:v2:${h.slice(0, 63)}\u2028`, `user:v2:${h.slice(0, 32)}\u0000${h.slice(33)}`,
    `user:v2::${h}`, `user:v2${h}`, `user-v2:${h}`, `user:v\uff12:${h}`, `user:v2:${h}${h}`, "", "user:v2:", "user:v1:", "user:v2:\ud83d", "\ud83d"];
  const shape = shapes.map((v) => [codec(v), tf(isUserPrincipal(v))]);

  const pool = ["", "a", "bot-a", "Ab1001", "q\"uote", "back\\slash", "\u{1F600}", "a\u2028b", "a\u2029", "\u007f", "\u0001", "\n", "\t", "\u00e9", "e\u0301", "\ud800", "\udc00", "\ud800\udc00", "\udc00\ud800", "a,b", "\",\"", "]", "[", "[\"", "x".repeat(128), "x".repeat(129), "\u00ff", "\u0000", "\u001f", "/", "\u0008\u000c", "\u2603", "\ufeff", "</script>", "\u00a0"];
  const channels = ["telegram", "slack", "a", "x.y_z-1", "Telegram", "", "te\"st", "\u00e9", "\ud800", "x".repeat(40)];
  const triples: string[][] = [];
  for (const c of channels) for (const a of pool) triples.push([c, a, "u1"]);
  for (const a of ["bot-a", "T1"]) for (const u of pool) triples.push(["telegram", a, u]);
  for (const t of [["slack", "T1", "U1"], ["slack", "T1,U1", "x"], ["slack", "T1\",\"U1", "x"], ["slack", "T1", "U1\",\"x"], ["slack", "T1:U1", "x"], ["slack", "T1/U1", "x"], ["slack", "T1", "U1,x"], ["slack", "T1U1", "x"], ["telegram", "bot-a", "Ab1001"]]) triples.push(t);
  for (let i = 0; i < pool.length; i++) triples.push([pool[i]!, pool[(i + 7) % pool.length]!, pool[(i + 19) % pool.length]!]);
  const seenTriples = new Set<string>();
  const v1 = triples.filter((t) => { const k = JSON.stringify(t.map(codec)); if (seenTriples.has(k)) return false; seenTriples.add(k); return true; })
    .map((t) => [codec(t[0]!), codec(t[1]!), codec(t[2]!), v1PrincipalOf({ channel: t[0], accountId: t[1], userId: t[2] })]);

  const names = ["a", "z", "a" + "b".repeat(30), "a" + "b".repeat(31), "a" + "b".repeat(32), "a" + "b".repeat(100), "", "A", "aA", "Z9", "1a", "-a", ".a", "_a", "a-", "a_", "a.", "a0", "a9", "a b", " a", "a ", "a\n", "\na", "a\r", "\u00e9", "a\u00e9", "\u00e9a", "a\u0000", "\uff41", "a\uff41", "telegram", "Telegram", "telegram2", "telegram.dev", "a-b_c.d", "a--", "a..", "a__", "x".repeat(32), "x".repeat(33), "\ud800", "a\ud800"];
  for (const c of ASCII) { names.push(c, `a${c}`, `${c}a`, `a${c}b`); }
  const chan = dedupe(names).map((n) => [codec(n), tf(isChannelName(n))]);
  return { derive, shape, v1, chan };
}

// --- identity validation, observed through the public methods that call the private helpers first --------------------------------
function buildValidation() {
  const dir = mkdtempSync(join(tmpdir(), "p1b-identity-export-"));
  let svc: any;
  try {
    svc = createIdentityService({ dbPath: join(dir, "identity.sqlite"), clock: () => 1_800_000_000_000, audit: () => {} });
    // `claim` runs `identityOf` before anything else: invalid-params is the validation's verdict, any other outcome means "passed".
    const verdict = (identity: any) => { try { svc.claim({ code: "AAAAAAAA", identity }); return "pass"; } catch (e: any) { return e instanceof IdentityError && e.code === "invalid-params" ? errText(e) : "pass"; } };
    // `getLink` runs `text(linkId, "linkId", 64)` first: not-found means "passed".
    const text64 = (v: string) => { try { svc.getLink(v); return "pass"; } catch (e: any) { return e instanceof IdentityError && e.code === "invalid-params" ? errText(e) : "pass"; } };
    const field = ["x", "x".repeat(127), "x".repeat(128), "x".repeat(129), "", "a b", " a ", "\u00e9".repeat(128), "\u00e9".repeat(129), "\u{1F600}".repeat(64), "\u{1F600}".repeat(65), "a".repeat(127) + "\u{1F600}", "a".repeat(127) + "\ud83d",
      "\ud83d", "\u00a0", "\u200b", "a\u2028b", "a\u007fb", "a\u0000", "\u001fa", "a\tb", "a\nb", "\u0080", "\u009f", "Ab1001", "caf\u00e9", "cafe\u0301"];
    for (let c = 0; c < 0x20; c++) field.push(`a${String.fromCharCode(c)}b`);
    const channelsOf = ["telegram", "Telegram", "", "a", "a".repeat(32), "a".repeat(33), "1a", "a b", "a\n", "\u00e9"];
    const rows: unknown[][] = [];
    const seen = new Set<string>();
    const add = (ch: string, acc: string, user: string, display: string | null) => {
      const key = JSON.stringify([ch, acc, user, display].map((x) => (x === null ? null : codec(x))));
      if (seen.has(key)) return; seen.add(key);
      const identity: any = { channel: ch, accountId: acc, userId: user }; if (display !== null) identity.displayName = display;
      rows.push([codec(ch), codec(acc), codec(user), display === null ? null : codec(display), verdict(identity)]);
    };
    for (const ch of channelsOf) add(ch, "bot-a", "u1", null);
    for (const f of field) { add("telegram", f, "u1", null); add("telegram", "bot-a", f, null); add("telegram", "bot-a", "u1", f); }
    // the first failing member decides: every pair of bad members
    const bad = ["", "x".repeat(129), "a\u0000"];
    for (const ch of ["Bad", "telegram"]) for (const a of ["bot", ...bad]) for (const u of ["u", ...bad]) for (const d of [null, "d", ...bad]) add(ch, a, u, d);
    const t64 = field.map((v) => [codec(v), text64(v)]).concat(["x".repeat(63), "x".repeat(64), "x".repeat(65), "\u{1F600}".repeat(32), "\u{1F600}".repeat(33), "a".repeat(63) + "\u{1F600}"].map((v) => [codec(v), text64(v)]));
    return { identity: table(["channel", "accountId", "userId", "displayName", "expected"], rows), text64: table(["value", "expected"], t64) };
  } finally { svc?.close(); rmSync(dir, { recursive: true, force: true }); }
}

// --- codes ------------------------------------------------------------------------------------------------------------------------
function buildNormalize() {
  const raws: string[] = ["abcd2345", "ABCD-2345", " ab cd - 23 45 ", "ab\tcd\n2345", "", "---", "ABCD_2345", "ABCD.2345", "abcd 2345", "AbCd-eF23", "aBcD2345", "abcd2345\n", "\r\nabcd", "a-b-c-d-2-3-4-5", "- - -", "ABCD\u20102345", "ABCD\u20112345", "ABCD\u20122345", "ABCD\u20132345", "ABCD\u20142345", "ABCD\u20152345", "ABCD\u22122345", "ABCD\u00ad2345", "ABCD\ufe632345", "ABCD\uff0d2345", "ABCD\u200b2345", "ABCD\u200c2345", "ABCD\u200d2345", "ABCD\u20602345", "ABCD\u180e2345", "ABCD\u00a02345", "ABCD\u30002345", "ABCD\u20282345", "ABCD\u20292345", "ABCD\u000b2345", "ABCD\u000c2345", "ABCD\u00852345", "ABCD\u001c2345", "ABCD\u001f2345", "ABCD\u00002345"];
  // look-alikes of the alphabet and of the symbols it leaves out: case folding and compatibility forms
  raws.push("0O0O0O0O", "1I1I1I1I", "l1lI|!i", "o0", "O0Il1", "\u0410\u0412\u0421\u0415\u041d\u041a\u041c\u041e\u0420\u0422\u0425", "\u0430\u0432\u0441\u0435\u043d\u043a\u043c\u043e\u0440\u0442\u0445", "\u0391\u0392\u0395\u0396\u0397\u0399\u039a\u039c\u039d\u039f\u03a1\u03a4\u03a5\u03a7", "\u03b1\u03b2\u03b5\u03b6\u03b7\u03b9\u03ba\u03bc\u03bd\u03bf\u03c1\u03c4\u03c5\u03c7",
    "\uff21\uff22\uff23\uff24\uff12\uff13\uff14\uff15", "\uff41\uff42\uff43\uff44\uff12", "\uff10\uff11\uff2f\uff29", "\u00df", "\u1e9e", "ss", "SS", "stra\u00dfe", "\u0131", "\u0130", "i\u0307", "I\u0307", "\u0131\u0130iI", "\u017f", "\u212a", "\u212b", "\u2126", "\u01c6", "\u01c5", "\u01c4", "\u0149", "\u01f0", "\ufb01", "\ufb00", "\ufb03", "\ufb05", "\u1e96", "\u0390", "\u03b0", "\u03c2", "\u03c3", "\u03a3", "\u03a3\u03c2", "\u1f80", "\u1fb3", "\u1f88", "\u00b5", "\u03bc", "\u2160", "\u2170", "\u24b6", "\u24d0", "\u2c65", "\u1d79", "\u0250", "\ua64a", "\u01c5\u01c8\u01cb\u01f2", "\ud801\udc28", "\ud801\udc00", "\ud83d\ude00", "\ud835\udc00", "\ud835\udc1a");
  raws.push("\ud800", "\udc00", "a\ud800b", "a\udc00b-c", "\ud800-", "\ud800 \udc00", "\udc00\ud800", "x\ud83d", "\ud83dx");
  for (const sp of SPACES) raws.push(sp, `AB${sp}CD`, `${sp}ab`, `ab${sp}`, `${sp}${sp}${sp}`, `ab${sp}-${sp}cd`);
  for (const c of ASCII) raws.push(c, `a${c}b`);
  const rnd = mulberry32(0x1d_c0de);
  const pool = ["a", "b", "z", "A", "Z", "0", "1", "2", "9", "O", "I", "l", "-", "-", " ", " ", "\t", "\n", "_", ".", "\u00df", "\u0131", "\u0130", "\u017f", "\u212a", "\u00a0", "\u2028", "\u3000", "\ufeff", "\u2010", "\u00ad", "\u200b", "\u0410", "\uff21", "\u01c6", "\ufb01", "\ud83d\ude00", "\ud800", "\udc00", "\u00e9", "e\u0301"];
  for (let i = 0; i < 350; i++) { let s = ""; const n = Math.floor(rnd() * 14); for (let k = 0; k < n; k++) s += pool[Math.floor(rnd() * pool.length)]; raws.push(s); }
  const cases = dedupe(raws).map((r) => [codec(r), codec(normalizeCode(r))]);

  // Every Unicode scalar value on its own: only those whose normalization differs from themselves are listed (hex code points).
  const changed: Record<string, string> = {}; let scalars = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    scalars++;
    const s = String.fromCodePoint(cp); const r = normalizeCode(s);
    if (r !== s) changed[cp.toString(16)] = [...r].map((ch) => ch.codePointAt(0)!.toString(16)).join(" ");
  }
  return { cases: table(["raw", "expected"], cases), sweep: { scalars, changed } };
}

function buildHashes() {
  const salts = ["", "a", "ab", "abc", "salt-1", "0123456789abcdef0123456789abcdef", "\u0000", "a\u0000b", "\u00e9", "\u{1F600}", "\ud800", "x".repeat(129)];
  const codes = ["", "ABCD2345", "ABCD2346", "bcd", "d", "cd", "\u0000b", "b", "\u0000", "AB\u0000", "\u00e9", "\u{1F600}", "\ud800", "\udc00", "ABCD 2345"];
  const cases: unknown[][] = [];
  for (const s of salts) for (const c of codes) cases.push([codec(s), codec(c), hashCode(s, c)]);
  return table(["salt", "code", "expected"], cases);
}

function buildEqual() {
  const h1 = hashCode("s", "c"); const h2 = hashCode("s", "d");
  const pool = ["", "00", "ff", "FF", "ab", "AB", "abc", "abd", "ab0", "zz", "yy", "0g", "g0", "abzz", "abyy", "ab-", "a", "b", "\u00e9", "0xab", "ab0g", "abcd", h1, h1.toUpperCase(), h2, h1 + "g", h1.slice(0, 62), h1.slice(0, 63), h1.slice(0, 63) + "z"];
  const cases: unknown[][] = [];
  for (const a of pool) for (const b of pool) cases.push([codec(a), codec(b), tf(hashesEqual(a, b))]);
  return table(["a", "b", "expected"], cases);
}

function buildRandom() {
  const rnd = mulberry32(0xc0de_5eed);
  const intsFor = (draws: number[]) => { scriptedInts.length = 0; scriptedInts.push(...draws); const code = generateCode(); if (scriptedInts.length !== 0) throw new Error("unconsumed draws"); return code; };
  const draws: number[][] = [Array(8).fill(0), Array(8).fill(31), [0, 1, 2, 3, 4, 5, 6, 7], [24, 25, 26, 27, 28, 29, 30, 31], [31, 0, 31, 0, 31, 0, 31, 0], [8, 8, 8, 8, 8, 8, 8, 8], [14, 15, 16, 17, 18, 19, 20, 21]];
  for (let i = 0; i < 160; i++) draws.push(Array.from({ length: CODE_LENGTH }, () => Math.floor(rnd() * 32)));
  const generate = draws.map((d) => [d, intsFor(d)]);
  const covered = new Set(generate.flatMap(([, c]) => [...(c as string)])); if (covered.size !== 32) throw new Error("not every symbol was drawn");

  const bytesFor = (n: number, pattern: (i: number) => number) => Buffer.from(Array.from({ length: n }, (_, i) => pattern(i) & 0xff));
  const patterns: Array<(i: number) => number> = [() => 0, () => 0xff, (i) => i, (i) => 0xff - i, (i) => (i % 2 ? 0xff : 0), (i) => (i % 2 ? 0 : 0xff), () => 0x0f, () => 0xf0, () => 0x70, () => 0x80, () => 0xbf, () => 0x3f, (i) => 0xfb + (i % 5), (i) => 0xf8 | (i % 8)];
  const randomBuf = (n: number) => bytesFor(n, () => Math.floor(rnd() * 256));
  const salt16 = [...patterns.map((p) => bytesFor(16, p)), ...Array.from({ length: 24 }, () => randomBuf(16))];
  const salts = salt16.map((b) => { scriptedBytes.length = 0; scriptedBytes.push(b); const s = newSalt(); return [hex(b), s]; });

  const times = [0, 1, 1_800_000_123_456, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 0.5, 2 ** 40 + 12345, 2 ** 48 - 1, 2 ** 48 - 0.5, 2 ** 48, 2 ** 48 + 1, 1e15, -1, -0.5, -0, 0.9999, 1.5, 123456789.75, Number.NaN, Infinity, -Infinity, 1_700_000_000_000.9, 65535, 65536, 255, 256];
  const uuid: unknown[][] = [];
  const edge = [bytesFor(16, () => 0), bytesFor(16, () => 0xff), bytesFor(16, (i) => i), bytesFor(16, (i) => 0xf0 + i), bytesFor(16, () => 0x7f), bytesFor(16, () => 0x80)];
  for (const t of times) for (const b of edge) uuid.push([t === t ? (Object.is(t, -0) ? "-0" : t === Infinity ? "Infinity" : t === -Infinity ? "-Infinity" : t) : "NaN", hex(b), (() => { scriptedBytes.length = 0; scriptedBytes.push(b); try { return uuidv7(t); } catch (e: any) { return e instanceof RangeError ? "range-error" : `throw:${e?.name}`; } })()]);
  for (let i = 0; i < 60; i++) { const b = randomBuf(16); const t = 1_000_000_000_000 + Math.floor(rnd() * 2_000_000_000_000); scriptedBytes.length = 0; scriptedBytes.push(b); uuid.push([t, hex(b), uuidv7(t)]); }
  scriptedBytes.length = 0;

  const mintBufs = [...patterns.map((p) => bytesFor(32, p)), Buffer.from("fbfffbefbfbe".repeat(3) + "ff".repeat(14), "hex"), ...Array.from({ length: 40 }, () => randomBuf(32))];
  const mint = mintBufs.map((b) => { scriptedBytes.length = 0; scriptedBytes.push(b); return [hex(b), invite.mintInviteToken()]; });
  scriptedBytes.length = 0;
  const chars = new Set(mint.flatMap(([, t]) => [...(t as string)])); if (!chars.has("-") || !chars.has("_")) throw new Error("mint vectors never reach - and _");
  return { generate: table(["draws", "expected"], generate), salt: table(["bytes", "expected"], salts), uuid: table(["nowMs", "bytes", "expected"], uuid), mint: table(["bytes", "expected"], mint) };
}

// --- invite tokens -------------------------------------------------------------------------------------------------------------------
function buildInvite() {
  const A43 = "A".repeat(43);
  const shapes: string[] = [A43, "A".repeat(42), "A".repeat(44), "A".repeat(41), "A".repeat(45), "", "-_".repeat(21) + "a", "-".repeat(43), "_".repeat(43), "0".repeat(43), "z".repeat(43), "Z".repeat(43), A43 + "=", A43.slice(1) + "=", A43 + "\n", "\n" + A43.slice(1), A43.slice(1) + "\n", A43 + " ", " " + A43.slice(1), "\u00e9".repeat(43), "\u00e9".repeat(22), "A".repeat(42) + "\u00e9", "\uff21".repeat(43), "\u{1F600}" + "A".repeat(41), "\u{1F600}" + "A".repeat(40), "A".repeat(42) + "\ud83d", "A".repeat(42) + "\u2028", "A".repeat(42) + "\u0000", "A".repeat(21) + "\u200b" + "A".repeat(21), "\u0410".repeat(43)];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (const ch of alphabet) shapes.push(ch.repeat(43), ch + "A".repeat(42), "A".repeat(42) + ch);
  for (const ch of ASCII) { shapes.push(ch + "A".repeat(42), "A".repeat(21) + ch + "A".repeat(21), "A".repeat(42) + ch, "A".repeat(43) + ch); }
  const shape = dedupe(shapes).map((s) => [codec(s), tf(invite.isInviteTokenShape(s))]);

  const tokens = [A43, "B".repeat(43), "C".repeat(43), "", "a", "A".repeat(42), "A".repeat(44), "-_".repeat(21) + "a", "\u00e9", "\u{1F600}", "\ud800", "\udc00", "a\u0000b", "\u0000", " ", "plur1bus-invite-v1", "x".repeat(1000)];
  const hash = tokens.map((t) => [codec(t), invite.hashInviteToken(t)]);

  const link: unknown[][] = [];
  for (const o of ["https://harness.example.org", "http://localhost:8080", "http://[::1]:3000", "", "x", "https://a/", "https://a/b", "https://a?x#y", "\u00e9", "\ud800"]) for (const t of [A43, "", "t", "a/b#c", "\u00e9"]) link.push([codec(o), codec(t), codec(invite.inviteLink(o, t))]);
  const constants = { INVITE_TTL_DEFAULT_MINUTES: invite.INVITE_TTL_DEFAULT_MINUTES, INVITE_TTL_MAX_MINUTES: invite.INVITE_TTL_MAX_MINUTES, INVITE_CODE_MAX_MINUTES: invite.INVITE_CODE_MAX_MINUTES, MAX_CODE_TTL_MS, DEFAULT_CODE_TTL_MS, MAX_PENDING_PER_HUMAN_CHANNEL, CODE_ALPHABET, CODE_LENGTH,
    SOURCE_LIMIT, GLOBAL_LIMIT, GLOBAL_KEY };
  return { shape: table(["value", "expected"], shape), hash: table(["token", "expected"], hash), link: table(["origin", "token", "expected"], link), constants };
}

function buildOrigins() {
  const raws = new Set<string>();
  const add = (s: string) => raws.add(s);
  const hosts = ["harness.example.org", "localhost", "a", "a.b", "a-b.c", "-a.b", "a-.b", "a--b.c", "a_b.c", "a!b.c", "a$b.c", "a&b.c", "a'b.c", "a(b).c", "a*b.c", "a+b.c", "a,b.c", "a;b.c", "a=b.c", "a`b.c", "a{b}.c", "a~b.c", "a.", "a..b", ".a", ".", "..", "a.b.", "A.B", "Harness.Example.Org", "HARNESS.example.org",
    "a%41.b", "a%2e.b", "a%zz.b", "a%.b", "%41", "a b", "a\tb.c", "a\nb.c", "a<b.c", "a>b.c", "a^b.c", "a|b.c", "a\\b.c", "a\"b.c", "a@b.c", "a#b.c", "a?b.c", "a/b.c", "a:b.c", "a[b.c", "a]b.c",
    "127.0.0.1", "0.0.0.0", "255.255.255.255", "256.0.0.1", "1.2.3", "1.2", "1", "127.1", "0x7f.0.0.1", "0x7f000001", "0X7F.1", "2130706433", "4294967295", "4294967296", "017700000001", "0177.0.0.1", "01.2.3.4", "1.2.3.04", "127.0.0.1.", "1.2.3.4.5", "1.2.3.4a", "a.1", "a.b", "a.1b", "a.0x", "0x", "0x.1", "a.0x1f", "1.a", "1..2", "00", "0", "1e3",
    "[::1]", "[::]", "[1::]", "[::1:2]", "[1:2:3:4:5:6:7:8]", "[1:2:3:4:5:6:7::]", "[::2:3:4:5:6:7:8]", "[::ffff:1.2.3.4]", "[::ffff:127.0.0.1]", "[2001:db8::1]", "[2001:DB8::1]", "[2001:0db8:0:0:0:0:0:1]", "[1:0:0:2:0:0:0:3]", "[1:0:0:0:2:0:0:3]", "[0:0:0:0:0:0:0:0]", "[0:0:0:0:0:0:0:1]", "[::1%eth0]", "[::1%25eth0]", "[fe80::1%25en0]", "[1:2:3:4:5:6:7]", "[1::2::3]", "[:::]", "[::1:]", "[:1::]", "[12345::]", "[g::]", "[]", "[::1", "::1", "[::1]x", "[ ::1]", "[::1 ]", "[::01]", "[::0001]", "[::1.2.3.4]", "[::1.2.3]", "[::01.2.3.4]", "[1:2:3:4:5:6:1.2.3.4]", "[1:2:3:4:5:6:7:1.2.3.4]", "[::ffff:0:1.2.3.4]", "[64:ff9b::1.2.3.4]", "[1:2:3:4:5:6:7:8:9]", "[::a:b:c:d:e:f:1]",
    "xn--mnchen-3ya.example.org", "xn--zca.example", "XN--mnchen-3ya.example.org", "xn--", "xn--a", "xn--a.b", "a.xn--", "xn--0", "xn--zz--", "xn--mnchen-3yb.example.org", "xn--a-.b", "xn---a", "xn--mnchen-3ya", "xn--n3h.example", "xn--e1afmkfd.xn--p1ai", "xn--bcher-kva.example",
    "m\u00fcnchen.example.org", "M\u00dcNCHEN.example.org", "\u4f8b\u3048.jp", "\uff21\uff22\uff23.example", "a\u200bb.c", "a\u00adb.c", "\u00df.de", "\u0131.example", "\u0130.example", "a\u3002b", "a\uff0eb", "\u212a.example", "caf\u00e9.example", "cafe\u0301.example", "\ud83d\ude00.example", "\ud800.example",
    "a".repeat(63) + ".b", "a".repeat(64) + ".b", ("a".repeat(63) + ".").repeat(3) + "a".repeat(61), ("a".repeat(63) + ".").repeat(3) + "a".repeat(62), ("a".repeat(63) + ".").repeat(3) + "a".repeat(63)];
  const ports = ["", ":80", ":443", ":8080", ":0", ":00", ":08", ":65535", ":65536", ":99999", ":", ":x", ":-1", ":+1", ":1 ", ":\u0661", ":1:2", ":21", ":8080:", ":080", ":4294967296"];
  const suffixes = ["", "/", "//", "/x", "?", "#", "/?", "/#"];
  // size budget: every host with every suffix, but the full port list only for the first hosts
  for (const h of hosts) { for (const sfx of suffixes) add(`http://${h}${sfx}`); for (const sfx of ["", "/"]) add(`https://${h}${sfx}`); }
  for (const h of hosts.slice(0, 4)) for (const scheme of ["http", "https"]) for (const p of ports) for (const sfx of ["", "/", "/x"]) add(`${scheme}://${h}${p}${sfx}`);
  for (const h of hosts) for (const scheme of ["http", "https"]) for (const p of [":8080", ":80", ":443"]) add(`${scheme}://${h}${p}`);
  // schemes and the shape of the authority
  for (const s of ["http", "https", "HTTP", "HTTPS", "Http", "hTTps", "ftp", "ws", "wss", "file", "javascript", "data", "blob", "mailto", "x", "h", "http+x", "http.x", "1http", "http ", " http", "ht\ttp", "ht tp", "", "https:", "https"])
    for (const rest of ["//harness.example.org", "//harness.example.org/", "//localhost:8080", "/harness.example.org", "harness.example.org", "///harness.example.org", "\\\\harness.example.org", "/\\harness.example.org", "//", "", "//:80", "//@a", "//[::1]"]) add(`${s}:${rest}`);
  for (const raw of ["//harness.example.org", "harness.example.org", "harness.example.org:80", "localhost:8080", "localhost:8080/", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://harness.example.org", "ws://harness.example.org", "wss://harness.example.org"]) add(raw);
  for (const ui of ["u@", "u:p@", ":@", "@", ":", "u@@", "u:p:q@", "%40@", "u%3a@", "u\u00e9@", " @", "\u0000@"]) for (const scheme of ["http", "https"]) for (const sfx of ["", "/"]) add(`${scheme}://${ui}harness.example.org${sfx}`);
  for (const w of [" ", "\t", "\n", "\r", "\u000b", "\u000c", "\u00a0", "\u2028", "\u3000", "\ufeff", "\u0000", "\u001f", "\u007f", "\u0080"]) for (const raw of ["https://harness.example.org", "https://harness.example.org/", "http://localhost:8080"]) { add(w + raw); add(raw + w); add(raw.replace("//", `//${w}`)); add(raw.replace("://", `:${w}//`)); add(raw.replace("harness", `har${w}ness`)); }
  // every ASCII character in four places of an otherwise canonical origin
  for (const c of ASCII) { add(`https://a${c}b.example`); add(`https://${c}a.example`); add(`https://a.example${c}`); add(`${c}https://a.example`); add(`https://a.example/${c}`); }
  // length: 256 and 257 characters
  const stem = "https://"; const tail = ".org";
  for (const n of [250, 252, 253, 254, 255, 256, 257, 258]) { const room = n - stem.length - tail.length; const label = (k: number) => "a".repeat(k); add(stem + label(Math.min(room, 63)) + (room > 63 ? "." + label(Math.min(room - 64, 63)) + (room > 127 ? "." + label(Math.min(room - 128, 63)) + (room > 191 ? "." + label(room - 192) : "") : "") : "") + tail); }
  add(`https://${"a".repeat(60)}.org/`); add(`https://${"a".repeat(250)}.org`); add(`http://${"a.".repeat(120)}org`); add(`http://${"a.".repeat(121)}org`);
  // seeded noise, as the unit test draws it, and a host-shaped alphabet
  const rnd = mulberry32(0x0121_0dad);
  for (const [alphabet, count] of [["abc:/.@#?[]%\\ \n0127https", 700], ["ab.-_:0123456789[]xX", 400], ["aA.-:/[]0f:", 300]] as Array<[string, number]>) {
    for (let i = 0; i < count; i++) { let s = rnd() < 0.5 ? "https://" : rnd() < 0.5 ? "http://" : ""; const n = Math.floor(rnd() * 24); for (let k = 0; k < n; k++) s += alphabet[Math.floor(rnd() * alphabet.length)]; add(s); }
  }
  const cases = [...raws].map((raw) => {
    let r: string | null = null; try { r = invite.parseOrigin(raw); } catch (e) { throw new Error(`parseOrigin threw for ${JSON.stringify(raw)}`); }
    const punycode = r !== null && new URL(r).hostname.split(".").some((l) => l.startsWith("xn--"));
    return [codec(raw), r === null ? "-" : r, punycode ? "punycode" : ""];
  });
  return table(["raw", "expected", "class"], cases);
}

// --- limiter: event sequences against a scripted clock, the `attempts` table dumped after every step ----------------------------
const ATTEMPTS_DDL = "CREATE TABLE attempts (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_start INTEGER NOT NULL, locked_until INTEGER NOT NULL) STRICT";
type LimitSpecT = { limit: number; windowMs: number; lockMs: number };
function limiterSequence(name: string, script: (api: any) => void) {
  const db = new DatabaseSync(":memory:"); db.exec(ATTEMPTS_DDL);
  let now = 0; const lim = createLimiter(db, () => now);
  const steps: string[] = [];
  const rows = () => (db.prepare("SELECT key, failures, window_start, locked_until FROM attempts ORDER BY key").all() as any[]).map((r) => `${r.key},${r.failures},${r.window_start},${r.locked_until}`).join(";");
  const spec = (s: LimitSpecT) => (s === SOURCE_LIMIT ? "src" : s === GLOBAL_LIMIT ? "glb" : `${s.limit},${s.windowMs},${s.lockMs}`);
  const api = {
    failure(key: string, s: LimitSpecT, at: number) { now = at; lim.failure(key, s); steps.push(["failure", key, spec(s), at, "", rows()].join("\t")); },
    success(key: string, at: number) { now = at; lim.success(key); steps.push(["success", key, "", at, "", rows()].join("\t")); },
    release(key: string, s: LimitSpecT, eventAt: number, at: number) { now = at; lim.release(key, s, eventAt); steps.push(["release", key, spec(s), at, String(eventAt), rows()].join("\t")); },
    locked(keys: string[], at: number) { now = at; const w = lim.lockedFor(keys); steps.push(["locked", keys.join("|"), "", at, String(w), rows()].join("\t")); },
    prune(at: number) { now = at; lim.prune(); steps.push(["prune", "", "", at, "", rows()].join("\t")); },
  };
  try { script(api); } finally { db.close(); }
  return { name, steps };
}
function buildLimiter() {
  const T = 1_000_000; const MIN = 60_000; const W = SOURCE_LIMIT.windowMs; const L = SOURCE_LIMIT.lockMs;
  const small: LimitSpecT = { limit: 3, windowMs: 1000, lockMs: 5000 };
  const seqs = [
    limiterSequence("source: five failures lock, failures during the lock, expiry, a new count", (a) => {
      a.locked(["k"], T);
      for (let i = 0; i < 5; i++) { a.failure("k", SOURCE_LIMIT, T + i * 1000); a.locked(["k"], T + i * 1000); }
      a.locked(["k", "other"], T + 5000); a.locked(["k"], T + 4000 + L - 1); a.locked(["k"], T + 4000 + L); a.locked(["k"], T + 4000 + L + 1);
      for (let i = 0; i < 3; i++) a.failure("k", SOURCE_LIMIT, T + 10_000 + i * 100);
      a.locked(["k"], T + 10_500); a.failure("k", SOURCE_LIMIT, T + 4000 + L + 5); a.locked(["k"], T + 4000 + L + 6);
      for (let i = 0; i < 6; i++) a.failure("k", SOURCE_LIMIT, T + 2 * L + i);
      a.locked(["k"], T + 2 * L + 10); a.locked(["k"], T + 3 * L + 5); a.locked(["k"], T + 3 * L + 6);
    }),
    limiterSequence("source: the window is inclusive of its last millisecond (lock)", (a) => {
      for (let i = 0; i < 4; i++) a.failure("k", SOURCE_LIMIT, T + i); a.failure("k", SOURCE_LIMIT, T + W); a.locked(["k"], T + W);
    }),
    limiterSequence("source: one millisecond later the window has rolled over (no lock, count 1, new start)", (a) => {
      for (let i = 0; i < 4; i++) a.failure("k", SOURCE_LIMIT, T + i); a.failure("k", SOURCE_LIMIT, T + W + 1); a.locked(["k"], T + W + 1);
      for (let i = 0; i < 3; i++) a.failure("k", SOURCE_LIMIT, T + W + 2 + i); a.locked(["k"], T + W + 10); a.failure("k", SOURCE_LIMIT, T + W + 20); a.locked(["k"], T + W + 21);
    }),
    limiterSequence("source: the window start is the first failure, not the latest", (a) => {
      a.failure("k", SOURCE_LIMIT, T); a.failure("k", SOURCE_LIMIT, T + W - 1); a.failure("k", SOURCE_LIMIT, T + W); a.failure("k", SOURCE_LIMIT, T + W + 1); a.failure("k", SOURCE_LIMIT, T + W + 2); a.locked(["k"], T + W + 3);
      a.failure("k", SOURCE_LIMIT, T + 2 * W + 2); a.failure("k", SOURCE_LIMIT, T + 2 * W + 3);
    }),
    limiterSequence("global: 19, 20 and 21 failures over rotating handles", (a) => {
      for (let i = 0; i < 19; i++) { a.failure(`src:${i}`, SOURCE_LIMIT, T + i * 1000); a.failure(GLOBAL_KEY, GLOBAL_LIMIT, T + i * 1000); }
      a.locked(["src:5", GLOBAL_KEY], T + 20_000); a.failure(GLOBAL_KEY, GLOBAL_LIMIT, T + 20_000); a.locked(["fresh", GLOBAL_KEY], T + 20_001);
      a.failure(GLOBAL_KEY, GLOBAL_LIMIT, T + 21_000); a.locked([GLOBAL_KEY], T + 21_001); a.locked([GLOBAL_KEY], T + 20_000 + L); a.locked([GLOBAL_KEY], T + 20_000 + L + 1);
      a.prune(T + 20_000 + L + 1); a.prune(T + 25 * 3_600_000); a.prune(T + 26 * 3_600_000);
    }),
    limiterSequence("small spec: limit 3, window 1000, lock 5000", (a) => {
      a.failure("a", small, T); a.failure("a", small, T + 500); a.locked(["a"], T + 500); a.failure("a", small, T + 1000); a.locked(["a"], T + 1000); a.locked(["a"], T + 5999); a.locked(["a"], T + 6000);
      a.failure("b", small, T); a.failure("b", small, T + 1001); a.failure("b", small, T + 1002); a.locked(["a", "b"], T + 1003);
      a.failure("c", small, T + 10_000); a.failure("c", small, T + 10_000); a.failure("c", small, T + 10_000); a.locked(["c", "a", "b"], T + 10_000);
      a.failure("c", small, T + 12_000); a.failure("c", small, T + 12_000); a.failure("c", small, T + 12_000); a.locked(["c"], T + 12_000); a.locked(["c"], T + 17_000);
    }),
    limiterSequence("limit 1 and limit 2", (a) => {
      const one: LimitSpecT = { limit: 1, windowMs: 10, lockMs: 77 }; const two: LimitSpecT = { limit: 2, windowMs: 10, lockMs: 77 };
      a.failure("o", one, T); a.locked(["o"], T); a.locked(["o"], T + 76); a.locked(["o"], T + 77); a.failure("o", one, T + 50); a.locked(["o"], T + 50);
      a.failure("t", two, T); a.failure("t", two, T + 10); a.locked(["t"], T + 10); a.failure("t", two, T + 20); a.failure("t", two, T + 30); a.locked(["t"], T + 30); a.locked(["t"], T + 107);
    }),
    limiterSequence("success forgets one key, also a lock", (a) => {
      a.failure("a", small, T); a.failure("a", small, T + 1); a.failure("b", small, T); a.success("a", T + 2); a.success("never", T + 2); a.failure("a", small, T + 3); a.failure("a", small, T + 4); a.locked(["a", "b"], T + 5);
      a.failure("a", small, T + 6); a.locked(["a"], T + 7); a.success("a", T + 8); a.locked(["a"], T + 9); a.success("b", T + 9);
    }),
    limiterSequence("release: only an event of the current window can be taken back", (a) => {
      a.release("k", SOURCE_LIMIT, T, T);
      a.failure("k", SOURCE_LIMIT, T); a.failure("k", SOURCE_LIMIT, T + 1000); a.failure("k", SOURCE_LIMIT, T + 2000);
      a.release("k", SOURCE_LIMIT, T + 2000, T + 2000); a.release("k", SOURCE_LIMIT, T + 1000, T + 3000);
      a.release("k", SOURCE_LIMIT, T + 3000 - W - 1, T + 3000); a.release("k", SOURCE_LIMIT, T + 3000 - W, T + 3000);
      a.release("k", SOURCE_LIMIT, T + 3000, T + 3000); a.release("k", SOURCE_LIMIT, T + 3000, T + 3000); a.release("k", SOURCE_LIMIT, T + 3000, T + 3000);
      a.failure("k", SOURCE_LIMIT, T + 4000); a.release("k", SOURCE_LIMIT, T + 4000, T + W + 1); a.release("k", SOURCE_LIMIT, T + 4000, T + W + 2);
      a.release("k", SOURCE_LIMIT, T + W + 1, T + W + 2); a.release("k", SOURCE_LIMIT, T + 4000, T + W);
    }),
    limiterSequence("release: a lock that is still running is lifted with the last event, an ended one is left alone", (a) => {
      for (let i = 0; i < 5; i++) a.failure("k", SOURCE_LIMIT, T + i); a.locked(["k"], T + 5);
      a.release("k", SOURCE_LIMIT, T + 4, T + 10); a.locked(["k"], T + 11);
      for (let i = 0; i < 5; i++) a.failure("k", SOURCE_LIMIT, T + 20 + i); a.release("k", SOURCE_LIMIT, T + 24, T + 24 + L); a.release("k", SOURCE_LIMIT, T + 24, T + 24 + L + 1); a.release("k", SOURCE_LIMIT, T + 24, T + 23 + L);
      for (let i = 0; i < 5; i++) a.failure("g", GLOBAL_LIMIT, T + i); a.release("g", GLOBAL_LIMIT, T, T + 6);
      for (let i = 0; i < 3; i++) a.failure("s", small, T + i); a.release("s", small, T + 2, T + 3); a.release("s", small, T + 2, T + 4); a.release("s", small, T + 2, T + 5000 + 2); a.release("s", small, T + 2, T + 5000 + 3);
    }),
    limiterSequence("prune: only rows whose lock has ended and whose window began over a day ago", (a) => {
      const D = 24 * 3_600_000;
      a.failure("old-free", small, T); for (let i = 0; i < 3; i++) a.failure("old-locked", small, T + i);
      a.failure("long-lock", { limit: 1, windowMs: 10, lockMs: 30 * 3_600_000 }, T);
      a.failure("fresh", small, T + 25 * 3_600_000); a.prune(T + 25 * 3_600_000);
      a.prune(T + D + 1); a.prune(T + D + 5001); a.prune(T + 31 * 3_600_000);
      a.failure("edge", small, T + 40 * 3_600_000); a.prune(T + 40 * 3_600_000 + D); a.prune(T + 40 * 3_600_000 + D + 1);
    }),
  ];
  // seeded random walks, with the boundary distances of each spec among the clock steps
  const specs: LimitSpecT[] = [{ limit: 4, windowMs: 700, lockMs: 1500 }, SOURCE_LIMIT, small, { limit: 2, windowMs: 50, lockMs: 100 }, { limit: 1, windowMs: 5, lockMs: 3 }];
  const keys = ["a", "b", "c", "global"];
  for (const [seed, spec] of [[0xfeed01, specs[0]!], [0xfeed02, specs[1]!], [0xfeed03, specs[2]!], [0xfeed04, specs[3]!], [0xfeed05, specs[4]!], [0xfeed06, specs[0]!]] as Array<[number, LimitSpecT]>) {
    seqs.push(limiterSequence(`random walk seed ${seed.toString(16)} limit ${spec.limit} window ${spec.windowMs} lock ${spec.lockMs}`, (a) => {
      const rnd = mulberry32(seed); let now = T;
      const dts = [0, 1, 2, spec.windowMs - 1, spec.windowMs, spec.windowMs + 1, spec.lockMs - 1, spec.lockMs, spec.lockMs + 1, 24 * 3_600_000, 24 * 3_600_000 + 1].filter((d) => d >= 0);
      for (let step = 0; step < 170; step++) {
        now += rnd() < 0.5 ? Math.floor(rnd() * (spec.windowMs / 2 + 2)) : dts[Math.floor(rnd() * dts.length)]!;
        const key = keys[Math.floor(rnd() * keys.length)]!; const op = rnd();
        if (op < 0.5) a.failure(key, spec, now);
        else if (op < 0.68) a.locked(rnd() < 0.5 ? [key] : [key, keys[Math.floor(rnd() * keys.length)]!, "unseen"], now);
        else if (op < 0.76) a.success(key, now);
        else if (op < 0.93) a.release(key, spec, now - (rnd() < 0.3 ? spec.windowMs + Math.floor(rnd() * 3) - 1 : Math.floor(rnd() * spec.windowMs)), now);
        else a.prune(now);
      }
    }));
  }
  return { sequences: seqs };
}

// --- authorization ---------------------------------------------------------------------------------------------------------------------
const ACTIONS = ["create", "link", "unlink", "pair", "confirm", "backfill"];
const SCOPE_SETS: Record<string, string[] | null> = { absent: null, empty: [], "users-manage": ["users.manage"], "my-write": ["my.write"], both: ["users.manage", "my.write"], "users-star": ["users.*"], "my-star": ["my.*"], star: ["*"], other: ["chat.read"], "my-write-prefix": ["my.writer"] };
function buildAuthorization() {
  const portCases: unknown[][] = [];
  const roles: Array<string | null> = ["owner", "admin", "operator", "member", "viewer", null];
  const kinds: Array<string | null> = ["person", "agent", null];
  for (const action of ACTIONS) for (const role of roles) for (const kind of kinds) for (const own of [true, false]) for (const [scopeName, scopes] of Object.entries(SCOPE_SETS)) {
    const actor: any = { user: "u-1", host: "h" }; if (role) actor.role = role; if (kind) actor.kind = kind; if (scopes) actor.tokenScopes = scopes;
    const target = own ? "u-1" : "u-2";
    portCases.push([action, role ?? "-", kind ?? "-", own ? "own" : "other", scopeName, tf(rbacAuthorizePort.authorize(actor, action, target))]);
  }
  const edgeCases: unknown[][] = [];
  for (const action of ACTIONS) for (const role of ["owner", "member"]) for (const [user, target] of [["", ""], ["", "u-2"], ["u-1", ""], ["__proto__", "__proto__"], ["ué", "ué"], ["\ud800", "\ud800"]]) {
    const actor = { user, host: "h", role, kind: "person" };
    edgeCases.push([action, role, codec(user), codec(target), tf(rbacAuthorizePort.authorize(actor, action, target))]);
  }
  const ports: Record<string, any> = { rbac: rbacAuthorizePort, allow: { authorize: () => true }, deny: { authorize: () => false } };
  const reqCases: unknown[][] = [];
  for (const action of ACTIONS) for (const [portName, port] of Object.entries(ports)) for (const role of ["owner", "viewer", null]) for (const kind of kinds) for (const own of [true, false]) {
    const actor: any = { user: "u-1", host: "h" }; if (role) actor.role = role; if (kind) actor.kind = kind;
    const target = own ? "u-1" : "u-2";
    reqCases.push([portName, action, role ?? "-", kind ?? "-", own ? "own" : "other", attempt(() => requireAuthorization(port, actor, action, target), () => "ok")]);
  }
  return { port: table(["action", "role", "kind", "target", "scopes", "expected"], portCases, "tsv"), edge: table(["action", "role", "user", "harnessUserId", "expected"], edgeCases), require: table(["port", "action", "role", "kind", "target", "expected"], reqCases, "tsv") };
}

// --- recall ---------------------------------------------------------------------------------------------------------------------------
function buildRecall() {
  const h = "0123456789abcdef".repeat(4);
  const inputs = [`user:v2:${h}`, `user:v1:${h}`, `user:v2:${h.toUpperCase()}`, `user:v2:${h.slice(1)}`, `user:v2:${h}\n`, "", "user:v2:", "x", `user:v3:${h}`, `User:v2:${h}`, `user:v2:${"b".repeat(64)}`];
  const behaviours = ["known", "not-found", "storage", "invalid-params"];
  const cases: unknown[][] = [];
  for (const behaviour of behaviours) for (const input of inputs) for (const method of ["resolvePrincipals", "capturePrincipal"]) {
    const calls: string[] = [];
    const service: any = { resolvePrincipals(u: string) {
      calls.push(u);
      if (behaviour === "known") return [u, `user:v1:${"c".repeat(64)}`, `user:v1:${"d".repeat(64)}`];
      if (behaviour === "not-found") throw new IdentityError("not-found", "unknown harness principal");
      if (behaviour === "storage") throw new IdentityError("storage", "invalid stored principal");
      throw new IdentityError("invalid-params", "expected v2 principal", { field: "userV2" });
    } };
    const provider: any = createRecallScopeProvider(service);
    const result = attempt(() => provider[method](input), (v) => `ok:${JSON.stringify(v)}`);
    cases.push([method, behaviour, codec(input), calls.length, result]);
  }
  return table(["method", "service", "input", "calls", "expected"], cases);
}

// --- main -------------------------------------------------------------------------------------------------------------------------------
export async function buildIdentityVectors(): Promise<Record<string, any>> {
  const files: Record<string, any> = {};
  const counts: Record<string, number> = {};
  const count = (v: any): number => (v.cases ? v.cases.length : v.sequences ? v.sequences.reduce((n: number, q: any) => n + q.steps.length, 0) : Object.values(v).reduce((n: number, x: any) => n + (x && x.cases ? x.cases.length : 0), 0) as number);
  const put = (name: string, data: any) => { files[name] = data; counts[name] = count(data); };
  const p = buildPrincipals();
  put("principal-derive", table(["id", "expected"], p.derive));
  put("principal-shape", table(["value", "expected"], p.shape));
  put("principal-v1", table(["channel", "accountId", "userId", "expected"], p.v1));
  put("channel-names", table(["name", "expected"], p.chan));
  put("identity-validation", buildValidation());
  const n = buildNormalize();
  put("code-normalize", n.cases); put("code-normalize-sweep", n.sweep);
  put("code-hash", buildHashes()); put("code-equal", buildEqual());
  put("code-random", buildRandom());
  const inv = buildInvite();
  put("invite-token", { shape: inv.shape, hash: inv.hash, link: inv.link }); put("constants", inv.constants);
  put("invite-origin", buildOrigins());
  const lim = buildLimiter();
  put("limiter", { fields: ["op", "keys", "spec", "now", "extra", "rows"], mode: "tsv", sequences: lim.sequences.map((s) => ({ name: s.name, steps: s.steps })) });
  put("authorization", buildAuthorization());
  put("recall", buildRecall());
  counts.constants = 1;
  files.index = { counts, total: Object.entries(counts).reduce((s, [k, v]) => s + (k === "constants" ? 0 : v), 0),
    grids: { "authorization.port": "6 actions x 6 roles (5 + none) x 3 kinds (person, agent, none) x own/other x 10 token-scope sets; authorization.edge: 6 actions x 2 roles x 6 user-id pairs", "authorization.require": "6 actions x 3 ports (rbac, allow, deny) x 3 roles x 3 kinds x own/other",
      "limiter": "11 hand-written sequences and 6 seeded random walks of 170 steps, the table dumped after each step", "code-normalize-sweep": "every Unicode scalar value on its own; the ones whose normalization differs are listed" } };
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "identity", build: buildIdentityVectors });
}
