import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.env.PLUR1BUS_ENGINE_GIT;
assert(repo && process.version === "v24.21.0");
const pin = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const file = "lib/garbage-collector.js";
const source = execFileSync("git", ["-C", repo, "show", pin + ":" + file], { encoding: "utf8" });
const sha = text => createHash("sha256").update(text).digest("hex");
const { selectCandidatesForGc, archiveMemories } = await import("data:text/javascript," + encodeURIComponent(
  source.replace('import { safeStatus } from "./sql-safety.js";', 'const safeStatus = value => { assertArchived(value); return value; }; function assertArchived(value) { if (value !== "archived") throw new Error("invalid archive status"); }'),
));
const now = 1_768_305_600_000;
const row = (index, memoryStrength, extra = {}) => ({
  id: "00000000-0000-0000-0000-" + String(index).padStart(12, "0"),
  memoryStrength, createdAt: now - index * 10_000, status: "active", memoryClass: "standard", neverForget: 0,
  ...extra,
});
const inputs = [
  row(1, 0.2), row(2, 0.8), row(3, 0.01, { neverForget: 1 }), row(4, 0.02, { memoryClass: "core" }),
  row(5, 0.3, { status: "superseded" }), row(6, 0.1, { status: "deleted" }), row(7, 0.1, { status: "archived" }),
];
const policy = { minMemoryStrength: 0.4, maxMemoryCount: 2 };
async function record() {
  const rows = structuredClone(inputs);
  const selected = selectCandidatesForGc(rows, policy);
  const directory = mkdtempSync(join(tmpdir(), "gc-reference-"));
  const realNow = Date.now;
  try {
    Date.now = () => now;
    const stats = await archiveMemories({
      getById: id => rows.find(row => row.id === id),
      update: (id, patch) => Object.assign(rows.find(row => row.id === id), patch),
    }, selected, directory);
    const archive = readdirSync(directory).sort().map(file => JSON.parse(readFileSync(join(directory, file), "utf8")));
    return JSON.stringify({ pin, file, sourceSha256: sha(source), now, inputs, policy, selected, rows, archive, stats }, null, 2) + "\n";
  } finally {
    Date.now = realNow;
    rmSync(directory, { recursive: true, force: true });
  }
}
const output = await record();
assert.equal(await record(), output);
writeFileSync(new URL("./gc.json", import.meta.url), output);
console.log(`Recorded two GC runs from ${pin}. SHA-256 ${sha(output)}`);
