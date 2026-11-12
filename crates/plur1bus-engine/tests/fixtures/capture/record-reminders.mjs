// RE-05/T3 emotion recordings and production vocabulary extraction from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file> [--write-data]
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  if (!source.equals(expected)) throw new Error(`pinned emotion source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/reminder-parser.js");verify("lib/reminder-extraction.js");
const parser=await import(pathToFileURL(path.join(root,"lib/reminder-parser.js")));
const api=await import(pathToFileURL(path.join(root,"lib/reminder-extraction.js")));
const assert=(await import("node:assert/strict")).default;
const NOW=1710000000000;
const texts=[
 ...["minuten","minute","min","stunden","stunde","std","h","tagen","tage","tag","d","minutes","hours","hour","days","day"].map(unit=>`Bitte Testbericht in 2 ${unit} prüfen.`),
 "Bitte Testbericht in einer halben Stunde prüfen.","Bitte Testbericht in halben Stunde prüfen.","Review the fixture in half an hour.",
 "Bitte Testbericht in einer Stunde prüfen.","Bitte Testbericht in eine Minute prüfen.","Bitte Testbericht in einem Tag prüfen.",
 "Bitte Testbericht in 0 Minuten prüfen.","In 10 Minuten.","in 10 minuten","In 10 Minutes 1 23 a.",
 "Review in 2 widgets and in 10 minutes.","Review in 1 constructor.","Review in 1 __proto__.",
 "Baldrian hilft später. Morgen um 9 Uhr.","in -2 Minuten Bericht prüfen","in 1.5 hours review fixture", "in 2h review fixture",
 "Vorher erledigt! Bitte Testbericht in 2 Minuten prüfen. Danach abschließen.",
 "<reminder-nudge>Bericht in 1 Minute prüfen.</reminder-nudge>",
 "<REMINDER-NUDGE>Bericht in 1 Minute prüfen.</REMINDER-NUDGE> Review fixture in 2 hours.",
 "İstanbul. Bitte Testbericht in 2 Minuten prüfen.",
 "x".repeat(180)+" in 2 minutes "+"y".repeat(100),
 "x".repeat(198)+"😀 in 2 minutes prüfen.",
 "x".repeat(198)+"\ud83d in 2 minutes prüfen.",
 "Review in "+"9".repeat(400)+" minutes.",
];
function run(){return {intents:texts.map(text=>({text,line:JSON.stringify(parser.parseReminderIntent(text,{now:NOW}))})),
 plans:texts.flatMap(text=>[{role:"user",enabled:true},{role:"assistant",enabled:true},{role:"user",enabled:false}].map(({role,enabled})=>({text,role,enabled,line:JSON.stringify(api.planReminderExtraction({text,role},{enabled,now:NOW}))}))),
 texts:texts.flatMap(text=>["in 2 minutes","in 2 Minuten","missing phrase", ""].map(evidence=>({text,evidence,line:JSON.stringify(api.buildReminderText(text,evidence)),topic:api.hasReminderTopic(api.buildReminderText(text,evidence),evidence)}))),
 stripped:texts.map(text=>({text,line:JSON.stringify(api.stripReminderNudge(text))}))};}
const result=run();assert.deepEqual(run(),result);
const here=path.dirname(fileURLToPath(import.meta.url));
writeFileSync(path.join(here,"golden/reminder-extraction.json"),JSON.stringify({provenance:{commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)},...result},null,2)+"\n");
console.log(`Recorded ${result.intents.length} intents, ${result.plans.length} plans, ${result.texts.length} text/topic and ${result.stripped.length} nudge cases twice`);
