// RE-05/T5 neo-capture-journal recordings from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file>
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
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
  if (!source.equals(expected)) throw new Error(`pinned neo-capture-journal source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/neo-arch.js");
const { createNeoStore, captureNeoFromAgentEnd } = await import(pathToFileURL(path.join(root, "lib/neo-arch.js")));
const assert = (await import("node:assert/strict")).default;
const { tmpdir } = await import("node:os");
const now = "2026-11-08T12:00:00.000Z";
const OriginalDate = Date;
globalThis.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return OriginalDate.parse(now); }
};
const workspace = "workspace-dir:v1:/fixture/workspace";
const messages = [
  { role: "user", content: "Architecture decision chosen" },
  { role: "assistant", content: "I will plan the implementation" },
  { role: "user", content: "yes exactly" },
  { role: "assistant", content: "maybe we could use a queue" },
  { role: "user", content: "never leak workspace data" },
];
const files = ["turns", "candidates", "reactions", "behavior", "embeddings", "candidateIndex"];
function run() {
  const directory = mkdtempSync(path.join(tmpdir(), "neo-capture-recording-"));
  try {
    const store = createNeoStore(directory, workspace);
    const event = { sessionKey: "stable-session", runId: "run-one", messages };
    const context = { workspaceKey: workspace, agentId: "alpha" };
    const first = captureNeoFromAgentEnd(event, context, store);
    const output = Object.fromEntries(files.map((key) => [key, existsSync(store.paths[key])
      ? readFileSync(store.paths[key], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []]));
    const replay = captureNeoFromAgentEnd(event, context, store);
    const afterReplay = Object.fromEntries(files.map((key) => [key, existsSync(store.paths[key])
      ? readFileSync(store.paths[key], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []]));
    const counts = (result) => Object.fromEntries(Object.entries(result.appended).map(([key, rows]) => [key, rows.length]));
    assert.deepEqual(afterReplay, output);
    return { workspace, now, event, output, recordIndex: JSON.parse(readFileSync(store.paths.index, "utf8")), appended: counts(first), replay: counts(replay) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const recorded = run();
assert.deepEqual(run(), recorded);
const here = path.dirname(fileURLToPath(import.meta.url));
writeFileSync(path.join(here, "golden/neo-capture-journal.json"), JSON.stringify({
  provenance: { commit: PIN, node: process.version, sourceHashes: Object.fromEntries(verified) },
  cases: [recorded],
}, null, 2) + "\n");
console.log("Recorded actual Node five-turn capture journals, candidate index and replay twice");
