// Replay the pinned Neo batch with synthetic host metadata and an explicit clock.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";

const pin = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const source = process.env.PLUR1BUS_ENGINE_SRC;
const repo = process.env.PLUR1BUS_ENGINE_GIT;
assert(source && repo && process.version === "v24.21.0");
delete process.env.PLUR1BUS_TOOL_RESULT_MAX_CHARS;
const hashes = {};
function verify(path) {
  if (Object.hasOwn(hashes, path)) return;
  const bytes = readFileSync(join(source, path));
  assert(bytes.equals(execFileSync("git", ["-C", repo, "show", `${pin}:${path}`])), path);
  hashes[path] = createHash("sha256").update(bytes).digest("hex");
  for (const match of bytes.toString("utf8").matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+\.[cm]?js)["']/g)) {
    verify(posix.normalize(posix.join(dirname(path), match[1])));
  }
}

const entry = "lib/neo-arch.js";
verify(entry);
const { turnEventsFromMessages } = await import(pathToFileURL(join(source, entry)));
const params = { workspaceKey: "fixture", agentId: "alpha", sessionKey: "stable-session", sessionId: "run-one", startTurnIndex: 1, createdAt: "2026-11-08T12:00:00.000Z" };
const at = Date.parse("2026-11-08T11:00:00Z");
const tool = (content, metadata) => ({ role: "tool", content, ...metadata });
const messages = [
  { role: "assistant", content: "I will check the calendar.", timestamp: at },
  tool("toolName: calendar", {}),
  tool("successful shell output", { toolName: " BaSH ", toolCallId: "bulk" }),
  tool("edit response", { toolName: "str_replace_all", toolCallId: "edit" }),
  tool("cannot read file", { toolName: "read", isError: true, toolCallId: "error", timestamp: at + 1200 }),
  tool("meeting found", { toolName: "calendar", toolCallId: "search", timestamp: at + 2000 }),
  tool("meeting found", { toolName: "calendar", toolCallId: "search", timestamp: at + 2100 }),
  tool("meeting found", { toolName: "calendar", toolCallId: "another", timestamp: at + 2200 }),
  tool("x".repeat(4999) + "🌱 tail", { toolName: "calendar", toolCallId: "long" }),
  { role: "user", content: "Thanks, add it." },
];
const record = () => ({
  pin, sourceSha256: hashes[entry], params, messages,
  output: turnEventsFromMessages(messages, params).map(turn => ({
    id: turn.id, turnIndex: turn.turnIndex, content: turn.content, origin: turn.origin,
    visibility: turn.visibility, createdAt: turn.createdAt,
  })),
});
const result = record();
assert.deepEqual(record(), result);
const serialized = JSON.stringify(result, null, 2) + "\n";
if (process.argv.includes("--write-data")) {
  writeFileSync(new URL("./golden/neo-host-metadata.json", import.meta.url), serialized);
}
console.log(`Recorded ${messages.length} messages / ${result.output.length} turns twice: ${createHash("sha256").update(serialized).digest("hex")}`);
