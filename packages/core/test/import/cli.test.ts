import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runImport } from "../../src/import/cli.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { FAKE_TOKEN, hermesFixture } from "./fixtures.ts";

const reason = async (argv: string[]) => { const e = await runImport(argv, {}, "/nonexistent-home"); return e.ok ? "ok" : `${e.error}/${e.reason}/${e.exit}`; };

describe("importer argv", () => {
  it("refuses bad argument combinations", async () => {
    const h = ["--home", "/tmp/x"];
    assert.equal(await reason(["zeroclaw", "--detect", ...h]), "E_INVALID_PARAMS/source-type/2");
    assert.equal(await reason(["hermes", ...h]), "E_INVALID_PARAMS/mode/2");
    assert.equal(await reason(["hermes", "--detect", "--skills", ...h]), "E_INVALID_PARAMS/mode/2");
    assert.equal(await reason(["hermes", "--detect", "--apply", ...h]), "E_INVALID_PARAMS/apply-with-detect/2");
    assert.equal(await reason(["hermes", "--detect", "--enable", ...h]), "E_INVALID_PARAMS/skills-only-flag/2");
    assert.equal(await reason(["hermes", "--skills", "--on-conflict", "merge", ...h]), "E_INVALID_PARAMS/on-conflict/2");
    assert.equal(await reason(["hermes", "--skills", "--max-skill-bytes", "0", ...h]), "E_INVALID_PARAMS/max-skill-bytes/2");
    assert.equal(await reason(["openclaw", "--detect", "--profile", "p", ...h]), "E_INVALID_PARAMS/profile-not-supported/2");
    assert.equal(await reason(["hermes", "--detect", "--bogus", ...h]), "E_INVALID_PARAMS/bad-arguments/2");
    assert.equal(await reason(["hermes", "--detect"]), "E_INVALID_PARAMS/home-missing/2");
  });
  it("runs detect, skills and rollback end to end through the envelope", async () => {
    const fx = hermesFixture(); const home = tempDir("p1b-imp-home-");
    const d = await runImport(["hermes", "--detect", "--source", fx.root, "--home", home], {}, "/nonexistent-home");
    assert.ok(d.ok && d.schema === "import.detect/1" && !("schema" in d.value));
    const s = await runImport(["hermes", "--skills", "--apply", "--source", fx.root, "--home", home], {}, "/nonexistent-home");
    assert.ok(s.ok && s.schema === "import.skills/1");
    const reportPath = (s.value as { reportPath: string }).reportPath;
    const r = await runImport(["hermes", "--rollback", reportPath, "--home", home], {}, "/nonexistent-home");
    assert.ok(r.ok && r.schema === "import.rollback/1" && (r.value as { mode: string }).mode === "dry-run");
    for (const e of [d, s, r]) assert.ok(!JSON.stringify(e).includes(FAKE_TOKEN));
  });
  it("prints exactly one envelope line from the entry script", () => {
    const bin = fileURLToPath(new URL("../../src/import-bin.ts", import.meta.url));
    const home = tempDir("p1b-imp-home-");
    const p = spawnSync(process.execPath, ["--experimental-strip-types", "--conditions=source", "--no-warnings", bin, "hermes", "--detect", "--home", home, "--source", join(home, "nope")], { encoding: "utf8" });
    assert.equal(p.status, 2);
    const lines = p.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]!), { ok: false, error: "E_SOURCE_NOT_FOUND", message: `no directory at ${join(home, "nope")}`, reason: "source-missing", exit: 2 });
    assert.ok(!existsSync(join(home, "skills")) && !existsSync(join(home, "imports")));
  });
});
