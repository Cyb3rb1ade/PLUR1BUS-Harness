import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { detect, type DetectReport } from "../../src/import/detect.ts";
import { ImportError } from "../../src/import/types.ts";
import { renderDetect } from "../../src/import/render.ts";
import { CONTENT_MARKER, FAKE_TOKEN, harnessHome, hermesFixture, openclawFixture, SYMLINKS, type OpenclawFixture } from "./fixtures.ts";
import { treeDigest } from "./tree.ts";

const TOP = ["agents", "counts", "other", "plur1bus", "portability", "rerankers", "secrets", "skillRoots", "skills", "source", "sourceType", "target", "version", "warnings"];

describe("detect (OpenClaw)", () => {
  let fx: OpenclawFixture; let home: string; let r: DetectReport; let homeDigest: string; let srcDigest: string;
  before(async () => {
    fx = await openclawFixture(); home = harnessHome();
    homeDigest = treeDigest(home); srcDigest = treeDigest(fx.base);
    r = await detect({ sourceType: "openclaw", source: fx.root, home, env: {}, homedir: "/nonexistent-home" });
  });
  after(() => fx.close());

  it("has the documented top-level keys", () => assert.deepEqual(Object.keys(r).sort(), TOP));
  it("writes nothing to the harness home or the source", () => {
    assert.equal(treeDigest(home), homeDigest);
    assert.equal(treeDigest(fx.base), srcDigest);
  });
  it("plans every skill", () => {
    const by = (id: string, tier?: string) => r.skills.find((s) => s.id === id && (!tier || s.tier === tier))!;
    assert.equal(by("notes", "workspace").plannedAction, "import");
    assert.equal(r.skills.filter((s) => s.id === "notes").length, 2);
    const shadow = r.skills.filter((s) => s.id === "notes")[1]!;
    assert.deepEqual([shadow.plannedAction, shadow.reason], ["conflict-skip", "shadowed-in-source"]);
    assert.equal(by("runner").hasScripts, true);
    assert.deepEqual(by("escape").skipped.symlinkEscapes, SYMLINKS.file ? ["leak.txt"] : []);
    assert.equal(by("escape").skipped.secretFiles, 1);
    const c = by("conflict");
    assert.deepEqual([c.existsInHarness, c.plannedAction, c.reason], [true, "conflict-skip", "id-taken"]);
    assert.ok(by("ws-made") && by("extra-one"));
    assert.equal(by("notes").description, "Take meeting notes");
  });
  it("renders every section and says nothing was written", () => {
    const h = renderDetect(r);
    for (const s of ["Source: openclaw", "Target:", "Agents (2)", "PLUR1BUS:", "Reranker:", "Skills (", "Secrets (presence only):", "Summary:", "Nothing was written."]) assert.ok(h.includes(s), s);
  });
  it("never carries the fake token or content, JSON or human", () => {
    for (const s of [JSON.stringify(r), renderDetect(r)]) {
      assert.ok(!s.includes(FAKE_TOKEN), "token leaked");
      assert.ok(!s.includes(CONTENT_MARKER), "content leaked");
    }
  });
});

describe("detect (Hermes)", () => {
  it("lists profile, external and nested skills; no token or content", async () => {
    const fx = hermesFixture(); const home = harnessHome();
    const digest = treeDigest(fx.base);
    const r = await detect({ sourceType: "hermes", source: fx.root, home, env: {}, homedir: "/nonexistent-home" });
    assert.deepEqual(r.skills.map((s) => s.id).sort(), ["deploy", "ext-skill", "lit-review", "meeting-notes"]);
    assert.equal(r.skills.find((s) => s.id === "deploy")!.hasScripts, true);
    assert.equal(r.skills.find((s) => s.id === "meeting-notes")!.description, "Turn raw meeting notes into action items");
    assert.equal(treeDigest(fx.base), digest);
    for (const s of [JSON.stringify(r), renderDetect(r)]) { assert.ok(!s.includes(FAKE_TOKEN)); assert.ok(!s.includes(CONTENT_MARKER)); }
  });

  it("surfaces wsl-unavailable candidate and warnings when WSL enumeration fails on Windows platform (Item 6)", async () => {
    const home = harnessHome();
    const failingRunner = async () => {
      throw new ImportError("E_SOURCE_BUSY", "wsl-timeout", "wsl.exe timed out");
    };

    // 1. Native source missing path
    const report1 = await detect({
      sourceType: "openclaw",
      home,
      platform: "win32",
      wslRunner: failingRunner,
      env: {},
      homedir: "/nonexistent-home",
    });

    assert.ok(report1.warnings.some((w) => w.includes("WSL candidate discovery failed")));
    assert.ok(report1.candidates);
    assert.equal(report1.candidates.length, 1);
    assert.equal(report1.candidates[0]!.distro, "wsl-unavailable");
    assert.ok(report1.candidates[0]!.reason?.includes("wsl-unavailable"));

    // 2. Native source found path
    const fx = await openclawFixture();
    try {
      const report2 = await detect({
        sourceType: "openclaw",
        home,
        platform: "win32",
        wslRunner: failingRunner,
        env: { OPENCLAW_HOME: fx.root },
        homedir: fx.base,
      });

      assert.ok(report2.warnings.some((w) => w.includes("WSL candidate discovery failed")));
      assert.ok(report2.candidates);
      assert.equal(report2.candidates.length, 1);
      assert.equal(report2.candidates[0]!.distro, "wsl-unavailable");
      assert.ok(report2.candidates[0]!.reason?.includes("wsl-unavailable"));
    } finally {
      await fx.close();
    }
  });
});
