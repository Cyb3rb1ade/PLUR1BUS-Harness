import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.env.PLUR1BUS_ENGINE_GIT;
assert(repo && process.version === "v24.21.0");
const pin = "a5aed1168b4a4f5fc2c7226a00ed4c198f0b2658";
const file = "lib/jobs/schicht15-tracker.js";
const source = execFileSync("git", ["-C", repo, "show", `${pin}:${file}`], { encoding: "utf8" });
const sha = text => createHash("sha256").update(text).digest("hex");
const imported = 'import { atomicJsonUpdate } from "../atomic-json.js";';
assert(source.includes(imported));
const body = source.replace(imported, "").replace('import { describeErrorForLog } from "../safe-logging.js";', "const describeErrorForLog = String;");
const { checkMaxPromotions, PROMOTION_WINDOW_MS } = await import("data:text/javascript," + encodeURIComponent(body));
const now = 1_768_305_600_000;
const state = {
  promotedKnowledge: {
    "schicht15:workspace:alpha": { promotedAt: { recent: now - 1, expired: now - PROMOTION_WINDOW_MS, future: now + 1 } },
    "schicht15:workspace:beta": { promotedAt: { recent: now, old: now - PROMOTION_WINDOW_MS - 1 } },
    "schicht15:workspace:legacy": { ids: ["before-timestamps"] },
  },
};

function record() {
  const workspace = mkdtempSync(join(tmpdir(), "promotion-cap-reference-"));
  try {
    writeFileSync(join(workspace, "run-state.json"), JSON.stringify(state));
    const cases = [
      { agent: "alpha", now, limit: 2 },
      { agent: "gamma", now, limit: 3 },
      { agent: "alpha", now: now + PROMOTION_WINDOW_MS + 1, limit: 2 },
    ].map(input => ({
      ...input,
      expected: checkMaxPromotions(workspace, "workspace", input.agent, input.limit, { now: input.now }),
    }));
    return JSON.stringify({ pin, file, sourceSha256: sha(source), state, cases }, null, 2) + "\n";
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

const output = record();
assert.equal(record(), output);
writeFileSync(new URL("./promotion-budget.json", import.meta.url), output);
console.log(`Recorded two C6 promotion budget runs from ${pin}. SHA-256 ${sha(output)}`);
