import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const repo = process.env.PLUR1BUS_ENGINE_GIT;
assert(repo && process.version === "v24.21.0" && process.env.TZ === "UTC");
const pin = "6419a60e79975d0b5244798c1fdbbd7997a712ce";
const path = "lib/jobs/skill-miner/llm-extractor.js";
const source = execFileSync("git", ["-C", repo, "show", `${pin}:${path}`], { encoding: "utf8" });
const sha = text => createHash("sha256").update(text).digest("hex");
const { extractSkillFromEvidence } = await import("data:text/javascript," + encodeURIComponent(
  source.replace(/import \{[\s\S]*?\} from "[^"]+";/gu, "") + `
  const LLM_RESULT_CACHE_PURPOSES = { SKILL_EXTRACTION: "skill-extraction" };
  const withLlmResultCacheContext = cfg => ({ ...cfg, resultCacheContext: {} });
  const withLlmCallContext = cfg => cfg;
  const withAbortableLlmTimeout = call => call(undefined);
  `
));
const memories = [
  { id: "older", text: "Release workflow publishes signed checksums.", createdAt: 20 },
  { id: "newer", text: "Release workflow publishes signed checksums. " + "x".repeat(1754) + "🗃️", createdAt: 30 },
];
const existingSkills = [
  { skillName: "release-checksums", skillTitle: "Signed release checksums", status: "active", description: "Publish checksums", instructions: "Sign and publish checksums." },
];
async function record() {
  let expected;
  const answer = await extractSkillFromEvidence({ memories }, {
    existingSkills, llmCfg: {}, callLlm: async (messages, cfg) => {
      expected = { messages, maxTokens: cfg.maxTokens, temperature: cfg.temperature, jsonMode: cfg.jsonMode };
      return JSON.stringify({ skip: true });
    },
  });
  assert.equal(answer.reason, "low_confidence");
  assert(expected.messages[1].content.includes("\\ud83d"));
  return JSON.stringify({ pin, path, sourceSha256: sha(source), memories, existingSkills, expected }, null, 2) + "\n";
}
const output = await record();
assert.equal(await record(), output);
writeFileSync(new URL("./skill-prompt.json", import.meta.url), output);
console.log(`Recorded two extraction prompts from ${pin}. SHA-256 ${sha(output)}`);
