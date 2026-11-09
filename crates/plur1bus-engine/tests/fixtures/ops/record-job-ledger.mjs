// Actual A1 file ledger; synthetic records and local scratch directories only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const pin = "9b935ce1f970bd92a931aa99a58c620669c8085f";
const source = process.env.PLUR1BUS_ENGINE_SRC;
const gitRoot = process.env.PLUR1BUS_ENGINE_GIT;
if (!source || !gitRoot || process.version !== "v24.21.0") {
  throw new Error("verified source, Git source and Node24.21 required");
}
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceHashes = ["package.json", "engine/jobs/job-ledger.js", "lib/sql-safety.js", "lib/log-redact.js"].map(path => {
  const bytes = readFileSync(join(source, path));
  assert.equal(sha(bytes), sha(execFileSync("git", ["-C", gitRoot, "show", `${pin}:${path}`])));
  return { path, sha256: sha(bytes) };
});
const { createJobLedger } = await import(pathToFileURL(join(source, "engine/jobs/job-ledger.js")).href);
const marker = { runId: "run-001", job: "knowledge-update", phase: null, trigger: "manual", startedAt: 42 };
const row = { ...marker, agentId: "alpha", outcome: "completed", finishedAt: 45, durationMs: 3 };
const cases = [
  { name: "missing", actions: [] },
  { name: "ordinary-append", actions: [{ append: JSON.stringify(row) }] },
  { name: "torn-tail", initial: '{"torn":', actions: [{ append: JSON.stringify(row) }] },
  { name: "complete-unterminated", initial: '{"old":true}', actions: [{ append: JSON.stringify(row) }] },
  { name: "unreadable-preserved", initial: '\n \t\r\n\ufeff\n[]\nnull\n42\n"text"\n{bad}\n{"old":true}\n',
    actions: [{ append: JSON.stringify(row) }] },
  { name: "opaque-and-numeric", initial: '{"opaque":"\\ud800","unknown":0.41733280085163044}\n',
    actions: [{ append: '{"runId":"run-002","reason":"\\udfff","v":3}' }] },
  { name: "exclusive-marker", actions: [{ marker }, { marker }] },
  { name: "filename-authoritative", markers: { "run-001.started": '{"runId":"wrong","job":"knowledge-update"}' },
    actions: [] },
  { name: "corrupt-marker", markers: { "run-001.started": '{', "ignored.txt": '{}' }, actions: [] },
  { name: "marker-array", markers: { "run-001.started": '["first",2]' }, actions: [] },
  { name: "marker-string", markers: { "run-001.started": '"🚀"' }, actions: [] },
  { name: "marker-scalar", markers: { "run-001.started": 'null' }, actions: [] },
  { name: "object-and-number-semantics", initial: '{"z":1,"z":2,"2":1,"0":2,"n":1e999}\n',
    actions: [{ append: '{"b":1,"0":3,"b":2,"n":-0,"tiny":1e-7,"big":1e21}' }] },
  { name: "remove-marker", actions: [{ marker }, { remove: "run-001" }, { remove: "run-001" }] },
  { name: "marker-then-row", actions: [{ marker }, { append: JSON.stringify(row) }, { remove: "run-001" }] },
  { name: "tail-changed-between-appends", actions: [{ append: JSON.stringify(row) }, { raw: '{"later":' },
    { append: '{"runId":"run-002","job":"gc-run"}' }] },
];
function run() {
  return cases.map(scenario => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "a1-job-ledger-")));
    const ledger = createJobLedger({ root, agentId: "alpha", logger: { warn() {} } });
    function snapshot() {
      const state = ledger.snapshot();
      return {
        rowsJson: state.rows.map(value => JSON.stringify(value)),
        unreadable: state.unreadable,
        markersJson: ledger.orphanMarkers().sort((a, b) => a.runId.localeCompare(b.runId)).map(v => JSON.stringify(v)),
        raw: existsSync(ledger.paths.ledger) ? readFileSync(ledger.paths.ledger, "utf8") : null,
      };
    }
    try {
      if (scenario.initial !== undefined) {
        mkdirSync(ledger.paths.dir, { recursive: true });
        writeFileSync(ledger.paths.ledger, scenario.initial);
      }
      if (scenario.markers) {
        mkdirSync(ledger.paths.markers, { recursive: true });
        for (const [name, value] of Object.entries(scenario.markers)) {
          writeFileSync(join(ledger.paths.markers, name), value);
        }
      }
      const before = snapshot();
      const steps = scenario.actions.map(action => {
        let error = false;
        try {
          if (action.append !== undefined) ledger.append(JSON.parse(action.append));
          if (action.marker) ledger.writeMarker(action.marker);
          if (action.remove) ledger.removeMarker(action.remove);
          if (action.raw !== undefined) writeFileSync(ledger.paths.ledger, action.raw);
        } catch { error = true; }
        return { error, state: snapshot() };
      });
      return { scenario, before, steps };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
globalThis.fetch = async () => { throw new Error("network forbidden"); };
const captured = run();
assert.deepEqual(run(), captured);
const output = JSON.stringify({ pin, node: process.version, sourceHashes,
  boundaries: { files: "actual A1 ledger and markers", input: "synthetic records", providers: "none",
    normalization: "orphan marker array sorted by runId only; scratch paths excluded" }, cases: captured }, null, 2) + "\n";
writeFileSync(new URL("golden/job-ledger.json", import.meta.url), output);
console.log(`Recorded ${captured.length} A1 job ledger cases twice; SHA-256 ${sha(output)}`);
