// RE-05/T4 neo-status recordings from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file> [--write-data]
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "b097045b6f115275baa8b15016321c3ba080c812";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git || process.version !== "v24.21.0") throw new Error("pinned source, read-only git and Node 24.21.0 required");
const verified = new Map();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function verify(relative) {
  if (verified.has(relative)) return;
  const source = readFileSync(path.join(root, relative));
  const expected = execFileSync("git", ["-C", git, "show", `${PIN}:${relative}`], { maxBuffer: 16 * 1024 * 1024 });
  if (!source.equals(expected)) throw new Error(`pinned neo-status source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/neo-arch.js");
const { transitionRecordStatus, NEO_STATUSES } = await import(pathToFileURL(path.join(root, "lib/neo-arch.js")));
const assert = (await import("node:assert/strict")).default;
const values = [undefined, null, false, true, 0, 0.15, 0.5, 0.9, 2, -1, "0.5", "", "  ", "invalid", "Infinity", [], [0.5], [1,2], {}];
const now = "2026-11-08T12:00:00.000Z";
function run() {
 const cases = [];
 for (const status of NEO_STATUSES) for (let i=0; i<values.length; i++) {
  const value = values[i];
  const record = JSON.parse(JSON.stringify({id:"fixture-record", status:"conflict", agentId:"alpha", origin:{scope:"agent_private"}, visibility:{scope:"agent_private"}, confidence:value, salience:value, embeddingStatus:i%2?"fresh":"pending", unknown:{opaque:"\ud800", kept:[1,true,null]}, updatedAt:"old"}));
  const output = transitionRecordStatus(record, status, {now});
  cases.push({name:`${status}-${i}`, status, record, now, output});
 }
 return JSON.parse(JSON.stringify(cases));
}
const cases=run();assert.deepEqual(run(),cases);
const here=path.dirname(fileURLToPath(import.meta.url));
writeFileSync(path.join(here,"golden/neo-status.json"),JSON.stringify({provenance:{commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)},cases},null,2)+"\n");
console.log(`Recorded ${cases.length} actual Node status transitions twice; no scope promotion requested`);
