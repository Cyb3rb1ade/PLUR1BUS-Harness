// Every OS layout on every CI OS (plugin-distribution spec §B.7, gap G12): a layout for this host's OS is found through
// that OS's own environment (HOME, or USERPROFILE + LOCALAPPDATA); the others are read as copies with --source, their
// configs' paths rebased or reported unmapped. The WSL directions (d, e) run through the mapper on every OS.
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detect, type DetectReport } from "../../src/import/detect.ts";
import { locateSource, SourcePathMapper } from "../../src/import/paths.ts";
import { renderDetect, renderSkills } from "../../src/import/render.ts";
import { importSkills } from "../../src/import/skills-import.ts";
import { DEFAULT_MAX_SKILL_BYTES } from "../../src/import/skills-scan.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { CONTENT_MARKER, FAKE_TOKEN, harnessHome, SYMLINKS } from "./fixtures.ts";
import { buildLayout, LAYOUT_OSES, platformOf, USER, type Layout } from "./layouts.ts";
import { treeDigest } from "./tree.ts";

const flavour = (p: NodeJS.Platform) => (p === "win32" ? "win32" : "posix");

for (const os of LAYOUT_OSES) {
  const native = platformOf(os) === process.platform;
  const foreign = flavour(platformOf(os)) !== flavour(process.platform);
  describe(`${os} layout on ${process.platform} (${native ? "found natively" : "read as a copy"})`, () => {
    let L: Layout; let digest: string; let oc: DetectReport; let hm: DetectReport; let home: string;
    before(async () => {
      L = await buildLayout(os);
      digest = treeDigest(L.base);
      home = harnessHome();
      const common = { home, env: L.env, homedir: L.home };
      oc = await detect({ sourceType: "openclaw", source: native ? undefined : L.openclawRoot, ...common });
      hm = await detect({ sourceType: "hermes", source: native ? undefined : L.hermesRoot, ...common });
    });

    it("finds the OpenClaw root and rebases its config paths onto it", () => {
      assert.deepEqual([oc.source.root, oc.source.resolvedFrom], [L.openclawRoot, native ? "default" : "flag:--source"]);
      assert.equal(oc.agents.find((a) => a.agentId === "alpha")!.workspace, join(L.openclawRoot, "ws-alpha"));
      assert.deepEqual(oc.portability.movedFrom, [L.origin.openclawRoot]);
      assert.deepEqual(oc.plur1bus.stores.map((s) => [s.storeId, s.identity.fields.dimension.value]).sort(), [["agent:alpha", 384], ["agent:beta", 768]]);
      assert.equal(oc.plur1bus.storeRoot?.baseDbPath, join(L.openclawRoot, "memory", "lancedb-namespaced"));
      assert.ok(oc.skillRoots.some((r) => r.tier === "extra" && r.dir === join(L.openclawRoot, "extra-skills") && r.exists));
      assert.deepEqual(oc.portability.unmapped, foreign ? [{ key: "skills.load.extraDirs[1]", value: L.outsidePath, reason: "foreign-path" }] : []);
    });

    it("scans skills through links, a 300+ character path and CRLF/BOM files", () => {
      const notes = oc.skills.find((s) => s.id === "notes")!;
      assert.deepEqual(notes.problems, []);
      assert.ok(notes.skipped.symlinkDirs.includes("docs-link"), "a directory link (junction on Windows) is not followed");
      if (SYMLINKS.file) assert.equal(notes.files, 4, "SKILL.md, résumé file, docs/guide.md, guide-link.md");
      const deep = oc.skills.find((s) => s.id === "deep")!;
      assert.deepEqual([deep.problems, deep.plannedAction], [[], "import"]);
      assert.ok(deep.path.length + L.deepRel.length > 300);
      assert.equal(oc.skills.find((s) => s.id === "conflict")!.plannedAction, "conflict-skip");
    });

    it("refuses names a Windows or case-insensitive target cannot hold", async (t) => {
      if (!L.created.reservedName) {
        t.skip(os === "windows" ? "a Windows source cannot hold Windows-reserved names" : `this host (${process.platform}) is not asked to create Windows-reserved names`);
        return;
      }
      const onWin = await detect({ sourceType: "openclaw", source: L.openclawRoot, home, env: {}, homedir: L.home, targetPlatform: "win32" });
      assert.deepEqual(onWin.skills.find((s) => s.id === "portable-not")!.problems, ["unportable-name:aux.md"]);
      if (L.created.caseVariants) assert.deepEqual(onWin.skills.find((s) => s.id === "casey")!.problems, ["case-collision:README.md|readme.md"]);
      assert.equal(oc.skills.find((s) => s.id === "portable-not")!.plannedAction, process.platform === "win32" ? "refuse" : "import");
    });

    it("imports the skills byte-exact (long path included) and converges on a second run", async () => {
      const target = tempDir("p1b-imp-home-");
      const opts = { sourceType: "openclaw" as const, source: L.openclawRoot, home: target, env: {}, homedir: L.home, enable: false, onConflict: "skip" as const, maxBytes: DEFAULT_MAX_SKILL_BYTES };
      const r = await importSkills({ ...opts, apply: true }, renderSkills);
      assert.deepEqual(r.errors, []);
      const out = Object.fromEntries(r.skills.map((s) => [s.id, s.outcome]));
      assert.deepEqual([out.notes, out.deep, out["extra-one"]], ["imported", "imported", "imported"]);
      assert.ok(existsSync(join(target, "skills", "deep", ...L.deepRel.split("/"))));
      assert.equal(readFileSync(join(target, "skills", "notes", "SKILL.md"), "utf8"), readFileSync(join(L.openclawRoot, "ws-alpha", "skills", "notes", "SKILL.md"), "utf8"));
      const again = await importSkills({ ...opts, apply: false }, renderSkills);
      assert.deepEqual(again.skills.filter((s) => ["notes", "deep", "extra-one"].includes(s.id)).map((s) => s.action), ["skip-identical", "skip-identical", "skip-identical"]);
    });

    it("finds the Hermes root and its external dir named in the source's syntax", () => {
      assert.deepEqual([hm.source.root, hm.source.resolvedFrom], [L.hermesRoot, native ? "default" : "flag:--source"]);
      assert.deepEqual(hm.portability.movedFrom, [L.origin.hermesRoot]);
      assert.deepEqual(hm.skills.map((s) => s.id).sort(), ["ext-one", "lit-review", "meeting-notes"]);
    });

    it("leaves the source byte-identical and reports no token or content", () => {
      assert.equal(treeDigest(L.base), digest);
      for (const r of [oc, hm]) for (const s of [JSON.stringify(r), renderDetect(r)]) {
        assert.ok(!s.includes(FAKE_TOKEN), "token leaked");
        assert.ok(!s.includes(CONTENT_MARKER), "content leaked");
      }
    });
  });
}

describe("WSL directions through the mapper (layouts d, e)", () => {
  it("(d) a Linux layout inside WSL read from Windows at \\\\wsl.localhost", () => {
    const lower = USER.toLowerCase();
    const loc = locateSource({ accessRoot: `\\\\wsl.localhost\\Ubuntu-24.04\\home\\${lower}\\.openclaw`, platform: "win32", env: {}, home: `C:\\Users\\${USER}` });
    const m = new SourcePathMapper(loc, { vars: { OPENCLAW_HOME: loc.sourceRoot } });
    const unc = `\\\\wsl.localhost\\Ubuntu-24.04\\home\\${lower}`;
    assert.deepEqual([
      m.map(`/home/${lower}/.openclaw/ws-alpha`, "a").path, m.map(`/home/${lower}/projects/team-skills`, "b").path,
      m.map("/mnt/c/Users/Shared/skills", "c").path, m.map("~/notes", "d").path,
    ], [`${unc}\\.openclaw\\ws-alpha`, `${unc}\\projects\\team-skills`, "C:\\Users\\Shared\\skills", `${unc}\\notes`]);
    assert.deepEqual(m.report().unmapped, []);
  });
  it("(e) a Windows layout read from inside WSL at /mnt/c", () => {
    const loc = locateSource({ accessRoot: `/mnt/c/Users/${USER}/.openclaw`, platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu-24.04" }, home: "/home/j" });
    const m = new SourcePathMapper(loc, { vars: { OPENCLAW_HOME: loc.sourceRoot } });
    assert.deepEqual([
      m.map(`C:\\Users\\${USER}\\.openclaw\\ws-alpha`, "a").path, m.map(`c:\\users\\${USER.toLowerCase()}\\projects\\team-skills`, "b").path,
      m.map("D:\\Data\\skills", "c").path, m.map("~\\notes", "d").path, m.map("/home/j/x", "e").path,
    ], [`/mnt/c/Users/${USER}/.openclaw/ws-alpha`, `/mnt/c/Users/${USER}/projects/team-skills`, "/mnt/d/Data/skills", `/mnt/c/Users/${USER}/notes`, null]);
    assert.deepEqual(m.report().unmapped.map((u) => u.reason), ["foreign-path"]);
  });
});
