// RE-05/T5 neo-episode-state recordings from verified pinned Node sources.
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
  if (!source.equals(expected)) throw new Error(`pinned neo-episode-state source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/episodes.js");
const crypto = (await import("node:crypto")).default;
let serial = 0;
let allocated = [];
crypto.randomUUID = () => {
  const id = `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;
  allocated.push(id);
  return id;
};
(await import("node:module")).syncBuiltinESMExports();
const now = "2026-11-08T12:00:00.000Z";
const OriginalDate = Date;
globalThis.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return OriginalDate.parse(now); }
};
const { extractEpisodesWithState } = await import(pathToFileURL(path.join(root, "lib/episodes.js")));
const assert = (await import("node:assert/strict")).default;
const turn = (i, minutes = i, content = "Architecture project fact") => ({
  id: `turn-${i}`, role: i % 2 ? "assistant" : "user", content,
  workspaceKey: "workspace:v1:fixture", agentId: "alpha",
  createdAt: new Date(Date.now() + minutes * 60000).toISOString(),
});
const base = { workspaceKey: "workspace:v1:fixture", agentId: "alpha", sessionKey: "agent:alpha:direct:fixture",
  participantNames: { user: "Nutzer", assistant: "alpha" } };
async function run() {
  serial = 0;
  const cases = [];
  async function record(name, turns, options = {}) {
    allocated = [];
    options = { ...base, ...options };
    const output = await extractEpisodesWithState(turns, options);
    cases.push({ name, turns, options, now, allocatedIds: [...allocated], output });
    return output;
  }
  await record("empty", []);
  const first = await record("first-three", [turn(0), turn(1), turn(2)]);
  const open = { ...first.openEpisode, vaultPath: "fixture/episode.md" };
  await record("empty-keeps-open", [], { openEpisode: open });
  await record("continue-five", [turn(3), turn(4)], { openEpisode: open, episodedTurnIds: ["turn-0", "turn-1", "turn-2"] });
  await record("overlap-keeps-novel", [turn(1), turn(2), turn(3)], { openEpisode: open });
  await record("all-known", [turn(0), turn(1), turn(2)], { openEpisode: open, episodedTurnIds: ["turn-0", "turn-1", "turn-2"] });
  await record("all-known-without-open", [turn(0), turn(1)], { episodedTurnIds: ["turn-0", "turn-1"] });
  for (const gap of [0, 30, 30.001, -1, -100]) {
    await record(`gap-${gap}`, [turn(3, 2 + gap)], { openEpisode: open });
  }
  for (const cap of [1, 2, 3, 4, 50]) {
    await record(`cap-${cap}`, [turn(3), turn(4)], { openEpisode: open, maxEpisodeTurns: cap });
  }
  await record("known-last-preserves-old-open", [turn(3, 3), turn(0, 100)], {
    openEpisode: open, episodedTurnIds: ["turn-0"], maxGapMinutes: 30,
  });
  await record("known-last-without-open", [turn(3, 3), turn(0, 100)], { episodedTurnIds: ["turn-0"] });
  await record("snapshot-utf16", [turn(3, 3, "x".repeat(599) + "🚀"), turn(4, 4, "opaque \ud800")], { openEpisode: open });
  for (const revision of [0, 3, "2.5", "invalid", -1]) {
    await record(`revision-${revision}`, [turn(3)], { openEpisode: { ...open, revision } });
  }
  for (const openEpisode of [null, {}, { turns: [] }]) {
    await record(`missing-open-${cases.length}`, [turn(3)], { openEpisode });
  }
  const almostFull = { ...open, turns: Array.from({ length: 49 }, (_, i) => turn(i, i / 10)), endTime: turn(48, 4.8).createdAt };
  await record("fifty-turn-cap-continues-then-opens-new", [turn(49, 4.9), turn(50, 5)], { openEpisode: almostFull });
  return cases;
}
const recorded = await run();
assert.deepEqual(await run(), recorded);
const here = path.dirname(fileURLToPath(import.meta.url));
writeFileSync(path.join(here, "golden/neo-episode-state.json"), JSON.stringify({
  provenance: { commit: PIN, node: process.version, sourceHashes: Object.fromEntries(verified), clock: now,
    uuidProvider: "sequential deterministic Node builtin fixture", llm: "absent" }, cases: recorded,
}, null, 2) + "\n");
console.log(`Recorded ${recorded.length} actual Node open-episode transitions twice`);
