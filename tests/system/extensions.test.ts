import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readIndex } from "../../packages/core/src/import/skills-registry.ts";
import { cli, coreEnv, fixtures, reapHome, startDaemon, waitFor } from "./helpers.ts";

// Lazy: fixtures() reads PLUR1BUS_EXT_FIXTURES when the first test asks, not when the file is imported.
let cached: ReturnType<typeof fixtures> | undefined;
const fxs = () => (cached ??= fixtures());
const ENV = (): NodeJS.ProcessEnv => coreEnv(fxs().env);
const run = (h: string, args: string[], allowFail = false): any => cli(h, args, { env: ENV(), allowFail });
/** A failed `--json` run: `{ exit, doc }`, the error document parsed from stdout. */
const fail = (h: string, args: string[]): { exit: number; doc: any } => {
  const r = run(h, args, true);
  assert.ok("exit" in r, `expected a failure: ${args.join(" ")}`);
  return { exit: r.exit, doc: JSON.parse(r.stdout) };
};

/** SHA-256 over every file under skills/, modules/, mcp/, extensions/ and config.json (relative path and bytes; a tree that does not exist
 *  hashes as empty). Runtime state (`run/`, `data/`) is not part of a refusal's promise here. */
function treeHash(h: string): string {
  const out = createHash("sha256");
  const walk = (rel: string): void => {
    const abs = join(h, rel);
    let st;
    try { st = lstatSync(abs); } catch { return; }
    if (st.isDirectory()) { for (const n of readdirSync(abs).sort()) walk(`${rel}/${n}`); return; }
    out.update(`${rel}\0`).update(readFileSync(abs)).update("\0");
  };
  for (const d of ["skills", "modules", "mcp", "extensions", "config.json"]) walk(d);
  return out.digest("hex");
}

const child = (h: string, role: string): any => run(h, ["daemon", "status"]).children?.find((c: any) => c.role === role) ?? null;
const ready = (h: string, role: string, timeoutMs = 30_000) =>
  waitFor(`${role} ready`, () => { const c = child(h, role); return c?.process?.state === "ready" && c; }, timeoutMs);

// X1 §12 acceptance 1–5 and Mv2 lifecycle through the real binary and Core: only the CLI is used, and every home's path
// holds a space and a non-ASCII letter (Review Focus 4). The base is /tmp, so the module sockets stay under macOS's
// sun_path limit (104 bytes). Each test owns its home (and daemon), so an early failure cannot cascade.
describe("X1 and M acceptance — extensions from a file", { skip: process.platform === "win32" && "POSIX system job" }, () => {
  const bases: string[] = [];
  const homes: string[] = [];
  /** A fresh home under `/tmp/p1x A-XXXXXX/Jürgen` with agents bernd and anna; the daemon runs unless `daemon: false`. */
  async function fresh(opts: { daemon?: boolean } = {}): Promise<string> {
    const base = mkdtempSync(join("/tmp", "p1x A-"));
    const h = join(base, "Jürgen");
    mkdirSync(h);
    bases.push(base); homes.push(h);
    run(h, ["agent", "create", "bernd"]);
    run(h, ["agent", "create", "anna"]);
    run(h, ["config", "set", "supervisor.graceMs", "15000", "--yes"]);
    if (opts.daemon !== false) { startDaemon(h, fxs().env); await ready(h, "core"); }
    return h;
  }
  after(async () => {
    for (const h of homes) {
      try { cli(h, ["daemon", "stop"], { allowFail: true }); } catch { /* best effort */ }
      await reapHome(h);
    }
    for (const b of bases) rmSync(b, { recursive: true, force: true });
  });

  it("a first-party skill installs for all despite a narrow install flag, later narrows to bernd and disables", async () => {
    const h = await fresh();
    const installed = run(h, ["skill", "install", fxs().path("signed-skill.p1x"), "--enable=bernd", "--yes"]);
    assert.equal(installed.schema, "skill.install/1");
    assert.equal(installed.name, "demo-skill");
    assert.equal(installed.state, "enabled");
    assert.equal(installed.replaced, false);
    const entry = () => readIndex(h).skills.find((e) => e.id === "demo-skill");
    assert.equal(entry()?.enabled, true);
    const names = (agent: string): string[] => run(h, ["skill", "list", "--agent", agent]).items.map((i: any) => i.name);
    assert.deepEqual(names("bernd"), ["demo-skill"]);
    assert.deepEqual(names("anna"), ["demo-skill"], "Owner decision Mv2-3 applies all agents at installation");

    const enabled = run(h, ["skill", "enable", "demo-skill", "--agent", "bernd", "--yes"]);
    assert.equal(enabled.schema, "skill.enable/1");
    assert.equal(enabled.state, "enabled");
    assert.equal(entry()?.enabled, true);
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

  it("an unsigned folder skill needs --allow-unsigned and lists its script", async () => {
    const h = await fresh();
    const dir = fxs().path("unsigned-folder-skill");
    const r = fail(h, ["skill", "install", dir, "--yes"]);
    assert.equal(r.exit, 2, JSON.stringify(r.doc));
    assert.equal(r.doc.error, "E_APPROVAL_REQUIRED");
    assert.equal(r.doc.reason, "acknowledge-unsigned");
    assert.match(String(r.doc.data.scripts[0].path), /scripts\/run\.sh$/);
    assert.equal(readIndex(h).skills.some((e) => e.id === "unsigned-folder-skill"), false);
    const ok = run(h, ["skill", "install", dir, "--allow-unsigned", "--yes"]);
    assert.equal(ok.name, "unsigned-folder-skill");
    assert.equal(ok.state, "installed");
    assert.equal(readIndex(h).skills.find(e => e.id === "unsigned-folder-skill")?.enabled, false);
    const shown = run(h, ["skill", "show", "unsigned-folder-skill"]);
    assert.equal(shown.item.trust, "unsigned");
  });

  it("unsigned modules install disabled, explicit enable starts them and dependency disable holds fixture-b back", async () => {
    const h = await fresh();
    for (const p of ["unsigned-module-fixture.p1x", "unsigned-fixture-b.p1x"]) {
      const v = run(h, ["plugin", "install", fxs().path(p), "--allow-unsigned", "--yes"]);
      assert.equal(v.schema, "plugin.install/1");
      assert.equal(v.state, "installed");
    }
    const c0 = child(h, "fixture");
    assert.ok(c0, "the supervisor lists the installed module");
    assert.equal(c0.process.state, "stopped", "installed disabled: nothing runs");
    assert.equal(c0.process.reason, "disabled");
    for (const name of ["fixture", "fixture-b"]) {
      const v = run(h, ["plugin", "enable", name, "--yes"]);
      assert.equal(v.state, "enabled", JSON.stringify(v));
    }
    await ready(h, "fixture");
    await ready(h, "fixture-b");

    // The plan is printed before the change is applied, and the dependent is held back with its own reason.
    const text: string = cli(h, ["plugin", "disable", "fixture", "--yes"], { json: false, env: ENV() });
    const plan = text.search(/will be held back: .*fixture-b/);
    assert.ok(plan >= 0, text);
    assert.ok(plan < text.indexOf("disabled fixture"), `the plan comes before the applied result: ${text}`);
    const held = await waitFor("fixture-b held back", () => { const c = child(h, "fixture-b"); return c?.process?.state === "stopped" && c; }, 30_000);
    assert.equal(held.process.reason, "needs-unavailable", JSON.stringify(held));
    const fixture = child(h, "fixture");
    assert.ok(fixture, "fixture is still listed");
    assert.equal(fixture.process.state, "stopped");
    assert.equal(fixture.process.reason, "disabled");
    assert.equal(run(h, ["plugin", "list"]).items.find((i: any) => i.name === "fixture")?.state, "installed");

    // Enabling fixture again brings both back.
    assert.equal(run(h, ["plugin", "enable", "fixture", "--yes"]).state, "enabled");
    await ready(h, "fixture");
    await ready(h, "fixture-b");
  });

  it("uninstall keeps data and config, purge removes them after its own confirmation, restore brings the item back disabled", async () => {
    const h = await fresh();
    // A skill: uninstall moves it to the trash, restore brings it back disabled.
    run(h, ["skill", "install", fxs().path("signed-skill.p1x"), "--yes"]);
    const u = run(h, ["skill", "uninstall", "demo-skill", "--yes"]);
    assert.equal(u.schema, "skill.uninstall/1");
    assert.equal(u.purged, false);
    assert.ok(typeof u.trashId === "string" && u.trashId.length > 0, JSON.stringify(u));
    assert.equal(readIndex(h).skills.some((e) => e.id === "demo-skill"), false);
    const r = run(h, ["skill", "restore", u.trashId]);
    assert.equal(r.schema, "skill.restore/1");
    assert.equal(readIndex(h).skills.find((e) => e.id === "demo-skill")?.enabled, false);

    // A module: uninstall keeps its data directory and config section, and restore brings the item back disabled with
    // the section intact.
    run(h, ["plugin", "install", fxs().path("module-fixture.p1x"), "--yes"]);
    run(h, ["config", "set", "modules.fixture.greeting", "\"hello\"", "--yes"]);
    mkdirSync(join(h, "data", "ext", "fixture"), { recursive: true });
    const marker = join(h, "data", "ext", "fixture", "keep.txt");
    writeFileSync(marker, "kept\n");
    const greeting = (): unknown => JSON.parse(readFileSync(join(h, "config.json"), "utf8")).modules?.fixture?.greeting;
    const kept = run(h, ["plugin", "uninstall", "fixture", "--yes"]);
    assert.equal(kept.purged, false);
    assert.equal(readFileSync(marker, "utf8"), "kept\n");
    assert.equal(greeting(), "hello", "uninstall keeps the config section");
    const back = run(h, ["plugin", "restore", kept.trashId]);
    assert.equal(back.schema, "plugin.restore/1");
    assert.equal(run(h, ["plugin", "list"]).items.find((i: any) => i.name === "fixture")?.state, "installed");
    assert.equal(greeting(), "hello", "restore brings the config section back");
    assert.equal(readFileSync(marker, "utf8"), "kept\n");

    // Purge asks first: outside a terminal, without --yes it is refused and removes nothing; with --yes it removes both.
    const refused = run(h, ["plugin", "uninstall", "fixture", "--purge"], true);
    assert.ok("exit" in refused && refused.exit !== 0, "a purge without --yes must not run outside a terminal");
    assert.equal(readFileSync(marker, "utf8"), "kept\n");
    assert.equal(greeting(), "hello");
    assert.equal(run(h, ["plugin", "list"]).items.find((i: any) => i.name === "fixture")?.state, "installed");
    const purged = run(h, ["plugin", "uninstall", "fixture", "--purge", "--yes"]);
    assert.equal(purged.purged, true);
    assert.throws(() => readFileSync(marker), /ENOENT/);
    assert.equal(greeting(), undefined, "the purge removed the configuration section");
  });

  it("MCP versions stay immutable and a startup recovery restores an interrupted activation", async () => {
    const h = await fresh({ daemon: false });
    const install = (file: string) => run(h, ["plugin", "install", fxs().path(file), "--allow-unsigned", "--yes"]);
    const record = (): any => JSON.parse(readFileSync(join(h, "extensions", "state.json"), "utf8")).items["versioned-server"];
    const installed = install("mcp-server-v1.p1x");
    assert.equal(installed.schema, "plugin.install/1");
    assert.equal(installed.state, "installed");
    assert.equal(record().activeVersion, "1.0.0");
    const oldManifest = readFileSync(join(h, "mcp", "versioned-server", "1.0.0", "p1x.json"));
    assert.equal(record().manifestSha256, createHash("sha256").update(oldManifest).digest("hex"));
    const oldPayload = readFileSync(join(h, "mcp", "versioned-server", "1.0.0", "payload", "README.md"));
    assert.equal(install("mcp-server-v1.p1x").replaced, false, "the exact same version is idempotent");

    const interrupted = cli(h, ["plugin", "install", fxs().path("mcp-server-v2.p1x"), "--allow-unsigned", "--yes"], {
      env: { ...ENV(), PLUR1BUS_TEST_EXT_FAIL_AT: "kill:code" }, allowFail: true,
    });
    assert.ok("exit" in interrupted && interrupted.exit !== 0, "the commit interruption must reach the real binary");
    startDaemon(h, fxs().env);
    await ready(h, "core");
    assert.equal(record().activeVersion, "1.0.0");
    assert.equal(record().version, "1.0.0");
    assert.throws(() => lstatSync(join(h, "mcp", "versioned-server", "2.0.0")), /ENOENT/);
    assert.deepEqual(readFileSync(join(h, "mcp", "versioned-server", "1.0.0", "p1x.json")), oldManifest);

    const updated = install("mcp-server-v2.p1x");
    assert.equal(updated.version, "2.0.0");
    assert.equal(updated.replaced, true);
    assert.equal(updated.state, "installed");
    assert.equal(record().activeVersion, "2.0.0");
    assert.equal(record().version, "2.0.0");
    assert.equal(record().previousVersion, "1.0.0");
    assert.deepEqual(Object.keys(record().versions).sort(), ["1.0.0", "2.0.0"]);
    for (const version of ["1.0.0", "2.0.0"]) {
      assert.ok(lstatSync(join(h, "mcp", "versioned-server", version, "record.json")).isFile());
    }
    assert.deepEqual(readFileSync(join(h, "mcp", "versioned-server", "1.0.0", "payload", "README.md")), oldPayload);
    assert.throws(() => lstatSync(join(h, "extensions", "packages", "versioned-server")), /ENOENT/);
    const beforeConflict = treeHash(h);
    const conflict = fail(h, ["plugin", "install", fxs().path("mcp-server-v2-conflict.p1x"), "--allow-unsigned", "--yes"]);
    assert.equal(conflict.doc.error, "E_CONFLICT");
    assert.equal(conflict.doc.reason, "version-conflict");
    assert.equal(treeHash(h), beforeConflict);
  });

  it("a selected bundle toggles together, reports optional partial state and restores every selected member disabled", async () => {
    const h = await fresh();
    const inspection = run(h, ["ext", "inspect", fxs().path("bundle.p1x")]);
    assert.equal(inspection.manifest.kind, "bundle");
    assert.deepEqual(inspection.members.map((member: any) => [member.name, member.optional]).sort(),
      [["bundle-extra", true], ["bundle-required", false]]);
    const required = fail(h, ["plugin", "install", fxs().path("bundle.p1x"), "--member", "bundle-extra", "--allow-unsigned", "--yes"]);
    assert.notEqual(required.exit, 0);
    assert.equal(readIndex(h).skills.length, 0, "a missing required member must write no children");
    const installed = run(h, ["plugin", "install", fxs().path("bundle.p1x"), "--member", "bundle-required",
      "--member", "bundle-extra", "--allow-unsigned", "--yes"]);
    assert.equal(installed.state, "installed");
    const entries = () => readIndex(h).skills.filter(entry => entry.id.startsWith("bundle-"));
    assert.deepEqual(entries().map(entry => [entry.id, entry.enabled]).sort(),
      [["bundle-extra", false], ["bundle-required", false]]);
    const show = () => run(h, ["plugin", "show", "fixture-bundle"]);
    const detail = show();
    assert.match(detail.consentSha256, /^[a-f0-9]{64}$/);
    assert.equal(detail.memberInspections.length, 2);
    assert.deepEqual(detail.item.members.map((member: any) => member.name).sort(), ["bundle-extra", "bundle-required"]);
    assert.equal(run(h, ["plugin", "enable", "fixture-bundle", "--agent", "bernd", "--yes"]).state, "enabled");
    assert.equal(entries().every(entry => entry.enabled), true);
    for (const name of ["bundle-required", "bundle-extra"]) {
      assert.ok(run(h, ["skill", "list", "--agent", "bernd"]).items.some((item: any) => item.name === name));
      assert.equal(run(h, ["skill", "list", "--agent", "anna"]).items.some((item: any) => item.name === name), false);
    }
    const childRefusal = fail(h, ["skill", "disable", "bundle-required", "--yes"]);
    assert.equal(childRefusal.doc.reason, "bundle-member");
    run(h, ["skill", "disable", "bundle-extra", "--yes"]);
    assert.equal(show().item.partial, true);
    assert.equal(show().consentSha256, detail.consentSha256, "runtime toggles must not alter the approved member identity");
    run(h, ["plugin", "disable", "fixture-bundle", "--yes"]);
    assert.equal(entries().every(entry => !entry.enabled), true);
    assert.equal(show().item.partial, false);
    const removed = run(h, ["plugin", "uninstall", "fixture-bundle", "--yes"]);
    assert.equal(entries().length, 0);
    run(h, ["plugin", "restore", removed.trashId]);
    assert.deepEqual(entries().map(entry => [entry.id, entry.enabled]).sort(),
      [["bundle-extra", false], ["bundle-required", false]]);
    assert.equal(show().item.state, "installed");
  });

  it("a first-party bundle still requires unsigned child consent before activating the whole selected group", async () => {
    const h = await fresh();
    const before = treeHash(h);
    const refused = fail(h, ["plugin", "install", fxs().path("first-party-bundle.p1x"), "--yes"]);
    assert.equal(refused.doc.error, "E_APPROVAL_REQUIRED");
    assert.equal(refused.doc.reason, "acknowledge-unsigned");
    assert.equal(treeHash(h), before);
    const installed = run(h, ["plugin", "install", fxs().path("first-party-bundle.p1x"), "--enable=bernd", "--allow-unsigned", "--yes"]);
    assert.equal(installed.state, "enabled");
    const detail = run(h, ["plugin", "show", "fixture-bundle"]);
    assert.equal(detail.item.trust, "first-party");
    assert.equal(detail.memberInspections.every((member: any) => member.trust.tier === "unsigned"), true);
    for (const agent of ["bernd", "anna"]) {
      assert.deepEqual(run(h, ["skill", "list", "--agent", agent]).items.map((item: any) => item.name).sort(),
        ["bundle-extra", "bundle-required"]);
    }
  });

  it("every tampered variant is refused with its reason and skills/, modules/, extensions/ and config.json stay byte-identical", async () => {
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
    // Through the running supervisor (skill install) and offline, with no daemon (plugin install: the same audit runs
    // before the kind is looked at).
    for (const [online, verb] of [[true, "skill"], [false, "plugin"]] as const) {
      const h = await fresh({ daemon: online });
      const before = treeHash(h);
      for (const [slug, reason] of Object.entries(expected)) {
        const r = fail(h, [verb, "install", fxs().path(`tampered-${slug}.p1x`), "--yes"]);
        assert.equal(r.doc.schema, "error/1", `${online} ${slug}: ${JSON.stringify(r.doc)}`);
        assert.equal(r.doc.reason, reason, `${online} ${slug}: ${JSON.stringify(r.doc)}`);
        assert.notEqual(r.exit, 0, slug);
        assert.equal(treeHash(h), before, `${online} ${slug}: the tree changed`);
      }
    }
  });
});
