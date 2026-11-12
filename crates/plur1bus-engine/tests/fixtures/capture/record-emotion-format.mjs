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

verify("lib/emotion.js");
const api=await import(pathToFileURL(path.join(root,"lib/emotion.js")));
const assert=(await import("node:assert/strict")).default;
const inputs=[{}, {joy:0.125,trust:0.375,anticipation:0.625,sadness:0.875},
 {joy:0.005,trust:0.015,anticipation:0.025,sadness:0.035,disgust:0.045,anger:0.055,fear:0.065,surprise:0.075},
 {joy:0.9999999999999999,trust:1,anger:-0.1}];
const strings=["", "joy:0.125,joy:0.375,trust:0.625", "joy: 1e-1tail,trust:.5e+,anger:0x10",
 "joy:Infinity,trust:NaN,anger:1e99999,fear:-5,surprise:2", "alien:1,joy:word, trust:0.4,anger:+.25end", "joy:0.5:ignored,trust:1e-3x"];
function run(){return {serialization:inputs.map(input=>({input,output:api.serializeEmotionalValence(input)})),
 parsing:strings.map(input=>({input,line:JSON.stringify(api.deserializeEmotionalValence(input))}))};}
const cases=run();assert.deepEqual(run(),cases);
const here=path.dirname(fileURLToPath(import.meta.url));
writeFileSync(path.join(here,"golden/emotion-format.json"),JSON.stringify({provenance:{commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)},...cases},null,2)+"\n");
console.log("Recorded ten actual Node emotion serialization/parsing cases twice");
