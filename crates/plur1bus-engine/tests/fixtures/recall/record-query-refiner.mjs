// Record `lib/query-refiner.js` at the Node pin for the native port (RE-D151).
//
//   node record-query-refiner.mjs --source <copy of lib/query-refiner.js at the pin> --out <file>
//
// The source hash is checked before any import. The tables are not exported at the pin, so the
// recorder imports a temporary copy with one appended export line; the original code is unchanged.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const COMMIT = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const PATH = "lib/query-refiner.js";
const SHA256 = "136e4aa6b2408bffbe6a02791b118818abb5ae4e1c3a25d1565b27373453c389";

const argument = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
};
const source = readFileSync(argument("--source"));
if (createHash("sha256").update(source).digest("hex") !== SHA256) {
  throw new Error("query-refiner source does not match the pin");
}
const dir = mkdtempSync(join(tmpdir(), "query-refiner-"));
let refiner;
try {
  const file = join(dir, "query-refiner.mjs");
  writeFileSync(file, `${source}\nexport { STOPWORDS as __stopwords, SYNONYM_MAP as __synonyms };\n`);
  refiner = await import(pathToFileURL(file).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const inputs = [
  "", " ", "   ", "\t\n", "the", "Der die das", "THE and OR", "Docker setup",
  "kubernetes config server", "API Fehler beim Deploy", "Wie konfiguriere ich den Docker Container?",
  "ÄRGER über die Größe", "Müller's café naïve résumé", "TEST testing Test", "docker docker container k8s kubernetes",
  "db database DB", "setup installation konfiguration config", "emoji 🚀 deploy 🎉 now", "surrogate 𝒳 test",
  "CJK 東京 server", "é combined accent", "tabs\tand\nnewlines  deploy", "NBSP server host",
  "ﬁle ligature config", "Ｆｕｌｌｗｉｄｔｈ ＡＰＩ", "123 456 error", "error-handling in API_v2",
  "What did we decide last week about the project?", "project fixture item", "Schnittstelle API Fehler Bug",
  "bug bug bug", "Kann ich das Setup testen", ".,;:!?", "a b c d e", "Ich will Docker", "Straße und Weg",
  "İstanbul server", "ΣΊΣΥΦΟΣ deploy", "Deploy deployment DEPLOY", "Konfiguration", "can could would should host",
  "​zero width deploy", "line separator server", "dash—em–en database", "hyphen-ated k8s",
  "  leading and trailing  ", "über Über ÜBER", "Ich möchte über die API sprechen", "x".repeat(300),
];
const results = [
  null,
  [],
  [{ score: 0.1, entry: { summary: "Docker Kubernetes rollout notes", text: "The production cluster uses Kubernetes" } }],
  [{ score: 0.01, entry: { summary: "Docker Kubernetes rollout notes", text: "ignored below the context floor" } }],
  [{ entry: { summary: "no score", text: "never added" } }],
  [{ score: 0.05, entry: { text: "Über Größe straße die der Müller Müller MÜLLER äußerst" } }],
  [{ score: 0.2, entry: { summary: "", text: "" } }],
  [{ score: 0.3 }],
  [{ score: 0.07, entry: { summary: "🚀🚀 Rakete café naïve", text: "ab abc abcd ABCD abcde" } }],
];

const cases = inputs.map((input) => ({
  input,
  removeStopwords: refiner.removeStopwords(input),
  expandQuery: refiner.expandQuery(input),
  refineQuery: results.map((list) => ({ results: list, output: refiner.refineQuery(input, list) })),
}));
const output = {
  source: { commit: COMMIT, path: PATH, sha256: SHA256 },
  node: { version: process.version, unicode: process.versions.unicode, icu: process.versions.icu },
  tables: { stopwords: [...refiner.__stopwords], synonyms: Object.entries(refiner.__synonyms) },
  cases,
};
writeFileSync(argument("--out"), `${JSON.stringify(output, null, 2)}\n`);
