// Smoke tests for M7 synthetic fixtures (docs/import.md §6.1, §6.2, milestones M7).
// Validates that detect recognises OpenClaw and Hermes fixtures with two distinct
// embedding identities (matching 384-d and mismatched 768-d), curated files, cron jobs,
// pairing lists, skills, and secrets, with zero token/content leaks.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detect, type DetectReport } from "../../src/import/detect.ts";
import { renderDetect } from "../../src/import/render.ts";
import {
  buildM7HermesFixture,
  buildM7OpenclawFixture,
  CONTENT_MARKER,
  E5,
  FAKE_TOKEN,
  harnessHome,
  type M7HermesFixture,
  type M7OpenclawFixture,
  NANO,
  SHARED_KEY,
} from "./fixtures.ts";
import { buildM7Layout, LAYOUT_OSES, platformOf, type M7Layout } from "./layouts.ts";

describe("M7 synthetic fixtures smoke tests", { timeout: 30_000 }, () => {
  let ocFx: M7OpenclawFixture;
  let hmFx: M7HermesFixture;
  let home: string;
  let ocReport: DetectReport;
  let hmReport: DetectReport;

  before(async () => {
    home = harnessHome();
    ocFx = await buildM7OpenclawFixture();
    hmFx = await buildM7HermesFixture();
    ocReport = await detect({ sourceType: "openclaw", source: ocFx.root, home, env: {}, homedir: ocFx.base });
    hmReport = await detect({ sourceType: "hermes", source: hmFx.root, home, env: {}, homedir: hmFx.base });
  });

  after(() => {
    ocFx.close();
  });

  describe("OpenClaw M7 fixture", () => {
    it("recognises version markers and agent workspaces", () => {
      assert.equal(ocReport.sourceType, "openclaw");
      assert.equal(ocReport.version.release, "2026.9.5");
      assert.equal(ocReport.version.stateSchema, 17);
      const agentIds = ocReport.agents.map((a) => a.agentId).sort();
      assert.deepEqual(agentIds, ["alpha", "beta"]);
      assert.equal(ocReport.agents.find((a) => a.agentId === "alpha")!.workspace, join(ocFx.root, "ws-alpha"));
      assert.equal(ocReport.agents.find((a) => a.agentId === "beta")!.workspace, join(ocFx.root, "ws-beta"));
    });

    it("detects two embedding identities: matching (384-d) vs mismatched (768-d)", () => {
      assert.equal(ocReport.plur1bus.installed, true);
      const alphaStore = ocReport.plur1bus.stores.find((s) => s.storeId === "agent:alpha");
      assert.ok(alphaStore, "alpha store found");
      assert.equal(alphaStore.identity.fields.dimension.value, 384);
      assert.equal(alphaStore.identity.fields.model.value, E5);
      assert.equal(alphaStore.identity.comparison.verdict, "match");
      assert.equal(alphaStore.identity.plannedAction, "take-over");

      const betaStore = ocReport.plur1bus.stores.find((s) => s.storeId === "agent:beta");
      assert.ok(betaStore, "beta store found");
      assert.equal(betaStore.identity.fields.dimension.value, 768);
      assert.equal(betaStore.identity.comparison.verdict, "mismatch");
      assert.equal(betaStore.identity.plannedAction, "re-embedding-migration");

      const sharedStore = ocReport.plur1bus.stores.find((s) => s.storeId === `shared:workspaces:${SHARED_KEY}`);
      assert.ok(sharedStore, "shared pool store found");
      assert.equal(sharedStore.identity.fields.dimension.value, 384);
      assert.equal(sharedStore.identity.comparison.verdict, "match");
      assert.equal(sharedStore.identity.plannedAction, "take-over");
    });

    it("verifies D15 curated files exist on disk", () => {
      for (const [key, path] of Object.entries(ocFx.curatedFiles)) {
        assert.ok(existsSync(path), `curated file ${key} (${path}) must exist`);
      }
      assert.ok(existsSync(join(ocFx.root, "ws-beta", "SOUL.md")));
      assert.ok(existsSync(join(ocFx.root, "ws-beta", "MEMORY.md")));
    });

    it("detects other metadata (soul, memory files, dreams, cron jobs)", () => {
      assert.ok(Number(ocReport.other.soul) >= 1, "soul file detected");
      assert.ok(Number(ocReport.other.memoryFiles) >= 2, "MEMORY.md and USER.md detected");
      assert.ok(Number(ocReport.other.dreamsFiles) >= 1, "DREAMS.md detected");
      assert.equal(Number(ocReport.other.cronJobs), 3, "2 user cron jobs + 1 managed dreaming job");
    });

    it("detects skills and secrets without leaks", () => {
      const skillIds = ocReport.skills.map((s) => s.id);
      assert.ok(skillIds.includes("notes"));
      assert.ok(skillIds.includes("runner"));
      assert.ok(skillIds.includes("conflict"));

      const secretPaths = ocReport.secrets.files.map((f) => f.path);
      assert.ok(secretPaths.includes(".env"));
      assert.ok(secretPaths.includes("agents/alpha/agent/openclaw-agent.sqlite"));
      assert.ok(secretPaths.includes("agents/beta/agent/auth-profiles.json"));

      const jsonStr = JSON.stringify(ocReport);
      assert.ok(!jsonStr.includes(FAKE_TOKEN), "FAKE_TOKEN must never leak in report");
      assert.ok(!jsonStr.includes(CONTENT_MARKER), "CONTENT_MARKER must never leak in report");

      const human = renderDetect(ocReport);
      assert.ok(!human.includes(FAKE_TOKEN), "FAKE_TOKEN must never leak in human render");
      assert.ok(!human.includes(CONTENT_MARKER), "CONTENT_MARKER must never leak in human render");
    });
  });

  describe("Hermes M7 fixture", () => {
    it("recognises Hermes version and profiles as agents", () => {
      assert.equal(hmReport.sourceType, "hermes");
      assert.equal(hmReport.version.configVersion, 45);
      assert.equal(hmReport.version.sessionsSchema, 30);
      const agentIds = hmReport.agents.map((a) => a.agentId).sort();
      assert.deepEqual(agentIds, ["default", "work"]);
    });

    it("detects configured PLUR1BUS memory provider and two profiles with distinct models", () => {
      assert.equal(hmReport.plur1bus.installed, true);
      assert.deepEqual(hmReport.plur1bus.plugin, { memoryProvider: "plur1bus" });
      assert.equal(hmFx.profiles.matching.dims, 384);
      assert.equal(hmFx.profiles.matching.model, E5);
      assert.equal(hmFx.profiles.mismatched.dims, 768);
      assert.equal(hmFx.profiles.mismatched.model, NANO);
    });

    it("verifies pairing lists exist (approved to import, pending to exclude)", () => {
      assert.ok(existsSync(hmFx.pairings.approvedPath), "approved pairings file exists");
      assert.ok(existsSync(hmFx.pairings.pendingPath), "pending pairings file exists");
      const approved = JSON.parse(readFileSync(hmFx.pairings.approvedPath, "utf8"));
      assert.ok("12345" in approved);
      const pending = JSON.parse(readFileSync(hmFx.pairings.pendingPath, "utf8"));
      assert.ok("99999" in pending);
    });

    it("detects other metadata (soul, memory files, cron, sessions DB)", () => {
      assert.equal(hmReport.other.soul, 2, "SOUL.md in default and work profiles");
      assert.equal(hmReport.other.memoryFiles, 4, "MEMORY.md and USER.md across default and work");
      assert.equal(hmReport.other.cronFiles, 2, "jobs.json across default and work");
      assert.equal(hmReport.other.sessionsDb, true, "state.db sessions store detected");
    });

    it("detects skills and secrets without leaks", () => {
      const skillIds = hmReport.skills.map((s) => s.id);
      assert.ok(skillIds.includes("meeting-notes"));
      assert.ok(skillIds.includes("lit-review"));

      const secretPaths = hmReport.secrets.files.map((f) => f.path);
      assert.ok(secretPaths.includes(".env"));
      assert.ok(secretPaths.includes("auth.json"));

      const jsonStr = JSON.stringify(hmReport);
      assert.ok(!jsonStr.includes(FAKE_TOKEN), "FAKE_TOKEN must never leak in report");
      assert.ok(!jsonStr.includes(CONTENT_MARKER), "CONTENT_MARKER must never leak in report");

      const human = renderDetect(hmReport);
      assert.ok(!human.includes(FAKE_TOKEN), "FAKE_TOKEN must never leak in human render");
      assert.ok(!human.includes(CONTENT_MARKER), "CONTENT_MARKER must never leak in human render");
    });
  });

  describe("Per-OS M7 layouts", { timeout: 60_000 }, () => {
    for (const os of LAYOUT_OSES) {
      it(`builds and detects M7 layout for ${os}`, async () => {
        const layout: M7Layout = await buildM7Layout(os);
        const native = platformOf(os) === process.platform;
        const common = { home, env: layout.env, homedir: layout.home };

        const oc = await detect({ sourceType: "openclaw", source: native ? undefined : layout.openclawRoot, ...common });
        assert.equal(oc.sourceType, "openclaw");
        assert.equal(oc.agents.length, 2);
        assert.deepEqual(oc.plur1bus.stores.map((s) => s.identity.fields.dimension.value).sort(), [384, 384, 768]);

        const hm = await detect({ sourceType: "hermes", source: native ? undefined : layout.hermesRoot, ...common });
        assert.equal(hm.sourceType, "hermes");
        assert.equal(hm.agents.length, 2);
        assert.equal(hm.plur1bus.installed, true);

        layout.openclaw.close();
      });
    }
  });
});
