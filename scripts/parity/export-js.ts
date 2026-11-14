// Parity vectors (mode V) for the JavaScript semantics the Rust port needs (P4-12 task 2, R5): UTF-16 length, `trim`,
// `toUpperCase`/`toLowerCase`, the `\s` and `\w` classes and ASCII-only `\b`, case-insensitive matching as a non-Unicode
// regular expression does it (`Canonicalize`, proved over every UTF-16 code unit), `Array.prototype.sort` default order and
// `JSON.stringify` of a string. `crates/plur1bus-core/src/js.rs` replays every file. Recorded, never edited by hand.
//
// A string is stored as a JSON string when it is well-formed, else as `{"u16":[code units]}` (JSON cannot hold a lone
// surrogate). The Rust side holds every such string as UTF-16 code units.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-js.ts [--check]
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";

export const codec = (s: string): unknown => (s.isWellFormed() ? s : { u16: Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)) });
const units = (): number[] => Array.from({ length: 0x10000 }, (_, i) => i);
const ch = (u: number) => String.fromCharCode(u);

// Every JavaScript white-space and line-terminator unit, glued to letters in many ways.
const SPACES = ["\t", "\n", "\v", "\f", "\r", " ", " ", " ", ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)), " ", " ", " ", " ", "　", "﻿"];
const NEAR_SPACES = ["\u0085", "᠎", "​", "‌", "‍", "⁠", "­", "\u0000", "\u001f", "\u007f"];
const LONE_HI = "\ud83d", LONE_LO = "\ude00";
const SAMPLE_STRINGS: string[] = [
  "", " ", "a", "A", "abc", "ABC", "Hello World", "  padded  ", "\t\n a b \r\n", "a ", " a", "　x　", "﻿x﻿", " x ", "x​", "​x", "\u0085x\u0085", "᠎x᠎",
  ...SPACES.map((s) => `${s}x${s}`), ...SPACES.map((s) => `${s}${s}`), ...NEAR_SPACES.map((s) => `${s}x${s}`),
  "ß", "ẞ", "straße", "STRASSE", "ſ", "ſs", "K", "Kk", "k", "İ", "i̇", "ı", "İstanbul", "ISTANBUL", "ıstanbul", "ǅ", "ǆ", "Ǆ", "ŉ", "ǰ", "ΐ", "ΰ", "ﬃ", "ﬁ", "ﬀ", "ᾳ", "ᾼ", "ΑΣ", "ΑΣ ", "ΑΣΑ", "Σ", "σ", "ς", "ΌΣΟΣ",
  "ü", "Ü", "ÜBERWEISUNG", "überweisung", "Überweisung", "ä", "Ä", "ö", "Ö", "é", "É", "ÿ", "Ÿ", "µ", "Μ", "ǆ", "ꭰ", "Ꭰ", "ᏸ", "Ᏸ",
  "😀", "a😀b", "😀😀", "𝒜", "𐐨", "𐐀", "\u{1F1E9}\u{1F1EA}", "é", "é", "가", "가",
  "a" + LONE_HI, LONE_LO + "a", LONE_HI, LONE_LO, LONE_LO + LONE_HI, LONE_HI + LONE_HI + LONE_LO, "x" + LONE_HI + "y",
  "\u0000", "a\u0000b", "\u0001\u001f", "\b\f\n\r\t", "\"quoted\"", "back\\slash", "/slash/", "\u007f", "  ", "<script>", "key=value", "a-b_c.d", "0123456789", "_", "-", "foo_bar", "foo-bar", "über_straße",
  "é".normalize("NFD"), "é".normalize("NFC"), "Å".normalize("NFD"), "x".repeat(50), "a b".repeat(20),
];

function buildStrings() {
  const cases = SAMPLE_STRINGS.map((s) => {
    const boundaries: number[] = [];
    for (let i = 0; i <= s.length; i++) { const re = /\b/y; re.lastIndex = i; if (re.test(s)) boundaries.push(i); }
    const wf = s.isWellFormed();
    return {
      s: codec(s), length: s.length, trim: codec(s.trim()), boundaries,
      jsonStringify: JSON.stringify(s),
      ...(wf ? { upper: s.toUpperCase(), lower: s.toLowerCase() } : {}),
    };
  });
  return { cases };
}

// --- classes: \s, \w, case-insensitive matching ------------------------------------------------------------------------------
function probeUnits(src: string): number[] {
  const re = new RegExp(`^${src}$`, "i");
  return units().filter((u) => re.test(ch(u)));
}
function buildClasses() {
  const space = units().filter((u) => /\s/.test(ch(u)));
  const word = units().filter((u) => /\w/.test(ch(u)));
  // `trim` removes exactly the `\s` units (the Rust side uses one predicate for both).
  const trimmedAway = units().filter((u) => ch(u).trim() === "");
  if (JSON.stringify(trimmedAway) !== JSON.stringify(space)) throw new Error("trim and \\s differ");
  // The case-insensitive probes: every literal the scanner patterns hold, and the classes they use.
  const probes: Record<string, number[]> = {};
  for (let c = 0x61; c <= 0x7a; c++) probes[ch(c)] = probeUnits(ch(c));
  for (const lit of ["ü", "Ü", "ß", "ä", "ö", "é", "µ", "ÿ", "0", "-", "_", " "]) probes[lit] = probeUnits(lit === " " ? "[ ]" : lit === "-" ? "\\-" : lit);
  for (const cls of ["[A-Z]", "[a-z]", "[0-9A-Z]", "[A-Za-z0-9_-]", "[A-Za-z0-9]"]) probes[cls] = probeUnits(cls);
  // Named characters against named patterns: `ſ` and `K` (Kelvin) fold to ASCII under full case folding but not under
  // `Canonicalize` of a non-Unicode regular expression; `ß` upper-cases to two units and so stays itself; `İ` and `ı` too.
  const named = ["ſ", "K", "ß", "ẞ", "İ", "ı", "ü", "Ü", "µ", "μ", "Σ", "ς", "σ", "ǅ", "ǆ", "Ǆ"];
  const patterns = ["s", "S", "k", "K", "i", "I", "ss", "SS", "ü", "Ü", "ß", "[A-Z]", "[a-z]", "\\w", "\\b"];
  const matrix = named.map((c) => ({ ch: c, matches: patterns.map((p) => new RegExp(`^${p}$`, "i").test(c)) }));
  // Whole-text spot checks: `\b` + ü at the start, k vs Kelvin, ß vs SS, ſ vs s inside a keyword.
  const texts = ["überweisung", "xüberweisung", "Überweisung", "ÜBERWEISUNG", "1überweisung", "_überweisung", "führerschein", "FÜHRERSCHEIN", "driverKs license", "ſsn", "SSN", "ssn", "sſn", "strasse", "straße", "KRANKHEIT", "Krankheit", "krankheit"];
  const textPattern = /\b(?:überweisung|führerschein|ssn|krankheit)\b/i;
  const spot = texts.map((t) => ({ s: codec(t), matches: textPattern.test(t) }));
  const sha = (f: (s: string) => string) => {
    const h = createHash("sha256"); const parts: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) { if (cp >= 0xd800 && cp <= 0xdfff) continue; parts.push(f(String.fromCodePoint(cp))); }
    h.update(parts.join("\n"), "utf8"); return h.digest("hex");
  };
  return {
    classes: { space, word, probes, namedChars: named, namedPatterns: patterns, namedMatrix: matrix, spot },
    digests: { scalars: 0x110000 - 0x800, upperSha256: sha((s) => s.toUpperCase()), lowerSha256: sha((s) => s.toLowerCase()), note: "sha256 over toUpperCase/toLowerCase of every Unicode scalar value (surrogates excluded), joined by LF" },
  };
}

// --- sort ----------------------------------------------------------------------------------------------------------------------
function buildSort() {
  const lists: string[][] = [
    [], ["a"], ["b", "a"], ["credential", "financial", "health", "identity", "personal"], ["personal", "identity", "health", "financial", "credential"],
    ["health", "credential", "personal", "financial", "identity"], ["B", "a", "C", "b", "A", "c"], ["10", "9", "1", "100", "2"], ["a", "a", "A", "a"], ["", "a", " ", "\u0000"],
    ["ü", "u", "z", "Ü", "a"], ["é", "e", "f", "É"], ["～", "😀", "", "퟿", "𝒜", "￿"], ["😀", "～"], ["\u{10000}", "￿"], ["a😀", "a￿", "a퟿"],
    ["ab", "a", "abc", "b", ""], ["Z", "a", "_", "-", "0", "~"], ["ß", "ss", "SS", "ſ"], ["\ud83d", "😀", "\ude00", ""], ["x", "x ", " x", "x\t"],
  ];
  return { cases: lists.map((l) => ({ input: l.map(codec), expected: l.slice().sort().map(codec) })) };
}

export async function buildJsVectors(): Promise<Record<string, any>> {
  const classes = buildClasses();
  return { strings: buildStrings(), classes: classes.classes, digests: classes.digests, sort: buildSort() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "js", build: buildJsVectors });
}
