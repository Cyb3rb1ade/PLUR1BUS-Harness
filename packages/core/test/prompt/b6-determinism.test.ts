// B6 (ADR-010 R3, "the highest-ROI test in the repo"): the zone hashes are byte-identical across two renders and across
// two process starts. `pnpm bench` runs the same probe as a build gate (scripts/bench.mjs).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPromptBuilder } from "../../src/prompt/builder.ts";
import { canonicalJson, sha256Hex } from "../../src/prompt/canonical.ts";
import { corpusInput } from "../fixtures/prompt-corpus.ts";

const PROBE = fileURLToPath(new URL("../fixtures/prompt-b6-probe.ts", import.meta.url));
const probe = (env: Record<string, string>): string =>
  execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", PROBE], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH ?? "", ...env } });

describe("B6: zone determinism", () => {
  it("two renders in one process are byte-identical, zone by zone and segment by segment", () => {
    for (const turns of [0, 2, 3, 40]) {
      const a = createPromptBuilder().render(corpusInput(turns));
      const b = createPromptBuilder().render(corpusInput(turns));
      assert.deepEqual(a.zoneHashes, b.zoneHashes, `${turns} turns`);
      assert.deepEqual(a.prefixHashes, b.prefixHashes);
      assert.equal(canonicalJson(a.segments), canonicalJson(b.segments));
    }
  });
  it("two process starts print the same bytes, even under a different time zone, locale and hash environment", () => {
    const first = probe({ TZ: "UTC", LC_ALL: "C" });
    const second = probe({ TZ: "Pacific/Auckland", LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8" });
    assert.equal(first, second);
    const parsed = JSON.parse(first) as Record<string, Array<{ zones: unknown; segments: string }>>;
    for (const runs of Object.values(parsed)) assert.deepEqual(runs[0], runs[1], "two renders inside one process");
  });
  it("the probe's hashes equal an in-process render of the same corpus", () => {
    const parsed = JSON.parse(probe({})) as Record<string, Array<{ zones: unknown; prefixHashes: unknown; segments: string }>>;
    const r = createPromptBuilder().render(corpusInput(2));
    const { tools, system, memory } = r.zoneHashes;
    assert.deepEqual(parsed["2"]![0], { zones: { tools, system, memory }, prefixHashes: r.prefixHashes, segments: sha256Hex(canonicalJson(r.segments)) });
  });
  it("the stable zones carry no clock, session id, counter or random value: rendering 'later' changes nothing", () => {
    const realNow = Date.now, realRandom = Math.random;
    try {
      const a = createPromptBuilder().render(corpusInput(2));
      Date.now = () => realNow() + 86_400_000;
      Math.random = () => 0.123456;
      const b = createPromptBuilder().render(corpusInput(2));
      assert.equal(canonicalJson(a.segments), canonicalJson(b.segments));
    } finally { Date.now = realNow; Math.random = realRandom; }
  });
  it("golden: the corpus' stable-zone hashes are pinned; a drift is a deliberate, reviewed change to the wire bytes (R3)", () => {
    const r = createPromptBuilder().render(corpusInput(2));
    assert.deepEqual({ tools: r.zoneHashes.tools, system: r.zoneHashes.system, memory: r.zoneHashes.memory }, {
      tools: "4f99f2e22cdd5df94e83fe47b3ae6a821ec120bee9c6060cec8202bad093c601",
      system: "c0404441fa7123315f35476e4bf4f67c94368c27689c27fb3606467ed75eeb29",
      memory: "bbc68a9ed78ac96457b11e7a1a46c6c7f3e22297538cbf1364571ff5baa7f521",
    });
    assert.equal(r.prefixHashes.memory, "1ce42289ebe8c430b0c9a571e735da086b0d7aa0b8ee78a50bc5a79e2964122f");
  });
});
