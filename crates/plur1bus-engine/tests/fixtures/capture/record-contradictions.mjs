// Frozen Node results and exact model prompts; no live provider or credentials.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (process.version !== "v24.21.0") throw new Error("Node v24.21.0 required");
const pin = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const source = process.env.PLUR1BUS_ENGINE_SRC;
const repository = process.env.PLUR1BUS_ENGINE_GIT;
if (!source || !repository) throw new Error("Pinned source and repository required");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourcesSha256 = {};
for (const name of ["abort", "contradiction-detector", "llm-failure", "log-redact", "safe-logging", "sql-safety", "with-timeout"]) {
  const file = `lib/${name}.js`;
  const bytes = readFileSync(join(source, file));
  const pinned = execFileSync("git", ["-C", repository, "show", `${pin}:${file}`]);
  if (hash(bytes) !== hash(pinned)) throw new Error(`Source mismatch: ${file}`);
  sourcesSha256[file] = hash(bytes);
}
const { ContradictionDetector } = await import(pathToFileURL(join(source, "lib/contradiction-detector.js")));
const now = 1735689600000;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};
const overlay = (id, targetMemoryId, shiftDescription, shiftType = "meaning") => ({ id, targetMemoryId, shiftDescription, shiftType });
const a = overlay("a", "memory", "Die Tür ist offen. 🪟");
const b = overlay("b", "memory", "Die Tür ist geschlossen.");
const c = overlay("c", "other", "Unrelated interpretation");
const d = overlay("d", "memory", "Another interpretation");
const cases = [];
async function record(name, method, input, { response = "yes", maxPairs, constructorMaxPairs = 20, port = "present" } = {}) {
  const calls = [];
  const detector = new ContradictionDetector({
    maxPairs: constructorMaxPairs,
    logger: { warn() {}, debug() {} },
    llm: port === "absent" ? undefined : async (messages) => {
      calls.push({ messages, sha256: hash(JSON.stringify(messages)) });
      if (port === "reject") throw new Error("synthetic failure");
      return response;
    },
  });
  const opts = maxPairs === undefined ? {} : { maxPairs };
  let result;
  if (method === "pair") result = await detector.detectContradiction(input[0], input[1], opts);
  if (method === "overlays") result = await detector.findContradictions(input, opts);
  if (method === "new") result = await detector.findContradictionsForNewOverlay(input[0], input[1], opts);
  if (method === "texts") result = await detector.findMemoryTextContradictions(input, opts);
  if (Array.isArray(result)) result = result.map((row) => ({ ...row, id: "__UUID__" }));
  cases.push({ name, method, input, response, port, maxPairs, constructorMaxPairs, result, calls });
}
for (const response of ["yes", " YES\n", "yes, incompatible", "yesterday", "no", "not yes", "```yes```", "ja", "", "\uFEFFyes\u00A0"]) {
  await record(`answer:${JSON.stringify(response)}`, "pair", [a, b], { response });
}
for (const [name, pair] of [
  ["missing-a", [null, b]], ["different-target", [a, c]],
  ["not-meaning", [a, { ...b, shiftType: "emotion" }]],
  ["empty-description", [a, { ...b, shiftDescription: "" }]],
  ["same-id", [a, { ...b, id: a.id }]],
  ["undefined-targets", [{ id: "a", shiftType: "meaning", shiftDescription: "A" }, { id: "b", shiftType: "meaning", shiftDescription: "B" }]],
]) await record(name, "pair", pair);
for (const port of ["absent", "reject"]) {
  await record(`pair:${port}`, "pair", [a, b], { port });
  await record(`scan:${port}`, "overlays", [a, b], { port });
}
const overlays = [null, c, a, { ...b, shiftType: "emotion" }, b, d];
for (const maxPairs of [0, 1, 1.5, 2, 20, -1, "1", null]) {
  await record(`overlays:${JSON.stringify(maxPairs)}`, "overlays", overlays, { maxPairs });
  await record(`new:${JSON.stringify(maxPairs)}`, "new", [a, overlays], { maxPairs });
}
await record("constructor-fallback", "overlays", [a, b, d], { constructorMaxPairs: 1, maxPairs: -1 });
await record("constructor-fraction", "overlays", [a, b, d], { constructorMaxPairs: 1.5 });
const memories = [{ id: "a", summary: "  summary A  ", text: "ignored" }, { id: "a", text: "same id" }, { id: "empty", text: "  " }, { id: "b", text: "B 🪟" }, { id: "c", text: "C" }, { id: 42, text: "wrong id type" }];
for (const maxPairs of [0, 1, 1.5, 2, 3, 6, 20, -1, "1", null]) {
  await record(`texts:${JSON.stringify(maxPairs)}`, "texts", memories, { maxPairs });
}
await record("text-constructor-not-used", "texts", memories, { constructorMaxPairs: 0 });
await record("text-no-model", "texts", memories, { port: "absent" });
globalThis.Date = RealDate;
const output = { provenance: { pin, node: process.version, sourcesSha256 }, now, cases };
writeFileSync(new URL("golden/contradictions.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Recorded ${cases.length} actual Node cases`);
