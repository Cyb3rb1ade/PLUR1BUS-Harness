// hermes-acceptance3.test.ts — M7 acceptance 3 (docs/import.md §6.3, §11): "Hermes fixture: soul, skills and cron imported;
// MEMORY.md/USER.md entries land as cards with provenance". Soul, skills and cards are imported; cron is NOT imported (KNOWN GAP,
// docs/import.md §11.3) and the test pins what happens instead: it is reported and recorded as deferred, and nothing is written.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { layout } from "../../src/paths.ts";
import { importHermes } from "../../src/import/importers/hermes.ts";
import { importOpenclaw } from "../../src/import/importers/openclaw.ts";
import { importSkills } from "../../src/import/skills-import.ts";
import { renderHermes, renderSkills } from "../../src/import/render.ts";
import { DEFAULT_MAX_SKILL_BYTES } from "../../src/import/skills-scan.ts";
import { buildM7HermesFixture, buildM7OpenclawFixture, CONTENT_MARKER } from "./fixtures.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";

const timeout = 90_000;
const ledgerOf = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((x) => JSON.parse(x));

describe("M7 acceptance 3: Hermes soul, skills, cron, cards", () => {
  it("soul and skills are imported, cards carry provenance, cron is reported as deferred and writes nothing", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p2-acc3-");
    const l = layout(home);
    const r = await importHermes({ home, source: fx.root, apply: true, testInternals: flatTestInternals() as any });

    // Soul: each profile's SOUL.md lands in its agent's workspace, content unchanged (D14).
    for (const [agent, ref] of [["default", "SOUL.md"], ["work", join("profiles", "work", "SOUL.md")]] as const) {
      const target = join(l.workspaceDir(agent), "SOUL.md");
      assert.ok(existsSync(target), `${agent}: SOUL.md missing`);
      assert.equal(readFileSync(target, "utf8"), readFileSync(join(fx.root, ref), "utf8"));
    }

    // Skills: the separate skills pipeline (docs/import.md §9) takes the profile skills and the external dir, disabled by default.
    const s = await importSkills({ sourceType: "hermes", source: fx.root, home, env: {}, homedir: "/nonexistent-home", apply: true, enable: false, onConflict: "skip", maxBytes: DEFAULT_MAX_SKILL_BYTES }, renderSkills);
    assert.deepEqual(s.skills.map((x) => `${x.id}@${x.tier}/${x.agentId}:${x.outcome}`).sort(), [
      "deploy@profile/default:imported", "ext-skill@external/default:imported", "lit-review@profile/work:imported", "meeting-notes@profile/default:imported",
    ]);
    assert.equal(s.errors?.length ?? 0, 0);
    assert.ok(existsSync(l.home) && readdirSync(join(home, "skills")).length > 0);

    // Cards: MEMORY.md cards carry provenance "imported" (the value itself is asserted in provenance-imported.test.ts).
    assert.equal(r.counts.memoryCardsImported, 4, "two MEMORY.md cards per profile; USER.md is unresolved without a proved user");
    assert.equal(r.counts.unresolvedUserScope, 3, "three USER.md cards stay unlinked (ADR-007 Q4, fail-closed)");

    // Cron: KNOWN GAP. Reported, recorded as deferred, never written.
    assert.equal(r.cron.status, "deferred");
    assert.deepEqual(r.cron.jobs.map((j) => [j.id, j.sourceProfile, j.status]), [["c1", "default", "deferred"], ["c2", "default", "deferred"], ["work-sync", "work", "deferred"]]);
    assert.equal(r.counts.cronJobsDeferred, 3);
    assert.deepEqual(ledgerOf(r.ledgerPath!).filter((e) => e.entity === "cron").map((e) => e.action), ["deferred", "deferred", "deferred"]);
    for (const p of ["cron", join("state", "system-jobs"), join("state", "user-jobs"), join("state", "user-jobs.json")]) assert.ok(!existsSync(join(home, p)), `${p} must not exist`);
    assert.match(renderHermes(r), /cron/i);
  });

  it("KNOWN GAP: the OpenClaw importer has no memory-card path (nothing goes through memory.import)", { timeout }, async () => {
    const fx = await buildM7OpenclawFixture();
    try {
      const home = tempDir("p2-acc3-oc-");
      const r = await importOpenclaw({ home, source: fx.root, apply: true, testInternals: flatTestInternals() as any });
      assert.ok(!("memoryCardsImported" in r.counts), "OpenClaw reports no card counts");
      assert.ok(!ledgerOf(r.ledgerPath!).some((e) => e.entity === "memory"), "OpenClaw ledger has no memory entries");
      assert.equal(r.cron.status, "deferred");
      assert.ok(fx.root.length > 0 && CONTENT_MARKER.length > 0);
    } finally { fx.close(); }
  });
});
