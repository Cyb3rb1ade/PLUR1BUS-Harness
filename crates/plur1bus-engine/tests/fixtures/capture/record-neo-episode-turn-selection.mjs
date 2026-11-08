// RE-05/T5 neo-episode-turn-selection recordings from verified pinned Node sources.
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
  if (!source.equals(expected)) throw new Error(`pinned neo-episode-turn-selection source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/neo-arch.js");
const { turnEventsFromMessages } = await import(pathToFileURL(path.join(root, "lib/neo-arch.js")));
const assert = (await import("node:assert/strict")).default;
const callsite = execFileSync("git", ["-C", git, "show",
  "b5f8e285a16f1e9e7ae0e44313538d8c353d7eaa:engine/capture/capture-turn.js"], { maxBuffer: 16 * 1024 * 1024 });
assert.match(callsite.toString(), /newMessages = event\.messages\.slice\(lastCount\)/);
assert.match(callsite.toString(), /normalizedTurns = turnEventsFromMessages\(newMessages,/);
const options = { workspaceKey: "workspace:v1:fixture", agentId: "alpha", sessionKey: "stable-session",
  sessionId: "stable-session", createdAt: "2026-11-08T12:00:00.000Z", startTurnIndex: 0 };
const message = (role, content) => ({ role, content });
const conversations = [
  [message("user", "repeated fact"), message("assistant", "reply"), message("user", "repeated fact")],
  [message("assistant", "same plan"), message("user", "yes"), message("assistant", "same plan"), message("user", "yes")],
  [message("system", "hidden"), message("user", "x"), message("user", "valid fact"), message("tool", "tool without metadata"),
    message("assistant", "reply"), message("user", "<relevant-memories>hidden</relevant-memories>"), message("user", "valid fact")],
  [message("user", "  repeated\t fact "), message("assistant", "reply"), message("user", "repeated fact")],
  [],
];
function run() {
  const cases = [];
  for (const [i, messages] of conversations.entries()) {
    for (let baseline = 0; baseline <= messages.length + 1; baseline++) {
      const start = baseline > messages.length ? 0 : baseline;
      const full = turnEventsFromMessages(messages, options);
      const prefix = turnEventsFromMessages(messages.slice(0, start), options);
      const legacyDelta = turnEventsFromMessages(messages.slice(start), options);
      const selectedJournal = full.slice(prefix.length);
      cases.push({ name: `conversation-${i}-baseline-${baseline}`, messages, options, baseline,
        full, legacyDelta, selectedJournal });
    }
  }
  return cases;
}
const recorded = run();
assert.deepEqual(run(), recorded);
const here = path.dirname(fileURLToPath(import.meta.url));
writeFileSync(path.join(here, "golden/neo-episode-turn-selection.json"), JSON.stringify({
  provenance: { commit: PIN, node: process.version, sourceHashes: Object.fromEntries(verified),
    legacyCallsiteSha256: digest(callsite), legacyCallsite: "engine/capture/capture-turn.js:907-915 at S2 b5f8e285a16f1e9e7ae0e44313538d8c353d7eaa" }, cases: recorded,
}, null, 2) + "\n");
console.log(`Recorded ${recorded.length} actual Node full/prefix/delta selections twice`);
