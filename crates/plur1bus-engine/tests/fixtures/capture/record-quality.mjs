// RE-05/T3 deterministic fact quality and category goldens from the verified Node pin.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pin = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const source = process.env.PLUR1BUS_ENGINE_SRC;
const repository = process.env.PLUR1BUS_ENGINE_GIT;
if (!source || !repository) throw new Error("PLUR1BUS_ENGINE_SRC and PLUR1BUS_ENGINE_GIT required");
if (process.version !== "v24.21.0") throw new Error("Node v24.21.0 required");
if (process.versions.unicode !== "17.0" || process.versions.icu !== "78.3") {
  throw new Error("Recorder requires Unicode 17.0 and ICU 78.3");
}
const files = ["lib/memory-fact-quality.js", "lib/categorize.js"];
const sourcesSha256 = {};
for (const file of files) {
  const expected = execFileSync("git", ["-C", repository, "show", `${pin}:${file}`]);
  const actual = readFileSync(join(source, file));
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (hash(expected) !== hash(actual)) throw new Error(`Pinned source hash mismatch: ${file}`);
  sourcesSha256[file] = hash(actual);
}
const quality = await import(pathToFileURL(join(source, files[0])));
const category = await import(pathToFileURL(join(source, files[1])));
const licensePath = process.env.PLUR1BUS_NODE_LICENSE ?? join(dirname(dirname(process.execPath)),
  "node_modules", `node-bin-${process.platform}-${process.arch}`, "LICENSE");
const nodeLicense = readFileSync(licensePath, "utf8");
const noticeStart = nodeLicense.indexOf("    UNICODE LICENSE V3");
const noticeEnd = nodeLicense.indexOf("    SPDX-License-Identifier: Unicode-3.0", noticeStart);
if (noticeStart < 0 || noticeEnd < 0) throw new Error("Node ICU Unicode-3.0 attribution not found");
const licenseNotice = nodeLicense.slice(noticeStart, noticeEnd + "    SPDX-License-Identifier: Unicode-3.0".length)
  .replace(/^ {4}/gm, "");
const letterNumber = /[\p{L}\p{N}]/u;
const ranges = [];
let first = null;
for (let codepoint = 0; codepoint <= 0x110000; codepoint += 1) {
  const included = codepoint < 0x110000 && letterNumber.test(String.fromCodePoint(codepoint));
  if (included && first === null) first = codepoint;
  if (!included && first !== null) {
    ranges.push([first, codepoint - 1]);
    first = null;
  }
}
const productionData = `${JSON.stringify({ node: process.version, unicode: process.versions.unicode,
  icu: process.versions.icu, source: "Node RegExp Unicode property escapes: General_Category Letter or Number",
  generator: "tests/fixtures/capture/record-quality.mjs --quality", license: "Unicode-3.0", licenseNotice, ranges }, null, 2)}\n`;
const productionPath = join(dirname(fileURLToPath(import.meta.url)), "../../../src/capture/quality-unicode17.json");
writeFileSync(productionPath, productionData);
const productionDataSha256 = createHash("sha256").update(productionData).digest("hex");
const codepoints = new Set([0, 0xd800, 0xdc00, 0x10ffff]);
for (const [start, end] of ranges) {
  for (const point of [start - 1, start, end, end + 1]) {
    if (point >= 0 && point <= 0x10ffff) codepoints.add(point);
  }
}
const unicodeChecks = [...codepoints].sort((a, b) => a - b)
  .map((codepoint) => ({ codepoint, matches: letterNumber.test(String.fromCodePoint(codepoint)) }));
const units = (text) => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
const texts = [
  "", "  ", "!!!", "ok", "okay!", "go on", "ja", "nein", "ich und du", "the a is",
  "I prefer short answers.", "I want coffee today.", "Remember this: the project uses Rust.",
  "from now on use short answers", "ab jetzt bitte kurz", "merke---dir diese Entscheidung",
  "Don't forget the project code.", "Knie", "Melanie", "Ingenieur", "Zimmer", "immer", "nie",
  "möchte", "mo\u0308chte", "möchte morgen", "müde", "mu\u0308de", "happy sad", "I am tired",
  "npm test passed", "npm test läuft", "Deployment läuft auf Node 22", "The app runs on Node 24.",
  "Node React Postgres", "nodejs react", "node react", "Node 24 uses Redis for project caching.",
  "We decided to use Postgres.", "Security bypass fixed in service authentication.",
  "We no longer use Redis", "Postgres instead of MySQL", "jetzt Rust statt Node", "nicht mehr",
  "red, not blue", "rot, nicht blau", "architecture", "architecture chosen for service persistence",
  "Alice is the project owner.", "Berlin has a festival in 2026.", "it is", "this is a message",
  "error traceback", "config threshold default", "https://example.test/fixture", "reference link",
  "name: Alice", "company: Example", "product: Widget", "place: Berlin", "person: Ada",
  "\ufeffI prefer concise answers\u00a0", "ſecurity fixed authentication bypass", "Konfig default",
  "你好", "مرحبا", "𐐀𐐨", "Node uses 𑶰𑶱 for project caching", "Remember 你好 project choices",
  "synthetic\ud83d", "🚀 remember this", "deployment\nfixed", "not\nanymore",
];
const cases = [];
function add(name, args, value, text) {
  cases.push({ name, args: JSON.stringify(args), ...(text === undefined ? {} : { textUnits: units(text) }),
    raw: JSON.stringify(value) });
}
for (const text of texts) {
  for (const name of ["detectTrivialMemory", "detectTemporaryMemory", "detectDurablePreference",
    "detectProjectFact", "detectCorrectionSignal", "classifyFactDurability", "explainFactQuality"]) {
    add(name, [], quality[name](text), text);
  }
  add("categorizeMemoryWithReason", [], category.categorizeMemoryWithReason(text), text);
  add("categorizeMemory", [], category.categorizeMemory(text), text);
  for (const explicitImportance of [undefined, 0, 0.3, 0.95, 1]) {
    const categoryReason = category.categorizeMemoryWithReason(text).reason;
    const params = { text, categoryReason, ...(explicitImportance === undefined ? {} : { explicitImportance }) };
    const result = quality.computeMemoryImportance(params);
    add("computeMemoryImportance", [{ categoryReason, ...(explicitImportance === undefined ? {} : { explicitImportance }) }], result, text);
  }
  const factQuality = quality.explainFactQuality(text);
  for (const assigned of ["decision", "fact", "other"]) {
    add("shouldPromoteMemory", [assigned, 0.7, factQuality, 0.7], quality.shouldPromoteMemory(assigned, 0.7, factQuality, 0.7));
  }
}
for (const value of [-1, 0, 1e-7, 0.94, 0.95, 1, 2]) {
  for (const explicit of [false, true]) add("capAutomaticImportance", [value, explicit], quality.capAutomaticImportance(value, explicit));
}
for (const params of [{}, { categoryReason: "" }, { explicitImportance: null }, { explicitImportance: "0.95" }]) {
  const text = "Synthetic project choice";
  add("computeMemoryImportance", [params], quality.computeMemoryImportance({ text, ...params }), text);
}
const reasonSets = [[], ["filler acknowledgement"], ["contains temporary marker", "technical term"],
  ["explicit instruction", "contains temporary marker"], ["preference verb"], ["technical term"],
  ["generic technical keywords without subject", "technical term"], ["correction pattern"],
  ["concrete security/deploy fact"], ["filler acknowledgement", "explicit instruction"],
];
for (const score of [0, 0.5, 0.9, 1]) {
  for (const reasons of reasonSets) {
    for (const opts of [{}, { downrankTrivial: false }, { downrankTemporary: false },
      { minDurablePreference: 0.2, minProjectFact: 0.3, minExplicitRemember: 0.4, minSecurityDeploy: 0.5 }]) {
      add("normalizeImportanceScore", [score, reasons, opts], quality.normalizeImportanceScore(score, reasons, opts));
    }
  }
}
const directory = join(dirname(fileURLToPath(import.meta.url)), "golden");
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, "quality.json"), `${JSON.stringify({ provenance: { engine: "node", commit: pin,
  node: process.version, unicode: process.versions.unicode, icu: process.versions.icu, flags: ["--quality"], sourcesSha256,
  productionDataSha256,
  disabledOptions: [], normalization: "none; input text encoded as UTF-16 units; expected output is raw JSON.stringify bytes" },
  unicodeChecks, constants: { categories: category.MEMORY_CATEGORIES, origins: category.MEMORY_ORIGINS, scopes: category.MEMORY_SCOPES,
    automaticImportanceMax: quality.AUTOMATIC_IMPORTANCE_MAX }, cases }, null, 2)}\n`);
