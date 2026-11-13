import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const repo = process.env.PLUR1BUS_ENGINE_GIT;
assert(repo && process.version === "v24.21.0" && process.env.TZ === "UTC");
const pin = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const path = "lib/episodes.js";
const source = execFileSync("git", ["-C", repo, "show", `${pin}:${path}`], { encoding: "utf8" });
const { rebuildEpisode } = await import("data:text/javascript," + encodeURIComponent(
  source.replace(/import \{\s*LLM_RESULT_CACHE_PURPOSES,[\s\S]+?from "\.\/llm-result-cache\.js";/u, "")
    .replace('import { throwIfAborted } from "./abort.js";', "const throwIfAborted = signal => signal?.throwIfAborted();"),
));
const now = 1_768_305_600_000;
const timestamp = time => new Date(time).toISOString();
const turns = [
  { id: "assistant-answer", role: "assistant", content: "Release notes are ready.", createdAt: timestamp(now - 10_000) },
  { id: "user-question", role: "user", content: "Can we write the release notes?", createdAt: timestamp(now - 70_000) },
];
const old = {
  id: "episode-fixture", revision: 2, agentId: "alpha", workspaceKey: "fixture-workspace",
  startTime: turns[1].createdAt, endTime: turns[0].createdAt, createdAt: turns[0].createdAt,
  memoryIds: ["user-question", "assistant-answer"], location: "dm", importance: 0.8,
  replayCount: 3, lastReplayed: timestamp(now - 1000),
};
const participantNames = { user: "Nutzer", assistant: "alpha" };
const sha = value => createHash("sha256").update(value).digest("hex");
const realNow = Date.now;
try {
  Date.now = () => now;
  const record = async () => {
    const row = await rebuildEpisode(old, turns, { participantNames });
    const fields = ["id", "createdAt", "revision", "rebuilt", "startTime", "endTime", "durationMinutes", "title", "summary",
      "participants", "memoryIds", "location", "importance", "replayCount", "lastReplayed", "turnCount", "vividness"];
    const expected = Object.fromEntries(fields.map(key => [key, row[key]]));
    return JSON.stringify({ pin, path, sourceSha256: sha(source), now, old, turns, expected }, null, 2) + "\n";
  };
  const output = await record();
  assert.equal(await record(), output);
  writeFileSync(new URL("./episode-rebuild.json", import.meta.url), output);
  console.log(`Recorded two episode rebuilds from ${pin}. SHA-256 ${sha(output)}`);
} finally {
  Date.now = realNow;
}
