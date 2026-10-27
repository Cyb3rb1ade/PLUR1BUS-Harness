/**
 * Record the pinned engine's input constants and validation results.
 * From the repository root after pnpm test:prep, using Node 24.21:
 *   node crates/plur1bus-engine/tests/fixtures/input-limits/record.mjs
 * Fixtures are generated directly and must never be edited by hand.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const crateRoot = resolve(fixtureDir, "../../..");
const root = resolve(crateRoot, "../..");
const require = createRequire(join(root, "packages/core/package.json"));
const engineRoot = dirname(require.resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
const source = await import(pathToFileURL(join(engineRoot, "lib/input-limits.js")).href);
const cases = [];
function add(name, input, options = {}, operation = "validateInput") {
  const runtimeOptions = { ...options };
  if (runtimeOptions.allowedPattern) runtimeOptions.allowedPattern = new RegExp(runtimeOptions.allowedPattern);
  const expected = source[operation](input, runtimeOptions);
  cases.push({ name, operation, input, options, expected });
}
add("optional null", null);
add("optional empty", "");
add("required null", null, { required: true, name: "label" });
add("required empty", "", { required: true });
add("required whitespace is present", " ", { required: true });
add("zero maximum does not cap", "unbounded", { maxLength: 0 });
add("maximum includes equality", "abc", { maxLength: 3 });
add("maximum rejects excess", "abcd", { maxLength: 3, name: "label" });
add("emoji uses two UTF16 units", "😀", { maxLength: 1, name: "emoji" });
add("emoji at exact UTF16 limit", "😀", { maxLength: 2 });
add("emoji and combining mark", "😀e\u0301", { maxLength: 3 });
add("valid pattern", "agent-42", { allowedPattern: "^[a-z0-9-]+$" });
add("invalid pattern", "agent/42", { allowedPattern: "^[a-z0-9-]+$", name: "agent" });
add("pattern checks empty", "", { allowedPattern: "^.+$" });
add("optional null skips pattern", null, { allowedPattern: "^.+$" });
add("length error precedes pattern error", "!!!!", { maxLength: 2, allowedPattern: "^[a-z]+$" });
const wrappers = {
  validateCommandArgs: "COMMAND_ARGS",
  validateSemanticCommandArgs: "SEMANTIC_COMMAND_ARGS",
  validateCallbackData: "CALLBACK_DATA",
  validateCorrectionText: "CORRECTION_TEXT",
  validateSearchQuery: "SEARCH_QUERY",
  validateTopicQuery: "TOPIC_QUERY",
  validateMemoryText: "MEMORY_TEXT",
  validateAgentId: "AGENT_ID",
  validateChatId: "CHAT_ID",
  validateUserId: "USER_ID",
};
for (const [operation, constant] of Object.entries(wrappers)) {
  const limit = source.INPUT_LIMITS[constant];
  add(`${operation} accepts its limit`, "x".repeat(limit), {}, operation);
  add(`${operation} rejects its limit plus one`, "x".repeat(limit + 1), {}, operation);
  add(`${operation} accepts null`, null, {}, operation);
}
await mkdir(fixtureDir, { recursive: true });
await mkdir(join(crateRoot, "schema"), { recursive: true });
await writeFile(join(crateRoot, "schema/input-limits.json"), `${JSON.stringify(source.INPUT_LIMITS, null, 2)}\n`);
await writeFile(join(fixtureDir, "vectors.json"), `${JSON.stringify(cases, null, 2)}\n`);
console.log(`Recorded ${Object.keys(source.INPUT_LIMITS).length} constants and ${cases.length} input vectors.`);
