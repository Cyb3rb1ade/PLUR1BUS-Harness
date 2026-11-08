// RE-05/T4 merge-safety recordings from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file> [--write-data]
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git || process.version !== "v24.21.0") throw new Error("pinned source, read-only git and Node 24.21.0 required");
const verified = new Map();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function verify(relative) {
  if (verified.has(relative)) return;
  const source = readFileSync(path.join(root, relative));
  const expected = execFileSync("git", ["-C", git, "show", `${PIN}:${relative}`], { maxBuffer: 16 * 1024 * 1024 });
  if (!source.equals(expected)) throw new Error(`pinned merge-safety source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/memory-merge-safety.js");
const api=await import(pathToFileURL(path.join(root,"lib/memory-merge-safety.js")));
const assert=(await import("node:assert/strict")).default;
const source=readFileSync(path.join(root,"lib/memory-merge-safety.js"),"utf8");
const vocabulary={};
for(const name of ["TECH_TERMS","DATABASE_TERMS","NEGATION_MARKERS","TEMPORAL_MARKERS","STOP_WORDS","ENTITY_IGNORE"]){
 const value=source.match(new RegExp(`const ${name} = new Set\\(([\\s\\S]*?)\\);`))?.[1];
 if(!value)throw new Error(`missing ${name}`);
 vocabulary[name]=JSON.parse(value.replace(/\/\/[^\n]*/g,"").replace(/,\s*]/g,"]"));
}
const pairs=[
 ["Erik überweist Eva 50€","Eva überweist Erik 50€"],["Eva liebt Erik","Erik liebt Eva"],
 ["Projekt Alpha nutzt Auth-Service","Projekt Alpha nutzt den Auth-Service"],
 ["Projekt Alpha nutzt Node 20.","Projekt Alpha nutzt Node.js 20."],
 ["Projekt Alpha nutzt den Auth-Service.","Projekt Beta nutzt den Auth-Service."],
 ["User mag React.","User mag Vue."],["Wir nutzen Postgres.","Wir nutzen MySQL."],
 ["Deployment läuft auf Node 20.","Deployment läuft auf Node 22."],
 ["Dreamdale ist ein Festival.","Dreamdale ist eine fiktive Stadt."],
 ["User prefers concise answers.","The user prefers concise answers."],
 ["User mag React.","User mag React nicht mehr."],["Wir nutzen Postgres.","Früher nutzten wir Postgres."],
 ["Projekt Alpha nutzt den Auth-Service intern.","Projekt Alpha nutzt den Auth-Service extern."],
 ["Original fact about cats","Additional cat fact"],["Wir nutzen Postgres.","Wir nutzen PostgreSQL."],
 ["Constructor guides Alpha","Beta guides Alpha"],["Constructor guides Alpha","constructor guides Alpha"],
 ["Node 2.4.1", "Node 24.1"],["Node ٢٤", "Node 24"],["Ömer nutzt Grün", "Ömer nutzt Grün"],
 ["Auth-Service ist bereit", "Auth Service ist bereit"],["loss bus address cats", "loss bus address cat"],
 ["a b c d e f g h i j", "a b c d e f g h i k"],["one two three four five six seven eight nine ten","one two three four five six seven eight nine"],
 ["",""],["x\ud83d","x�"],["New 𞛐abc １２", "New 𞛐abc 12"],
];
const texts=[...new Set(pairs.flat())," Hello, World! ","Node\ufeff20\u0085tail","A   B  C","Alice Bob Carol","NASA and ÄÖÜ Ömer","foo_bar foo-bar foo.bar","007 0.2 -4 1e3","constructor","__proto__"];
function projection(value){return Object.fromEntries(Object.entries(value).map(([key,value])=>[key,value instanceof Set?[...value]:value]));}
function run(){
 const terms=texts.map(input=>({input,normalizedLine:JSON.stringify(api.normalizeMemoryText(input)),line:JSON.stringify(projection(api.extractSalientTerms(input)))}));
 const comparisons=pairs.flatMap(([a,b])=>[[a,b],[b,a],[a,a]]).map(([a,b])=>({a,b,differencesLine:JSON.stringify(api.extractStructuredDifferences(a,b)),meaningful:api.hasMeaningfulDifference(a,b),duplicate:api.isSafeDuplicate(a,b)}));
 const merges=pairs.flatMap(([a,b])=>[a,b,`${a} ${b}`,"","Unrelated fact",`${a} not now`].map(merged=>({a,b,merged,preserves:api.validateMergedTextPreservesFacts(a,b,merged)})));
 return {terms,comparisons,merges};
}
const result=run();assert.deepEqual(run(),result);
const here=path.dirname(fileURLToPath(import.meta.url));
const provenance={commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)};
const dataBytes=JSON.stringify({provenance,vocabulary},null,2)+"\n";
writeFileSync(path.join(here,"golden/merge-safety.json"),JSON.stringify({provenance,vocabularySha256:digest(dataBytes),...result},null,2)+"\n");
if(process.argv.includes("--write-data"))writeFileSync(path.resolve(here,"../../../src/capture/merge-safety-data.json"),dataBytes);
console.log(`Recorded ${result.terms.length} terms, ${result.comparisons.length} comparisons and ${result.merges.length} merge cases twice`);
