import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const repo = process.env.PLUR1BUS_ENGINE_GIT;
assert(repo && process.version === "v24.21.0");
const ref = "v7.18.31";
const file = "lib/jobs/skill-miner.js";
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const pin = git("rev-parse", ref + "^{commit}").trim();
const source = git("show", pin + ":" + file);
const sha = text => createHash("sha256").update(text).digest("hex");
const start = source.indexOf("export function clusterFingerprint(");
const end = source.indexOf("function readClusterMemo(", start);
const constants = source.split("\n").filter(line => /^const SKILL_DECISION_CACHE_(VERSION|TTL_MS) =/.test(line)).join("\n");
assert(start >= 0 && end > start && constants.split("\n").length === 2);
const { clusterFingerprint, reusableClusterDecision } = await import("data:text/javascript," + encodeURIComponent(
  'import { createHash } from "node:crypto";\nconst SKILL_EXTRACTION_PROMPT_VERSION = "3";\n'
    + constants + "\n" + source.slice(start, end) + "\nexport { reusableClusterDecision };",
));
const memories = [
  { id: "ä", text: "Workflow", epistemicStatus: "confirmed", category: "work", sourceMessageRole: "user", retrievalCount: 3 },
  { id: "A", text: "🗃️ Backup", epistemicStatus: "observed", category: "other", sourceMessageRole: "assistant", contradictory: true },
  { id: "A", text: "📚 Draft\nnotes", retrievalCount: 2 },
];
const policy = { model: "fixture", kind: "host", baseUrl: "", minConfidence: 0.6, minEvidenceScore: 3, catalogue: "digest" };
function record() {
  const fingerprint = clusterFingerprint({ memories }, policy);
  assert.equal(clusterFingerprint({ memories: [...memories].reverse() }, policy), fingerprint);
  const time = 1_768_305_600_000;
  const entry = { reason: "low_confidence", at: time, version: 2 };
  const expiry = 7 * 86_400_000;
  const lookups = [
    [entry, time - 1],
    [entry, time],
    [entry, time + expiry - 1],
    [entry, time + expiry],
    [{ ...entry, version: 1 }, time],
    [{ ...entry, reason: "llm_error" }, time],
    [{ ...entry, reason: "blocked_name" }, time],
    [{ ...entry, reason: "duplicate" }, time],
  ].map(([entry, now]) => ({ entry, now, reusable: reusableClusterDecision(entry, now) }));
  return JSON.stringify({
    pin, file, sourceSha256: sha(source), memories, policy, fingerprint,
    newTemplateFingerprint: clusterFingerprint({ memories }, { ...policy, promptVersion: "4" }), lookups,
  }, null, 2) + "\n";
}
const output = record();
assert.equal(record(), output);
writeFileSync(new URL("./skill-decisions.json", import.meta.url), output);
console.log(`Recorded two runs from ${pin}. SHA-256 ${sha(output)}`);
