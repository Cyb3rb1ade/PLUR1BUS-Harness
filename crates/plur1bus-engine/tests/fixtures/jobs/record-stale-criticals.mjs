import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const repo = process.env.PLUR1BUS_ENGINE_GIT;
assert(repo && process.version === "v24.21.0");
const pin = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const file = "lib/jobs/auto-accept-stale-criticals.js";
const source = execFileSync("git", ["-C", repo, "show", `${pin}:${file}`], { encoding: "utf8" });
const sha = text => createHash("sha256").update(text).digest("hex");
const now = 1_768_305_600_000;
// Logging does not participate in the delta; the fake DB records only the pinned adapter call.
const body = source.replace('import { describeError } from "../log-redact.js";', "const describeError = String;");
const { expireStaleCriticals } = await import("data:text/javascript," + encodeURIComponent(body));
const candidates = [
  { id: "00000000-0000-0000-0000-000000000001", type: "person", confirmed: false, createdAt: now - 86_400_000 },
  { id: "00000000-0000-0000-0000-000000000002", type: "person", confirmed: false, createdAt: now - 86_399_999 },
  { id: "00000000-0000-0000-0000-000000000003", type: "person", confirmed: true, createdAt: now - 90_000_000 },
  { id: "00000000-0000-0000-0000-000000000004", type: "note", confirmed: false, createdAt: now - 90_000_000 },
  { id: "00000000-0000-0000-0000-000000000005", type: "gesundheit", confirmed: false, createdAt: now - 90_000_000 },
];
async function record() {
  const rows = structuredClone(candidates);
  const writes = [];
  const db = {
    findUnconfirmedCritical(agent, { olderThan }) {
      assert.equal(agent, "alpha");
      return rows.filter(row => ["person", "gesundheit"].includes(row.type) && !row.confirmed && row.createdAt <= olderThan);
    },
    markCriticalRejected(agent, id) {
      assert.equal(agent, "alpha");
      const row = rows.find(row => row.id === id);
      row.type = "note";
      row.confirmed = true;
      writes.push(id);
      return { ok: true };
    },
  };
  const result = await expireStaleCriticals(db, "alpha", { hours: 24 });
  return JSON.stringify({ pin, file, sourceSha256: sha(source), now, candidates, rows, writes, result }, null, 2) + "\n";
}
const originalClock = Date.now;
try {
  Date.now = () => now;
  const output = await record();
  assert.equal(await record(), output);
  writeFileSync(new URL("./stale-criticals.json", import.meta.url), output);
  console.log(`Recorded two runs of ${file}. SHA-256 ${sha(output)}`);
} finally {
  Date.now = originalClock;
}
