#!/usr/bin/env node
// Record Node 24.21 JS text-semantics vectors, lib/text-utils.js outputs and lone-surrogate JSONL
// fixtures for RE-04/T0 (RE-D17, plan §2.5).
//
// Run from the repository root with Node 24.21 first on PATH after `pnpm test:prep`:
//   node crates/plur1bus-engine/tests/fixtures/text/record.mjs
//
// Do not edit the generated js-vectors.json, text-utils.json or json-lines.jsonl files by hand.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.version.startsWith("v24.21.")) {
  console.error(`record.mjs: expected Node 24.21.x on PATH, got ${process.version}`);
  process.exit(1);
}

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CORE_PKG = path.resolve(FIXTURE_DIR, "../../../../../packages/core/package.json");
const requireFromCore = createRequire(CORE_PKG);
const engineRoot = path.dirname(requireFromCore.resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
const {
  tokenize,
  jaccardSimilarity,
  generateSummary,
  compressMemorySlotsForPrompt,
} = await import(pathToFileURL(path.join(engineRoot, "lib", "text-utils.js")).href);

const collatorLocale = new Intl.Collator().resolvedOptions().locale;

// Every code point named in RE-04/T0 Step 1 plus boundary/historical probes around them.
const WHITESPACE_CODE_POINTS = [
  0x0000,
  0x0008,
  0x0009,
  0x000a,
  0x000b,
  0x000c,
  0x000d,
  0x000e,
  0x001f,
  0x0020,
  0x0021,
  0x007f,
  0x0085,
  0x00a0,
  0x1680,
  0x180e,
  0x1fff,
  0x2000,
  0x2001,
  0x2002,
  0x2003,
  0x2004,
  0x2005,
  0x2006,
  0x2007,
  0x2008,
  0x2009,
  0x200a,
  0x200b,
  0x200c,
  0x200d,
  0x2028,
  0x2029,
  0x202f,
  0x205f,
  0x2060,
  0x3000,
  0xfeff,
  0xfffe,
];

const whitespaceVectors = WHITESPACE_CODE_POINTS.map((codePoint) => {
  const ch = String.fromCodePoint(codePoint);
  return {
    codePoint,
    hex: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
    matchesJsWhitespace: /^\s$/u.test(ch),
  };
});

const SAMPLES = [
  {
    name: "german_umlauts_and_accents",
    text: "Herr Müller wohnt in Köln an der Straße, café naïve Größe",
    sliceEnds: [0, 4, 11, 25, 57, 100],
  },
  {
    name: "german_trim_feff_and_uppercase_eszett",
    text: "\uFEFF \t\nHerr Müller & GROSSE STRAßE (ẞ)\u00A0\u2028\u3000\uFEFF",
    sliceEnds: [0, 1, 4, 15, 35, 39],
  },
  {
    name: "nel_is_not_trimmed",
    text: "\u0085  kept around NEL \t\u0085",
    sliceEnds: [0, 1, 3, 18, 21],
  },
  {
    name: "nfd_combining_and_compatibility",
    text: "Mu\u0308ller Ko\u0308ln cafe\u0301 nai\u0308ve A\u030A \u212B \uFB01nanc\u0327ais \u2460\u2461",
    sliceEnds: [0, 2, 3, 7, 12, 24, 42],
  },
  {
    name: "emoji_surrogate_cuts",
    text: "Grüße 🚀🔥 und 🧠✨",
    // "Grüße " is 6 UTF-16 units; 🚀 is units 6..8, 🔥 is 8..10; " und " is 10..15; 🧠 is 15..17, ✨ is 17..18.
    sliceEnds: [0, 5, 6, 7, 8, 9, 10, 15, 16, 17, 18, 25],
  },
  {
    name: "emoji_leading_and_zwj",
    text: "🌍🤖💡 Familie 👨‍👩‍👧‍👦 Test",
    sliceEnds: [0, 1, 2, 3, 4, 5, 6, 15, 16, 17, 26, 31],
  },
  {
    name: "cjk_and_fullwidth",
    text: "東京のメモリ検索と日本語テキスト処理（テスト１２３・🚀）",
    sliceEnds: [0, 2, 8, 18, 25, 26, 27, 28],
  },
  {
    name: "special_casing_turkish_and_greek",
    text: "İSTANBUL IŞIK ΣΟΣ ΦΙΛΟΣ Σ",
    sliceEnds: [0, 1, 8, 13, 17, 25],
  },
];

function utf16UnitsOf(str) {
  const units = [];
  for (let i = 0; i < str.length; i += 1) {
    units.push(str.charCodeAt(i));
  }
  return units;
}

function sha256Utf8(str) {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

const stringVectors = SAMPLES.map((sample) => {
  const s = sample.text;
  return {
    name: sample.name,
    input: s,
    utf16Len: s.length,
    trimmed: s.trim(),
    lowered: s.toLowerCase(),
    nfkd: s.normalize("NFKD"),
    nfc: s.normalize("NFC"),
    nfkc: s.normalize("NFKC"),
    slices: sample.sliceEnds.map((end) => {
      const sliced = s.slice(0, end);
      const jsonText = JSON.stringify(sliced);
      const stableIdJson = JSON.stringify(["neo-stable-id-v1", "statement", sliced]);
      return {
        end,
        utf16Units: utf16UnitsOf(sliced),
        json: jsonText,
        utf8Lossy: Buffer.from(sliced, "utf8").toString("utf8"),
        sha256Raw: sha256Utf8(sliced),
        sha256JsonMaterial: sha256Utf8(stableIdJson),
      };
    }),
  };
});

// Engine call sites that invoke String.prototype.localeCompare, with the exact argument shape each site passes.
const LOCALE_COMPARE_SITES = [
  {
    site: "lib/episodes.js:230",
    args: [],
    keys: [
      "müller",
      "mueller",
      "muller",
      "köln",
      "koeln",
      "straße",
      "strasse",
      "größe",
      "groesse",
      "café",
      "cafe",
      "naïve",
      "naive",
      "äpfel",
      "apfel",
      "über",
      "uber",
      "zürich",
      "zurich",
    ],
  },
  {
    site: "lib/memory-graph.js:245",
    args: [],
    keys: [
      "018f4a90-1234-7000-8000-000000000001",
      "018f4a90-1234-7000-8000-000000000002",
      "018f4a90-1234-7000-8000-00000000000a",
      "018f4a90-1234-7000-8000-00000000000A",
      "mem_alpha-1",
      "mem_alpha_1",
      "mem_Alpha-1",
      "mem_beta",
      "mem_äpfel",
      "mem_apfel",
    ],
  },
  {
    site: "lib/memory-compaction.js:61",
    args: [],
    keys: [
      "",
      "00000000-0000-4000-8000-000000000000",
      "00000000-0000-4000-8000-000000000001",
      "a1b2c3d4-e5f6-4789-8012-3456789abcde",
      "A1B2C3D4-E5F6-4789-8012-3456789ABCDE",
      "f0000000-0000-4000-8000-000000000000",
    ],
  },
  {
    site: "lib/memory-compaction.js:80",
    args: [],
    keys: [
      "11111111-2222-4333-8444-555555555554",
      "11111111-2222-4333-8444-555555555555",
      "11111111-2222-4333-8444-555555555556",
      "11111111-2222-4333-8444-55555555555a",
      "11111111-2222-4333-8444-55555555555f",
    ],
  },
  {
    site: "lib/memory-compaction.js:660",
    args: [],
    keys: [
      "22222222-0000-4000-8000-000000000009",
      "22222222-0000-4000-8000-000000000010",
      "22222222-0000-4000-8000-00000000001a",
      "22222222-0000-4000-8000-000000000020",
    ],
  },
  {
    site: "lib/reembedding/fingerprint.js:68",
    args: [],
    keys: [
      "config.json",
      "onnx/model.onnx",
      "onnx/model_quantized.onnx",
      "onnx/model-q8.onnx",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    ],
  },
  {
    site: "lib/jobs/skill-miner/evidence-aggregator.js:306",
    args: [],
    keys: [
      "agent",
      "ähneln",
      "aehneln",
      "docker",
      "größe",
      "groesse",
      "lancedb",
      "müller",
      "mueller",
      "ökonomie",
      "oekonomie",
      "rust",
      "straße",
      "strasse",
      "überprüfung",
      "ueberpruefung",
    ],
  },
];

const localeCompareVectors = LOCALE_COMPARE_SITES.map(({ site, args, keys }) => {
  const sorted = [...keys].sort((a, b) => a.localeCompare(b, ...args));
  const pairs = [];
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = 0; j < keys.length; j += 1) {
      pairs.push({
        a: keys[i],
        b: keys[j],
        sign: Math.sign(keys[i].localeCompare(keys[j], ...args)),
      });
    }
  }
  return { site, args, keys, sorted, pairs };
});

// ASCII word-boundary and character-class vectors.
const ASCII_BOUNDARY_CASES = [
  {
    name: "emotional_state_leading_umlaut_words",
    pattern: "\\b(überrasch|ärger|übel|übernommen|öfter|ändern)\\b",
    flags: "i",
    inputs: [
      "überrasch",
      "Ich bin überrascht",
      "ärger im Projekt",
      "Ärger",
      "übel",
      "übernommen",
      "öfter",
      "ändern",
      "xüberrasch",
      "a_überrasch",
    ],
  },
  {
    name: "recall_budget_project_signals",
    pattern: "\\b(project|plan|milestone|roadmap|deadline)\\b",
    flags: "i",
    inputs: [
      "Das Projekt hat eine neue Struktur",
      "Unser Projektplan steht",
      "The project milestone is tomorrow",
      "We need a plan for the roadmap",
      "überplan und Ära",
    ],
  },
  {
    name: "ascii_digits_and_word_chars",
    pattern: "^\\d+:[\\w]+$",
    flags: "",
    inputs: [
      "123:abc_DEF_9",
      "123:müller",
      "123:straße",
      "٦:abc",
      "１２３:abc",
    ],
  },
];

const asciiBoundaryVectors = ASCII_BOUNDARY_CASES.map(({ name, pattern, flags, inputs }) => {
  const re = new RegExp(pattern, flags);
  return {
    name,
    pattern,
    flags,
    results: inputs.map((input) => ({
      input,
      matched: re.test(input),
    })),
  };
});

// Lookaround patterns used in the engine closure.
const LOOKAROUND_CASES = [
  {
    name: "fact_quality_phrase_boundary_nie",
    pattern: "(?<![\\p{L}\\p{N}])nie(?![\\p{L}\\p{N}])",
    flags: "iu",
    inputs: [
      "Ich war nie in Berlin.",
      "Melanie hat ihr Knie verletzt.",
      "Ein Ingenieur arbeitet nie allein.",
      "Nie wieder!",
      "übernie und nie_mals",
      "nie_mals",
    ],
  },
  {
    name: "fact_quality_phrase_boundary_immer",
    pattern: "(?<![\\p{L}\\p{N}])immer(?![\\p{L}\\p{N}])",
    flags: "iu",
    inputs: [
      "Das Zimmer ist immer warm.",
      "Im Zimmer schimmern Lichter.",
      "Immer wenn es regnet.",
      "immer!",
    ],
  },
  {
    name: "memory_chunking_sentence_end_decimal_guard",
    pattern: "(?<!\\d)[.!?…]+(?!\\d)(?:\\s|$)",
    flags: "g",
    inputs: [
      "Wert 3.5 mmol/l ist normal. Zweiter Satz! Dritter?",
      "Version 1.2.3 wurde veröffentlicht… Ende.",
      "Nur 3.14 und 2.718 ohne Punkt am Ende",
    ],
  },
  {
    name: "memory_chunking_sentence_split_lookbehind",
    pattern: "(?<=(?<!\\d)[.!?…])\\s+(?!\\d)",
    flags: "g",
    inputs: [
      "Wert 3.5 mmol/l bleibt stabil. Neuer Satz folgt! Und noch einer… 2. Punkt.",
      "Dr. Müller wohnt in Köln. Er trinkt 1.5 Liter Wasser.",
    ],
  },
  {
    name: "temporal_parser_duration_negative_lookahead",
    pattern:
      "\\b(?:bis\\s+(?:heute|jetzt|dato)|until\\s+(?:today|now)|up\\s+to\\s+(?:today|now)|so\\s+far|to\\s+date)\\b(?!\\s+(?:abend|mittag|nachmittag|vormittag|früh|frueh|morgen|nacht|um\\b|\\d|evening|noon|afternoon|morning|night|at\\b))",
    flags: "gi",
    inputs: [
      "Bis heute lief das System stabil.",
      "Bis heute abend um 18 Uhr.",
      "Everything worked until today morning.",
      "Everything worked until today.",
    ],
  },
  {
    name: "dream_narrative_sentence_split_lookbehind",
    pattern: "(?<=[.!?])\\s+",
    flags: "g",
    inputs: [
      "Erster Satz. Zweiter Satz! Dritter Satz?",
      "Keine Satzgrenze am Ende",
    ],
  },
];

const lookaroundVectors = LOOKAROUND_CASES.map(({ name, pattern, flags, inputs }) => {
  const baseFlags = flags.replace(/g/g, "");
  const singleRe = new RegExp(pattern, baseFlags);
  const globalFlags = flags.includes("g") ? flags : `${flags}g`;
  return {
    name,
    pattern,
    flags,
    results: inputs.map((input) => {
      const globalRe = new RegExp(pattern, globalFlags);
      const matches = [];
      let m;
      while ((m = globalRe.exec(input)) !== null) {
        matches.push({ match: m[0], byteStart: Buffer.byteLength(input.slice(0, m.index), "utf8") });
        if (m[0].length === 0) globalRe.lastIndex += 1;
      }
      return {
        input,
        matched: singleRe.test(input),
        matches,
      };
    }),
  };
});

const jsVectors = {
  runtime: {
    node: process.version,
    unicode: process.versions.unicode,
    icu: process.versions.icu,
    collatorLocale,
  },
  whitespace: whitespaceVectors,
  strings: stringVectors,
  localeCompare: localeCompareVectors,
  asciiBoundaries: asciiBoundaryVectors,
  lookarounds: lookaroundVectors,
};

// text-utils.json vectors
const TOKENIZE_INPUTS = [
  ...SAMPLES.map((s) => s.text),
  "",
  "a b c 1 22 333",
  "überraschend äpfel öfen übung straße",
  "Mu\u0308ller vs Müller vs Mueller",
];

const tokenizeVectors = TOKENIZE_INPUTS.map((input) => ({
  input,
  tokens: [...tokenize(input)],
}));

const JACCARD_PAIRS = [
  [
    "Herr Müller wohnt in Köln an der Straße, café naïve Größe",
    "Herr Mueller wohnt in Koeln an der Strasse, cafe naive Groesse",
  ],
  [
    "Herr Müller wohnt in Köln an der Straße",
    "Herr Mu\u0308ller wohnt in Ko\u0308ln an der Straße",
  ],
  [
    "Grüße 🚀🔥 und 🧠✨",
    "Grüße und Freude",
  ],
  [
    "東京のメモリ検索と日本語テキスト処理（テスト１２３・🚀）",
    "東京のメモリ検索とテスト123",
  ],
  ["", "nicht leer"],
  ["", ""],
  ["a b c", "d e f"],
  ["identisch eins zwei drei", "identisch eins zwei drei"],
];

const jaccardVectors = JACCARD_PAIRS.map(([a, b]) => ({
  a,
  b,
  similarity: jaccardSimilarity(a, b),
}));

const LONG_GERMAN_TEXT = Array.from(
  { length: 40 },
  (_, i) => `Abschnitt ${i + 1}: Herr Müller prüft in Köln die Größe der Straße und notiert Café naïve.`,
).join(" ");

const SUMMARY_CASES = [
  {
    text: "Herr Müller wohnt in Köln an der Straße, café naïve Größe",
    maxWords: 15,
  },
  {
    text: "Herr Müller wohnt in Köln an der Straße, café naïve Größe",
    maxWords: 5,
  },
  {
    text: "Erster Satz mit fünf Wörtern. Zweiter Satz folgt sofort! Dritter Satz am Ende?",
    maxWords: 9,
  },
  {
    text: "Erster kurzer Satz. Danach folgen sehr viele Wörter ohne irgendeine weitere Satzgrenze bis weit hinter das Limit hinaus.",
    maxWords: 10,
  },
  {
    text: "Eins zwei drei vier fünf sechs sieben acht neun zehn. Elf zwölf.",
    maxWords: 10,
  },
  {
    text: "   \uFEFFViel   Platz\t\tzwischen   Wörtern   bleibt   erhalten\uFEFF   ",
    maxWords: 10,
  },
  {
    text: "\u0085NEL zählt als Wort am Anfang und wird nach zehn Wörtern abgeschnitten ohne Punkt",
    maxWords: 5,
  },
  {
    text: LONG_GERMAN_TEXT,
    maxWords: 150,
  },
];

const summaryVectors = SUMMARY_CASES.map(({ text, maxWords }) => ({
  text,
  maxWords,
  summary: generateSummary(text, maxWords),
}));

const COMPRESS_CASES = [
  {
    name: "empty_memories",
    tokenBudget: 50,
    memories: [],
  },
  {
    name: "mixed_priorities_within_budget",
    tokenBudget: 40,
    memories: [
      {
        entry: {
          id: "m1",
          text: "Core Erinnerung mit mehreren Wörtern über Herrn Müller in Köln an der Straße.",
          summary: "",
          category: "general",
          memoryClass: "core",
        },
      },
      {
        entry: {
          id: "m2",
          text: "Projekt Entscheidung für die Datenbank Architektur und das Schema.",
          summary: "Kurzfassung: Projekt Entscheidung für die Datenbank Architektur.",
          category: "project",
          memoryClass: "standard",
        },
      },
      {
        entry: {
          id: "m3",
          text: "Episodische Notiz vom Gespräch am Nachmittag bei Café naïve.",
          summary: "",
          category: "episodic",
          memoryClass: "standard",
        },
      },
    ],
  },
  {
    name: "budget_exceeded_reduces_lowest_priority_first",
    tokenBudget: 7,
    memories: [
      {
        entry: {
          id: "c1",
          text: "Eins zwei drei vier fünf sechs sieben acht neun zehn.",
          summary: "",
          category: "canonical",
          memoryClass: "standard",
        },
      },
      {
        entry: {
          id: "d1",
          text: "Alpha beta gamma delta epsilon zeta eta theta iota kappa.",
          summary: "",
          category: "decision",
          memoryClass: "standard",
        },
      },
      {
        entry: {
          id: "e1",
          text: "Rot grün blau gelb orange lila schwarz weiß grau braun.",
          summary: "",
          category: "episodic",
          memoryClass: "standard",
        },
      },
      {
        entry: {
          id: "e2",
          text: "Nord süd ost west oben unten links rechts vorne hinten.",
          summary: "",
          category: "other",
          memoryClass: "standard",
        },
      },
    ],
  },
  {
    name: "tight_budget_zeroes_low_priority_slots",
    tokenBudget: 1,
    memories: [
      {
        entry: {
          id: "m1",
          text: "Erste wichtige Erinnerung mit langem Text.",
          summary: "",
          category: "canonical",
          memoryClass: "core",
        },
      },
      {
        entry: {
          id: "m2",
          text: "Zweite Erinnerung mit Projektdetails.",
          summary: "",
          category: "project",
          memoryClass: "standard",
        },
      },
      {
        entry: {
          id: "m3",
          text: "Dritte Erinnerung mit niedriger Priorität.",
          summary: "",
          category: "episodic",
          memoryClass: "standard",
        },
      },
    ],
  },
];

const compressVectors = COMPRESS_CASES.map(({ name, tokenBudget, memories }) => ({
  name,
  tokenBudget,
  memories,
  slots: compressMemorySlotsForPrompt(memories, tokenBudget),
}));

const textUtilsVectors = {
  tokenize: tokenizeVectors,
  jaccardSimilarity: jaccardVectors,
  generateSummary: summaryVectors,
  compressMemorySlotsForPrompt: compressVectors,
};

// json-lines.jsonl: Node JSON.stringify lines carrying lone-surrogate escapes.
const JSON_LINES = [
  JSON.stringify({
    id: "neo_1",
    statement: "Grüße 🚀🔥".slice(0, 7),
    fullText: "Herr Müller wohnt in Köln an der Straße",
    count: 1,
  }),
  JSON.stringify({
    id: "neo_2",
    statement: "🚀 Start".slice(1),
    tags: ["leading-low-surrogate", "🌍🤖".slice(0, 3)],
  }),
  JSON.stringify({
    id: "neo_3",
    text: `Pair 🚀 then lone ${"🧠".slice(0, 1)} with "quotes" \\ backslash \n newline \t tab and \u00fcmlaut`,
    nested: {
      ok: true,
      empty: "",
      items: ["🔥".slice(0, 1), "✨", "🔥".slice(1)],
    },
  }),
  JSON.stringify({
    id: "neo_4",
    adjacentLoneSurrogates: `${"🚀".slice(0, 1)}${"🔥".slice(0, 1)}`,
    reversedSurrogates: `${"🚀".slice(1)}${"🚀".slice(0, 1)}`,
    numbers: [0, -1, 42.5, 1e6],
    flags: [true, false, null],
  }),
];

writeFileSync(
  path.join(FIXTURE_DIR, "js-vectors.json"),
  `${JSON.stringify(jsVectors, null, 2)}\n`,
  "utf8",
);
writeFileSync(
  path.join(FIXTURE_DIR, "text-utils.json"),
  `${JSON.stringify(textUtilsVectors, null, 2)}\n`,
  "utf8",
);
writeFileSync(
  path.join(FIXTURE_DIR, "json-lines.jsonl"),
  `${JSON_LINES.join("\n")}\n`,
  "utf8",
);
