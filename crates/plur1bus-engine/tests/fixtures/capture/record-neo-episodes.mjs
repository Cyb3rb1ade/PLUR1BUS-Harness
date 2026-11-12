// RE-05/T5 neo-episodes recordings from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file>
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "b097045b6f115275baa8b15016321c3ba080c812";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git || process.version !== "v24.21.0") {
  throw new Error("pinned source, read-only git and Node 24.21.0 required");
}
const verified = new Map();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function verify(relative) {
  if (verified.has(relative)) return;
  const source = readFileSync(path.join(root, relative));
  const expected = execFileSync("git", ["-C", git, "show", `${PIN}:${relative}`], { maxBuffer: 16 * 1024 * 1024 });
  if (!source.equals(expected)) throw new Error(`pinned neo-episodes source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/episodes.js");
// Explicit deterministic host seams; the frozen engine sources are unchanged.
const crypto = (await import("node:crypto")).default;
crypto.randomUUID = () => "00000000-0000-4000-8000-000000000001";
(await import("node:module")).syncBuiltinESMExports();
const now = "2026-11-08T12:00:00.000Z";
const OriginalDate = Date;
globalThis.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return OriginalDate.parse(now); }
};
const { groupTurnsIntoEpisodes, createEpisode, calculateVividness } =
  await import(pathToFileURL(path.join(root, "lib/episodes.js")));
const assert = (await import("node:assert/strict")).default;
const turn = (i, content, role = "user", minutes = i) => ({
  id: `turn-${i}`, content, role, workspaceKey: "workspace:v1:fixture", agentId: "alpha",
  createdAt: new Date(Date.now() + minutes * 60000).toISOString(),
});
const baseOptions = { workspaceKey: "workspace:v1:fixture", agentId: "alpha", sessionKey: "agent:alpha:direct:fixture" };
const texts = [
  "ordinary project fact", "Die Architektur bleibt. Neue Architektur funktioniert.",
  "Wir testen Architektur und Datenschutz in Rust.", "Architecture architecture testing testing",
  "[Audio transcript] Eva: Hallo. Bernd: Danke! Eva: Ja.",
  "[Audio transcript] Stimme: Nein. Quelle: Link. Anna-Maria: Hallo. Jean Paul: Guten Tag.",
  "[Audio transcript] Eva: Ja. [Audio transcript] Olga: Gut. Ирина: Да. Ágnes: Igen.",
  "[Audio transcript] Sprecher 1: Nein. Alice: Ja. Bob: Ja. Carol: Ja. David: Ja. Edgar: Ja. Fred: Ja.",
  "[media attached: fixture] https://example.invalid/secret <caption>Hidden</caption> `code-hidden` Projekt Projekt",
  "alpha äpfel zebra äpfel alpha zebra", "abcde abcde Äpfel Äpfel", "12project 12project topic-topic topic-topic",
  "opaque \ud800 text \udc00 Projekt Projekt", "🫩 emoji emoji Text Text", "",
  "[Audio transcript] \u{10d50}\u{10d70}: Ja. \u{10d51}\u{10d71}: Ja.",
  "Wort \u{10d50}\u{10d70}\u{10d71} \u{10d50}\u{10d70}\u{10d71}",
];
function run() {
  const cases = [];
  const record = (name, turns, options = {}) => {
    options = { ...baseOptions, ...options };
    const episode = createEpisode(turns, options);
    cases.push({ name, turns, options, now, output: episode,
      vividness: episode ? calculateVividness(episode) : null });
  };
  record("empty", []);
  for (const [i, content] of texts.entries()) {
    for (const role of ["user", "assistant", "tool"]) record(`text-${i}-${role}`, [turn(0, content, role)]);
  }
  record("mixed", [turn(0, texts[1]), turn(1, texts[2], "assistant"), turn(2, "test passed", "tool")]);
  record("named", [turn(0, texts[4]), turn(1, "Reply", "assistant")], { participantNames: { user: "Eva", assistant: "Bernd" } });
  record("same-label", [turn(0, "Fact"), turn(1, "Reply", "assistant")], { participantNames: { user: "ALPHA", assistant: "alpha" } });
  record("voice-per-turn-cap", [turn(0, texts[7]), turn(1, "[Audio transcript] Greta: Ja.")]);
  for (const intensity of ["hoch", "mittel", "niedrig", "unknown"]) {
    for (const dominant of ["joy", "fear", "disgust"]) record(`mood-${intensity}-${dominant}`, [turn(0, "Fact")], {
      mood: { intensity, dominant, details: { joy: 0.5, fear: 2, anger: -1, trust: "0.3", surprise: null } },
    });
  }
  for (const valence of [{ joy: 0.6, fear: 0.2 }, "joy:0.4,fear:0.7", "joy:1.5tail,trust:1e-1", "joy:inf,fear:0x10",
    { joy: "0.5", trust: true }, { anger: -1 }, {}]) {
    record(`legacy-valence-${cases.length}`, [{ ...turn(0, "Fact"), emotionalValence: valence }, turn(1, "Reply", "assistant")]);
  }
  for (const sessionKey of ["x:group:one", "x:heartbeat", "x:cron", "plain", "x:cron:direct:one"]) {
    record(`location-${sessionKey}`, [turn(0, "Fact")], { sessionKey });
  }
  for (const minutes of [0, 0.49, 0.5, 1.5, -0.5, -1.5, 61]) {
    record(`duration-${minutes}`, [turn(0, "Fact"), turn(1, "Reply", "assistant", minutes)]);
  }
  const groups = [];
  for (const minutes of [[], [0], [0, 30, 60], [0, 30.01, 60.02], [60, 0, 30], [0, 0, 0, 0]]) {
    for (const maxGapMinutes of [0, 1, 30, -1]) for (const maxEpisodeTurns of [1, 2, 50]) {
      const turns = minutes.map((minute, i) => turn(i, "Fact", "user", minute));
      const options = { maxGapMinutes, maxEpisodeTurns };
      groups.push({ turns, options, output: groupTurnsIntoEpisodes(turns, options) });
    }
  }
  return { cases, groups };
}
const here = path.dirname(fileURLToPath(import.meta.url));
// Algorithm data follows the same existing Unicode-3.0 notice as the quality classifier.
const notice = JSON.parse(readFileSync(path.join(here, "../../../src/capture/quality-unicode17.json"), "utf8"));
const classes = {};
for (const property of ["Lu", "Ll", "Extended_Pictographic"]) {
  const pattern = new RegExp(`\\p{${property}}`, "u");
  const ranges = [];
  let first = null;
  for (let cp = 0; cp <= 0x110000; cp++) {
    const matches = cp <= 0x10ffff && pattern.test(String.fromCodePoint(cp));
    if (matches && first === null) first = cp;
    if (!matches && first !== null) { ranges.push([first, cp - 1]); first = null; }
  }
  classes[property] = ranges;
}
const unicodeBytes = JSON.stringify({
  node: process.version, unicode: process.versions.unicode, icu: process.versions.icu,
  source: "Node RegExp Unicode property escapes", license: "Unicode-3.0", licenseNotice: notice.licenseNotice, classes,
}, null, 2) + "\n";
writeFileSync(path.join(here, "../../../src/neo/episode-unicode17.json"), unicodeBytes);

const recorded = run();
assert.deepEqual(run(), recorded);
writeFileSync(path.join(here, "golden/neo-episodes.json"), JSON.stringify({
  provenance: { commit: PIN, node: process.version, sourceHashes: Object.fromEntries(verified),
    clock: now, unicodeDataSha256: digest(unicodeBytes), uuidProvider: "constant fixture UUID through Node builtin export" }, ...recorded,
}, null, 2) + "\n");
console.log(`Recorded ${recorded.cases.length} actual Node episode builds and ${recorded.groups.length} groups twice`);

