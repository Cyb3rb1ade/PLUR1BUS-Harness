/** Both source families use the real bounded SFTP reader, never local paths that happen to have the same names. */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { before, test } from "node:test";
import { createSftpFs } from "@plur1bus/remote-fs";
import { othersInDacl, parseWhoamiSid, savedSddlLine, systemTool } from "@plur1bus/module-api";
import { buildNative, fixture } from "../../../remote-fs/test/native-fixture.ts";
import { readSource, type SourceOptions } from "../../src/import/source.ts";
import { createSnapshot, type CreateSnapshotOptions } from "../../src/import/snapshot.ts";
import { lanceStore } from "./fixtures.ts";
import { treeDigest } from "./tree.ts";
import { discoverReaderSources } from "../../src/import/reader-discovery.ts";
import { importOpenclaw } from "../../src/import/importers/openclaw.ts";
import { importHermes } from "../../src/import/importers/hermes.ts";

before(buildNative, { timeout: 900_000 });
const marker = "SOURCE-CREDENTIAL-MUST-NOT-PERSIST";

async function sourceFixture(readDelayMs = 0) {
  const host = await fixture("harness", readDelayMs);
  const home = join(host.root, "target");
  await mkdir(home);
  const first = join(host.root, "first-home");
  await mkdir(join(first, "state"));
  await mkdir(join(first, "skills", "remote-skill"), { recursive: true });
  await writeFile(join(first, "skills", "remote-skill", "SKILL.md"), "---\nname: Remote skill\n---\nPublic instructions\n");
  await writeFile(join(first, "skills", "remote-skill", "runner"), "public executable content\n");
  await chmod(join(first, "skills", "remote-skill", "runner"), 0o755);
  await writeFile(join(first, "skills", "remote-skill", "id_ed25519"), marker);
  await writeFile(join(first, ".env"), `TOKEN=${marker}\n`);
  await mkdir(join(first, "workspace"));
  await writeFile(join(first, "workspace", "SOUL.md"), "First public persona\n");
  await writeFile(join(first, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
    models: { provider: { apiKey: marker } } }));
  const firstDb = new DatabaseSync(join(first, "state", "openclaw.sqlite"));
  firstDb.exec("CREATE TABLE schema_meta(meta_key TEXT, schema_version INTEGER); INSERT INTO schema_meta VALUES('primary',17)");
  firstDb.close();
  await lanceStore(join(first, "memory", "lancedb-namespaced", "main"), 2, 1);
  const second = join(host.root, "second-home");
  await writeFile(join(second, "config.yaml"), `_config_version: 45\nprovider:\n  api_key: ${marker}\n`);
  await writeFile(join(second, "SOUL.md"), "Second public persona\n");
  await mkdir(join(second, "skills", "second-skill"), { recursive: true });
  await writeFile(join(second, "skills", "second-skill", "SKILL.md"), "Second public skill\n");
  const secondDb = new DatabaseSync(join(second, "state.db"));
  secondDb.exec("CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(30)");
  secondDb.close();
  const session = await createSftpFs(host.options);
  return { host, home, session };
}

test("async source readers inspect nested skills, SQLite and Lance for both real SFTP source families", { timeout: 900_000 }, async () => {
  const { host, home, session } = await sourceFixture();
  const digest = treeDigest(join(host.root, "first-home"));
  try {
    const first = await readSource({ home, sourceType: "openclaw", source: "/first-home", env: {},
      reader: { fs: session.fs, root: "/", remote: true } } as SourceOptions);
    assert.equal(first.report.version.stateSchema, 17);
    assert.equal(first.report.plur1bus.stores[0]?.rows, 1);
    assert.equal(first.skills[0]?.id, "remote-skill");
    assert.equal(first.skills[0]?.skipped.secretFiles, 1);
    if (process.platform !== "win32") assert.equal(first.skills[0]?.hasScripts, true);
    assert.ok(!JSON.stringify(first.report).includes(marker));
    const second = await readSource({ home, sourceType: "hermes", source: "/second-home", env: {},
      reader: { fs: session.fs, root: "/", remote: true } } as SourceOptions);
    assert.equal(second.report.version.sessionsSchema, 30);
    assert.equal(second.skills[0]?.id, "second-skill");
    assert.ok(!JSON.stringify(second.report).includes(marker));
    assert.equal(treeDigest(join(host.root, "first-home")), digest);
  } finally { await session.close(); await host.close(); }
});

test("createSnapshot uses the confined async reader and strips source credentials before sealing", async () => {
  const { host, home, session } = await sourceFixture();
  try {
    const result = await createSnapshot({ home, sourceType: "openclaw", source: "/first-home",
      reader: { fs: session.fs, root: "/", remote: true } } as CreateSnapshotOptions);
    if (process.platform !== "win32") assert.equal((await stat(result.stagingDir)).mode & 0o777, 0o700);
    else {
      const sid = parseWhoamiSid(execFileSync(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }));
      assert.ok(sid);
      const acl = join(host.root, "snapshot-acl.txt");
      execFileSync(systemTool("icacls.exe"), [result.stagingDir, "/save", acl], { windowsHide: true });
      const saved = savedSddlLine(await readFile(acl));
      assert.ok(saved && /D:P/.test(saved));
      assert.deepEqual(othersInDacl(saved, sid), []);
    }
    const config = await readFile(join(result.stagingDir, "openclaw.json"), "utf8");
    assert.ok(!config.includes(marker));
    assert.ok(!JSON.stringify(result.metadata).includes(marker));
    assert.ok(result.metadata.omittedConfigKeys?.some(entry => entry.path === "models.provider.apiKey"));
    assert.ok(result.metadata.omittedCredentials?.includes(".env"));
    await assert.rejects(readFile(join(result.stagingDir, ".env")), { code: "ENOENT" });
    await assert.rejects(readFile(join(result.stagingDir, "skills", "remote-skill", "id_ed25519")), { code: "ENOENT" });
    const local = await readSource({ home, sourceType: "openclaw", source: result.stagingDir, env: {} });
    assert.equal(local.report.version.stateSchema, 17);
    assert.ok(local.report.secrets.configKeys.some(entry => entry.path === "models.provider.apiKey"));
    if (process.platform !== "win32") assert.equal(local.skills[0]?.hasScripts, true, "private file modes must not hide source executable disclosure");
  } finally { await session.close(); await host.close(); }
});

test("a Windows host keeps SFTP access paths in the wire namespace for both source families", async () => {
  const { host, home, session } = await sourceFixture();
  try {
    for (const [sourceType, source] of [["openclaw", "/first-home"], ["hermes", "/second-home"]] as const) {
      const result = await readSource({ home, sourceType, source, platform: "win32", targetPlatform: "win32",
        reader: { fs: session.fs, root: "/", remote: true }, env: {} });
      assert.equal(result.report.source.root, source);
      assert.ok(result.skills.length > 0);
    }
  } finally { await session.close(); await host.close(); }
});

test("direct offline importer entity reads use the injected port and preserve source path reports", async () => {
  const { host, home, session } = await sourceFixture();
  try {
    const reader = { fs: session.fs, root: "/", remote: true };
    const first = await importOpenclaw({ home, source: "/first-home", env: {}, reader } as Parameters<typeof importOpenclaw>[0]);
    assert.equal(first.source.root, "/first-home");
    assert.ok(first.agents[0]?.files.some(file => file.sourceFile === "/first-home/workspace/SOUL.md" && file.bytes > 0));
    const second = await importHermes({ home, source: "/second-home", env: {}, reader } as Parameters<typeof importHermes>[0]);
    assert.equal(second.source.root, "/second-home");
    assert.ok(second.agents[0]?.files.some(file => file.sourceFile === "/second-home/SOUL.md" && file.bytes > 0));
    assert.ok(!JSON.stringify([first, second]).includes(marker));
  } finally { await session.close(); await host.close(); }
});

test("known-location discovery finds readable users without scanning unrelated trees or starting stopped WSL", async () => {
  const { host, home, session } = await sourceFixture();
  try {
    for (const [user, directory, config] of [["alice", ".openclaw", "openclaw.json"], ["bob", ".hermes", "config.yaml"]]) {
      await mkdir(join(host.root, "home", user!, directory!), { recursive: true });
      await writeFile(join(host.root, "home", user!, directory!, config!), "public marker");
    }
    await mkdir(join(host.root, "unrelated", "hidden", ".hermes"), { recursive: true });
    await writeFile(join(host.root, "unrelated", "hidden", ".hermes", "config.yaml"), marker);
    const listed: string[] = [];
    const fs = { ...session.fs, async readdir(path: string) { listed.push(path); return session.fs.readdir(path); } };
    const result = await discoverReaderSources({ reader: { fs, root: "/", remote: true },
      wslDistributions: [{ name: "StoppedFixture", state: "Stopped", version: 2, isDefault: false }] });
    assert.deepEqual(result.filter(item => item.kind === "source").map(item => item.path), ["/home/alice/.openclaw", "/home/bob/.hermes"]);
    assert.ok(result.some(item => item.path === "StoppedFixture" && item.reason === "stopped-not-probed"));
    assert.ok(!listed.some(path => path.startsWith("/unrelated")));
    assert.ok(!JSON.stringify(result).includes(marker));
  } finally { await session.close(); await host.close(); }
});

test("the selected descendant is resolved through the original confined authority", async () => {
  const { host, home, session } = await sourceFixture();
  const confined = await createSftpFs({ ...host.options, root: "/first-home" });
  try {
    await assert.rejects(readSource({ home, sourceType: "hermes", source: "/first-home/escape-parent",
      reader: { fs: confined.fs, root: "/first-home", remote: true } }), { reason: "path-denied" });
    await assert.rejects(createSnapshot({ home, sourceType: "hermes", source: "/first-home/escape-parent",
      reader: { fs: confined.fs, root: "/first-home", remote: true } }), { reason: "path-denied" });
  } finally { await confined.close(); await session.close(); await host.close(); }
});

test("source changes and file, total, depth and entry limits refuse snapshots and clean private partials", async () => {
  const { host, home, session } = await sourceFixture();
  try {
    for (const limits of [{ maxFileBytes: 8 }, { maxBytes: 8 }, { maxFiles: 1 }, { maxDepth: 1 }]) {
      const destination = join(home, "import", `limit-${Object.keys(limits)[0]}`, "snapshot");
      await assert.rejects(createSnapshot({ home, sourceType: "openclaw", source: "/first-home", stagingDir: destination,
        reader: { fs: session.fs, root: "/", remote: true }, ...limits }));
      await assert.rejects(stat(destination), { code: "ENOENT" });
    }
    let changed = false;
    const fs = { ...session.fs, async readFile(path: string, cap: number) {
      const bytes = await session.fs.readFile(path, cap);
      if (!changed && path.endsWith("SKILL.md")) {
        changed = true;
        await writeFile(join(host.root, "first-home", "skills", "remote-skill", "SKILL.md"), "changed source");
      }
      return bytes;
    } };
    const destination = join(home, "import", "changed", "snapshot");
    await assert.rejects(createSnapshot({ home, sourceType: "openclaw", source: "/first-home", stagingDir: destination,
      reader: { fs, root: "/", remote: true } }), { reason: "source-changed" });
    await assert.rejects(stat(destination), { code: "ENOENT" });
  } finally { await session.close(); await host.close(); }
});

test("snapshot deadlines and aborts stop pending reads and remove partial local output", async () => {
  const { host, home, session } = await sourceFixture(3000);
  try {
    const destination = join(home, "import", "deadline", "snapshot");
    const started = Date.now();
    await assert.rejects(createSnapshot({ home, sourceType: "openclaw", source: "/first-home", stagingDir: destination,
      timeoutMs: 500, reader: { fs: session.fs, root: "/", remote: true } }), { reason: "timeout" });
    assert.ok(Date.now() - started < 2000);
    await assert.rejects(stat(destination), { code: "ENOENT" });
    const abort = new AbortController();
    abort.abort(new Error("PRIVATE-ABORT-DETAIL"));
    await assert.rejects(createSnapshot({ home, sourceType: "openclaw", source: "/first-home", signal: abort.signal,
      reader: { fs: session.fs, root: "/", remote: true } }), { reason: "aborted", message: "Source read was stopped" });
  } finally { await session.close(); await host.close(); }
});

test("snapshot selection refuses markerless roots before traversal and linked local destinations", async () => {
  const { host, home, session } = await sourceFixture();
  try {
    let listings = 0;
    const fs = { ...session.fs, async readdir(path: string) { listings++; return session.fs.readdir(path); } };
    await assert.rejects(createSnapshot({ home, sourceType: "openclaw", source: "/", reader: { fs, root: "/", remote: true } }),
      { reason: "source-marker-missing" });
    assert.equal(listings, 0);
    const outside = join(host.root, "outside-destination");
    await mkdir(outside);
    await symlink(outside, join(home, "import"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(createSnapshot({ home, sourceType: "openclaw", source: "/first-home",
      reader: { fs: session.fs, root: "/", remote: true } }), { reason: "snapshot-location-invalid" });
    assert.deepEqual(await (await import("node:fs/promises")).readdir(outside), []);
  } finally { await session.close(); await host.close(); }
});
