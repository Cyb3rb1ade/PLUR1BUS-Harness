// RE-05/T5 neo-candidate-index recordings from verified pinned Node sources.
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
  if (!source.equals(expected)) throw new Error(`pinned neo-candidate-index source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/neo-arch.js");
const { candidateIndexEntry } = await import(pathToFileURL(path.join(root, "lib/neo-arch.js")));
const assert = (await import("node:assert/strict")).default;
const ownerA = `user:v2:${digest("fixture-owner-a")}`;
const ownerB = `user:v2:${digest("fixture-owner-b")}`;
const base = {
  id: "candidate", workspaceKey: "workspace:v1:one", agentId: "alpha", statement: "source fact",
  category: "project_fact", status: "active", confidence: 0.75, salience: 0.55, recency: 1,
  createdAt: "2026-11-08T12:00:00.000Z", ownerUserId: ownerA,
  visibility: { scope: "agent_private" },
  origin: { kind: "user_explicit", role: "user", trustLevel: "user_asserted", scope: "agent_private" },
};
const inputs = [
  ["ordinary", base],
  ["all-node-fields", { ...base, stale: false, hardDeleted: false, updatedAt: "later", startTime: 1,
    epistemicStatus: "verified", ownerId: ownerA, sourceTurnIds: ["source"], embeddingDims: 3,
    emotionalDominant: "joy", embedding: [1, 2, 3], unknown: "not indexed" }],
  ["missing-statement", { id: "missing", content: "content fallback" }],
  ["text-fallback", { id: "text", text: "text fallback" }],
  ["numeric-statement", { id: 42, statement: 12 }],
  ["null-statement", { id: "null", statement: null, content: "fallback" }],
  ["empty-statement", { id: "empty", statement: "", content: "not used" }],
  ["array-statement", { id: "array", statement: ["a", null, "b"] }],
  ["object-statement", { id: "object", statement: { fact: true } }],
  ["opaque", { ...base, id: "opaque-\ud800", statement: "units-\udc00" }],
  ["no-id", { statement: "missing id" }], ["empty-id", { id: "" }],
  ["zero-id", { id: 0 }], ["parse-error", { ...base, __parseError: "fixture" }],
  ["null", null], ["array", []],
  ["origin-owner-conflict", { ...base, origin: { ...base.origin, ownerUserId: ownerB } }],
  ["origin-agent-conflict", { ...base, origin: { ...base.origin, agentId: "beta" } }],
  ["origin-workspace-conflict", { ...base, origin: { ...base.origin, workspaceIdentity: "workspace:v1:other" } }],
  ["origin-workspace-key-conflict", { ...base, origin: { ...base.origin, workspaceKey: "workspace:v1:other" } }],
  ["origin-workspace-id-conflict", { ...base, origin: { ...base.origin, workspaceId: "workspace:v1:other" } }],
  ["root-scope-conflict", { ...base, scope: "global_user" }],
  ["root-workspace-conflict", { ...base, workspaceIdentity: "workspace:v1:other" }],
  ["root-workspace-id-conflict", { ...base, workspaceId: "workspace:v1:other" }],
  ["acl-binding-conflict", { ...base, aclBindings: { ownerUserId: ownerB } }],
  ["acl-binding-malformed", { ...base, aclBindings: [] }],
  ["origin-array", { ...base, origin: [] }], ["origin-boolean", { ...base, origin: true }],
  ["consistent-extra-authority", { ...base, scope: "agent_private", workspaceIdentity: base.workspaceKey,
    aclBindings: { agentId: base.agentId, ownerUserId: ownerA }, origin: { ...base.origin, ownerUserId: ownerA } }],
  ["origin-null", { ...base, origin: null }],
];
function run() {
  return inputs.map(([name, input]) => ({ name, input, output: candidateIndexEntry(input) }));
}
const recorded = run();
assert.deepEqual(run(), recorded);
const here = path.dirname(fileURLToPath(import.meta.url));
writeFileSync(path.join(here, "golden/neo-candidate-index.json"), JSON.stringify({
  provenance: { commit: PIN, node: process.version, sourceHashes: Object.fromEntries(verified) },
  ownerA, ownerB, cases: recorded,
}, null, 2) + "\n");
console.log(`Recorded ${recorded.length} actual Node candidate-index projections twice`);
