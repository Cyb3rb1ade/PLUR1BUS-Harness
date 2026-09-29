import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readIndex } from "../../packages/core/src/import/skills-registry.ts";
import { cli, coreEnv, fixtures, reapHome, startDaemon, waitFor } from "./helpers.ts";

const fx = fixtures();
const ENV = coreEnv(fx.env);
const run = (h: string, args: string[], allowFail = false): any => cli(h, args, { env: ENV, allowFail });
/** A failed `--json` run: `{ exit, doc }`, the error document parsed from stdout. */
const fail = (h: string, args: string[]): { exit: number; doc: any } => {
  const r = run(h, args, true);
  assert.ok("exit" in r, `expected a failure: ${args.join(" ")}`);
  return { exit: r.exit, doc: JSON.parse(r.stdout) };
};

/** SHA-256 over every file under skills/, modules/, extensions/ (relative path and bytes; a tree that does not exist
 *  hashes as empty). Runtime state (`run/`, `data/`, `config.json`) is not part of a refusal's promise here. */
function treeHash(h: string): string {
  const out = createHash("sha256");
  const walk = (rel: string): void => {
    const abs = join(h, rel);
    let st;
    try { st = lstatSync(abs); } catch { return; }
    if (st.isDirectory()) { for (const n of readdirSync(abs).sort()) walk(`${rel}/${n}`); return; }
    out.update(`${rel}\0`).update(readFileSync(abs)).update("\0");
  };
  for (const d of ["skills", "modules", "extensions"]) walk(d);
  return out.digest("hex");
}

const child = (h: string, role: string): any => run(h, ["daemon", "status"]).children?.find((c: any) => c.role === role) ?? null;
const ready = (h: string, role: string, timeoutMs = 30_000) =>
  waitFor(`${role} ready`, () => { const c = child(h, role); return c?.process?.state === "ready" && c; }, timeoutMs);

// Spec §12 acceptance 1–5 end to end through the real binary and a real core: only the CLI is used, and the home's path
// holds a space and a non-ASCII letter (Review Focus 4). The base is /tmp, so the module sockets stay under macOS's
// sun_path limit (104 bytes).
describe("X1 acceptance — extensions from a file", { skip: process.platform === "win32" && "POSIX system job" }, () => {
  let base = "";
  let h = "";
  before(async () => {
    base = mkdtempSync(join("/tmp", "p1x A-"));
    h = join(base, "Jürgen");
    mkdirSync(h);
    run(h, ["agent", "create", "bernd"]);
    run(h, ["agent", "create", "anna"]);
    run(h, ["config", "set", "supervisor.graceMs", "15000", "--yes"]);
    startDaemon(h, fx.env);
    await ready(h, "core");
  });
  after(async () => {
    try { cli(h, ["daemon", "stop"], { allowFail: true }); } catch { /* best effort */ }
    await reapHome(h);
    rmSync(base, { recursive: true, force: true });
  });

  it("a signed skill installs disabled, enables for bernd only, disables again, and the importer reads the index", () => {
    const installed = run(h, ["skill", "install", fx.path("signed-skill.p1x"), "--yes"]);
    assert.equal(installed.schema, "skill.install/1");
    assert.equal(installed.name, "demo-skill");
    assert.equal(installed.state, "installed");
    assert.equal(installed.replaced, false);
    const entry = () => readIndex(h).skills.find((e) => e.id === "demo-skill");
    assert.equal(entry()?.enabled, false);

    const enabled = run(h, ["skill", "enable", "demo-skill", "--agent", "bernd", "--yes"]);
    assert.equal(enabled.schema, "skill.enable/1");
    assert.equal(enabled.state, "enabled");
    assert.equal(entry()?.enabled, true);
    const names = (agent: string): string[] => run(h, ["skill", "list", "--agent", agent]).items.map((i: any) => i.name);
    assert.deepEqual(names("bernd"), ["demo-skill"]);
    assert.deepEqual(names("anna"), []);

    // The TypeScript importer's own reader sees the entry the Rust code wrote (X1-R14).
    const e = entry()!;
    assert.equal(e.source, "file");
    assert.equal((e.package as any)?.id, "fixtures/demo-skill");

    const disabled = run(h, ["skill", "disable", "demo-skill"]);
    assert.equal(disabled.state, "installed");
    assert.equal(entry()?.enabled, false);
  });

  it("an unsigned folder skill needs --allow-unsigned and lists its script", () => {
    const dir = fx.path("unsigned-folder-skill");
    const r = fail(h, ["skill", "install", dir, "--yes"]);
    assert.equal(r.exit, 2, JSON.stringify(r.doc));
    assert.equal(r.doc.error, "E_APPROVAL_REQUIRED");
    assert.equal(r.doc.reason, "acknowledge-unsigned");
    assert.match(String(r.doc.data.scripts[0].path), /scripts\/run\.sh$/);
    assert.equal(readIndex(h).skills.some((e) => e.id === "unsigned-folder-skill"), false);
    const ok = run(h, ["skill", "install", dir, "--allow-unsigned", "--yes"]);
    assert.equal(ok.name, "unsigned-folder-skill");
  });

  it("a module package installs disabled, plugin enable starts it and fixture-b, plugin disable holds fixture-b back and prints the plan", async () => {
    for (const p of ["module-fixture.p1x", "fixture-b.p1x"]) {
      const v = run(h, ["plugin", "install", fx.path(p), "--yes"]);
      assert.equal(v.schema, "plugin.install/1");
      assert.equal(v.state, "installed");
    }
    assert.notEqual(child(h, "fixture")?.process?.state, "ready", "installed disabled: nothing runs");
    for (const name of ["fixture", "fixture-b"]) {
      const v = run(h, ["plugin", "enable", name, "--yes"]);
      assert.equal(v.state, "enabled", JSON.stringify(v));
    }
    await ready(h, "fixture");
    await ready(h, "fixture-b");

    const text: string = cli(h, ["plugin", "disable", "fixture", "--yes"], { json: false, env: ENV });
    assert.match(text, /will be held back: .*fixture-b/, text);
    await waitFor("fixture-b to stop running", () => child(h, "fixture-b")?.process?.state !== "ready", 30_000);
    const list = run(h, ["plugin", "list"]).items;
    assert.equal(list.find((i: any) => i.name === "fixture")?.state, "installed");
  });

  it("uninstall keeps data and config, purge removes them, restore brings the item back disabled", () => {
    // A skill: uninstall moves it to the trash, restore brings it back disabled.
    const u = run(h, ["skill", "uninstall", "demo-skill", "--yes"]);
    assert.equal(u.schema, "skill.uninstall/1");
    assert.equal(u.purged, false);
    assert.ok(typeof u.trashId === "string" && u.trashId.length > 0, JSON.stringify(u));
    assert.equal(readIndex(h).skills.some((e) => e.id === "demo-skill"), false);
    const r = run(h, ["skill", "restore", u.trashId]);
    assert.equal(r.schema, "skill.restore/1");
    assert.equal(readIndex(h).skills.find((e) => e.id === "demo-skill")?.enabled, false);

    // A module: uninstall keeps its data directory and config section; a purge removes both.
    run(h, ["plugin", "uninstall", "fixture-b", "--yes"]);
    run(h, ["config", "set", "modules.fixture.greeting", "\"hello\"", "--yes"]);
    mkdirSync(join(h, "data", "ext", "fixture"), { recursive: true });
    const marker = join(h, "data", "ext", "fixture", "keep.txt");
    writeFileSync(marker, "kept\n");
    const kept = run(h, ["plugin", "uninstall", "fixture", "--yes"]);
    assert.equal(kept.purged, false);
    assert.equal(readFileSync(marker, "utf8"), "kept\n");
    assert.equal(run(h, ["config", "get", "modules.fixture.greeting"]).value, "hello");
    const back = run(h, ["plugin", "restore", kept.trashId]);
    assert.equal(back.schema, "plugin.restore/1");
    assert.equal(run(h, ["plugin", "list"]).items.find((i: any) => i.name === "fixture")?.state, "installed");

    const purged = run(h, ["plugin", "uninstall", "fixture", "--purge", "--yes"]);
    assert.equal(purged.purged, true);
    assert.throws(() => readFileSync(marker), /ENOENT/);
    const cfg = JSON.parse(readFileSync(join(h, "config.json"), "utf8"));
    assert.equal(cfg.modules?.fixture?.greeting, undefined, "the purge removed the configuration section");
  });

  it("every tampered variant is refused with its reason and skills/, modules/, extensions/ stay byte-identical", () => {
    const expected: Record<string, string> = {
      "payload-byte": "digest-mismatch",
      "extra-entry": "package-invalid",
      "dot-dot": "archive-unsafe-entry",
      symlink: "archive-unsafe-entry",
      "case-collision": "archive-unsafe-entry",
      "bomb-101": "download-too-large",
      "foreign-id": "signature-invalid",
      "append-after-eocd": "archive-unsupported",
    };
    const before = treeHash(h);
    for (const [slug, reason] of Object.entries(expected)) {
      const r = fail(h, ["skill", "install", fx.path(`tampered-${slug}.p1x`), "--yes"]);
      assert.equal(r.doc.schema, "error/1", `${slug}: ${JSON.stringify(r.doc)}`);
      assert.equal(r.doc.reason, reason, `${slug}: ${JSON.stringify(r.doc)}`);
      assert.notEqual(r.exit, 0, slug);
      assert.equal(treeHash(h), before, `${slug}: the tree changed`);
    }
  });
});
