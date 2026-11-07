// P4-02 self-test (parity mode T): the representative flows are recorded against the TypeScript core and replayed
// against the TypeScript core, and they must pass. Later Phase 4 packages run the same transcripts against plur1bus-core.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { FLOWS } from "./flows.ts";
import { recordFlow } from "./record.ts";
import { recordedTranscripts, runTranscripts } from "./run.ts";
import { RustCoreNotBuilt, coreImplFromEnv, startTarget } from "./target.ts";
import { compareTranscripts, parseTranscript, serialiseTranscript } from "./transcript.ts";
import { tempDir } from "../../packages/core/test/helpers/temp-dir.ts";

describe("core parity self-test, ts against ts", () => {
  it("has a transcript for every flow, and nothing else", () => {
    assert.deepEqual(recordedTranscripts().map((f) => basename(f, ".ndjson")), FLOWS.map((f) => f.name).sort());
  });

  it("replays every committed transcript against the TypeScript core", async () => {
    const results = await runTranscripts(recordedTranscripts(), { impl: "ts" });
    for (const r of results) assert.equal(r.ok, true, `${basename(r.file)}:\n${r.diffs.join("\n")}`);
  });

  for (const flow of FLOWS) {
    it(`a fresh recording of ${flow.name} replays, and equals the committed transcript`, async () => {
      const dir = tempDir("p1b-parity-rec-");
      const file = join(dir, `${flow.name}.ndjson`);
      await recordFlow(flow.name, file);
      const [replayed] = await runTranscripts([file], { impl: "ts" });
      assert.equal(replayed!.ok, true, replayed!.diffs.join("\n"));
      const committed = parseTranscript(readFileSync(join(import.meta.dirname, "transcripts", `${flow.name}.ndjson`), "utf8"));
      const fresh = parseTranscript(readFileSync(file, "utf8"));
      const same = compareTranscripts(committed, fresh);
      assert.equal(same.ok, true, `the committed transcript is stale; re-record with record.ts:\n${same.diffs.join("\n")}`);
    });
  }

  it("fails with a readable diff when the core answers differently from the transcript", async () => {
    const dir = tempDir("p1b-parity-neg-");
    const lines = parseTranscript(readFileSync(join(import.meta.dirname, "transcripts", "settings-roundtrip.ndjson"), "utf8"));
    // The second media.preferences.get is recorded as {global: true}; claim it was false.
    const gets = lines.filter((l) => l.dir === "out" && (l.msg as any).result?.global === true);
    assert.ok(gets.length > 0);
    (gets[0]!.msg as any).result.global = false;
    const file = join(dir, "tampered.ndjson");
    writeFileSync(file, serialiseTranscript(lines));
    const [r] = await runTranscripts([file], { impl: "ts" });
    assert.equal(r!.ok, false);
    assert.match(r!.diffs[0]!, /^conn 0, response to #\d+ media\.preferences\.(get|set): \$\.result\.global: expected false, got true$/);
  });
});

describe("PLUR1BUS_CORE_IMPL", () => {
  it("defaults to ts, accepts ts and rust, and rejects anything else", () => {
    assert.equal(coreImplFromEnv({}), "ts");
    assert.equal(coreImplFromEnv({ PLUR1BUS_CORE_IMPL: "" }), "ts");
    assert.equal(coreImplFromEnv({ PLUR1BUS_CORE_IMPL: "ts" }), "ts");
    assert.equal(coreImplFromEnv({ PLUR1BUS_CORE_IMPL: "rust" }), "rust");
    assert.throws(() => coreImplFromEnv({ PLUR1BUS_CORE_IMPL: "node" }), /must be "ts" or "rust"/);
  });

  it("rust fails with a clear error and never falls back to ts", async () => {
    await assert.rejects(startTarget("rust"), (e: Error) => e instanceof RustCoreNotBuilt && /plur1bus-core not built \(P4-03\/P4-10\)/.test(e.message));
  });
});
