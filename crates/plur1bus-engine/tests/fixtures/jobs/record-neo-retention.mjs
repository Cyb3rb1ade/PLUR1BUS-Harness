import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const repo = process.env.PLUR1BUS_ENGINE_GIT;
assert(repo && process.version === "v24.21.0");
const pin = "0ef3d270c0272f9ba1aec3f4677ba9ac3668b80d";
const file = "lib/neo-arch.js";
const source = execFileSync("git", ["-C", repo, "show", pin + ":" + file], { encoding: "utf8" });
const sha = text => createHash("sha256").update(text).digest("hex");
const start = source.indexOf("const NEO_RETENTION_STATUS_RANK =");
const end = source.indexOf("function appendJsonl(", start);
assert(start >= 0 && end > start);
const { selectNeoRetention } = await import("data:text/javascript," + encodeURIComponent(source.slice(start, end)));
const now = Date.parse("2026-11-09T12:00:00.000Z");
const day = 86_400_000;
const at = days => new Date(now - days * day).toISOString();
const row = (id, days, fields = {}) => ({ id, createdAt: at(days), ...fields });
function record() {
  const cases = [
    ["at-limit", 2, [row("a", 300), row("b", 400)]],
    ["weak-first", 2, [row("a", 300, { status: "candidate", salience: 0.9, confidence: 0.9 }),
      row("b", 100, { status: "candidate", salience: 0.1, confidence: 0.2 }), row("c", 5)]],
    ["exact-cutoff-is-kept", 1, [row("a", 90), row("b", 91)]],
    ["protected", 1, [row("a", 200, { status: "active", confidence: 0.6 }),
      row("b", 200, { status: "pending" }), row("c", 200, { status: "demoted" }), row("d", 200, { neverForget: true })]],
    ["revisions", 1, [row("a", 200), row("b", 150), row("a", 200, { updatedAt: at(1) })]],
    ["edges", 1, [{ source: "a", target: "b", strength: 0.9, createdAt: at(200) },
      { source: "c", target: "d", strength: 0.2, createdAt: at(200) },
      { source: "c", target: "d", strength: 0.3, createdAt: at(200), updatedAt: at(100) }]],
    ["unknown-and-seconds", 2, [{ id: "unknown" }, { id: "recent", timestamp: (now - day) / 1000 }, row("old", 200)]],
  ].map(([name, softMax, rows]) => {
    const result = selectNeoRetention(rows.map(row => JSON.stringify(row)), { softMax, hardMax: 50000, retentionMs: 90 * day, now });
    return { name, softMax, rows, result };
  });
  return JSON.stringify({ pin, file, sourceSha256: sha(source), now, cases }, null, 2) + "\n";
}
const output = record();
assert.equal(record(), output);
writeFileSync(new URL("./neo-retention.json", import.meta.url), output);
console.log(`Recorded two retention runs from ${pin}. SHA-256 ${sha(output)}`);
