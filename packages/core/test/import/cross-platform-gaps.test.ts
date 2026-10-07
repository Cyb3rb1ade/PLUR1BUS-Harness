import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempDir } from "../helpers/temp-dir.ts";
import { targetIdentity } from "../../src/import/identity.ts";
import { detectHermes } from "../../src/import/sources/hermes.ts";
import { detectOpenclaw } from "../../src/import/sources/openclaw.ts";
import { readHermesCronJobs } from "../../src/import/importers/hermes-cron.ts";
import { readHermesPairings } from "../../src/import/importers/hermes-platforms.ts";
import { createSnapshot } from "../../src/import/snapshot.ts";
import { listWslDistros } from "../../src/import/wsl.ts";

const context = (source: string) => {
  const home = tempDir("p1b-cross-home-");
  return { source, home, env: {}, homedir: home, target: targetIdentity(home) };
};

for (const encoding of ["utf8", "utf16le", "utf16be"] as const) {
  const encode = (text: string) => encoding === "utf8"
    ? Buffer.from(`\ufeff${text}`, "utf8")
    : encoding === "utf16le" ? Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, "utf16le")])
      : Buffer.concat([Buffer.from([254, 255]), Buffer.from(text, "utf16le").swap16()]);
  test(`source configs accept ${encoding} BOM and CRLF without source writes`, async () => {
    const source = tempDir("p1b-cross-config-");
    const yaml = encode("_config_version: 45\r\n");
    writeFileSync(join(source, "config.yaml"), yaml);
    const hermes = await detectHermes({ ...context(source), sourceType: "hermes" });
    assert.equal(hermes.version.configVersion, 45);
    assert.deepEqual(readFileSync(join(source, "config.yaml")), yaml);
    writeFileSync(join(source, "openclaw.json"), encode('{"meta":{"lastTouchedVersion":"2026.3.1"}}\r\n'));
    const claw = await detectOpenclaw({ ...context(source), sourceType: "openclaw" });
    assert.equal(claw.version.release, "2026.3.1");
  });
}

test("malformed optional JSON is reported per element without leaking parser input", () => {
  const source = tempDir("p1b-cross-json-");
  mkdirSync(join(source, "cron"));
  mkdirSync(join(source, "platforms", "pairing"), { recursive: true });
  writeFileSync(join(source, "cron", "jobs.json"), '{"FAKE_TOKEN": broken');
  writeFileSync(join(source, "platforms", "pairing", "bad-approved.json"), '{"FAKE_TOKEN": broken');
  writeFileSync(join(source, "platforms", "pairing", "good-approved.json"), '{"synthetic-user":{}}');
  const errors: Array<{ sourceRef: string; reason: string }> = [];
  readHermesCronJobs([{ agentId: "default", dir: source }], errors);
  assert.equal(readHermesPairings([source], errors).length, 1);
  assert.deepEqual(errors.map(e => e.reason), ["json-unparseable", "json-unparseable"]);
  assert.ok(!JSON.stringify(errors).includes("FAKE_TOKEN"));
});

test("WSL verbose metadata preserves distro names containing spaces", async () => {
  const distros = await listWslDistros(async cmd => ({
    stdout: Buffer.from(cmd.includes("-v") ? '* My Ubuntu    Running    1\r\n'
      : cmd.includes("--running") ? 'My Ubuntu\r\n' : 'My Ubuntu\r\n', "utf16le"),
    stderr: Buffer.alloc(0), exitCode: 0,
  }));
  assert.deepEqual(distros, [{ name: "My Ubuntu", state: "Running", version: 1, isDefault: true }]);
});

test("WAL-active SQLite snapshot consolidates committed rows into a standalone database", async () => {
  const source = tempDir("p1b-cross-wal-");
  const file = join(source, "state.db");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(x); INSERT INTO t VALUES (42)");
    assert.ok(existsSync(`${file}-wal`));
    const snapshot = await createSnapshot({ sourceType: "hermes", sourceRoot: source, home: tempDir("p1b-cross-home-"), allowLiveCopy: true });
    const copy = join(snapshot.stagingDir, "state.db");
    assert.ok(!existsSync(`${copy}-wal`), "snapshot must not depend on a separately copied WAL");
    assert.ok(!existsSync(`${copy}-shm`));
    const reader = new DatabaseSync(copy, { readOnly: true });
    try { assert.equal(reader.prepare("SELECT x FROM t").get()!.x, 42); }
    finally { reader.close(); }
  } finally { db.close(); }
});

test("snapshot refuses a destination inside its source and preserves pre-existing destinations", async () => {
  const source = tempDir("p1b-cross-nesting-");
  const home = tempDir("p1b-cross-home-");
  writeFileSync(join(source, "keep.txt"), "synthetic");
  await assert.rejects(createSnapshot({ sourceType: "hermes", sourceRoot: source, home, stagingDir: join(source, "nested") }), { reason: "snapshot-overlap" });
  const staging = tempDir("p1b-cross-existing-");
  writeFileSync(join(staging, "keep.txt"), "synthetic");
  await assert.rejects(createSnapshot({ sourceType: "hermes", sourceRoot: source, home, stagingDir: staging }), { reason: "snapshot-exists" });
  assert.equal(readFileSync(join(staging, "keep.txt"), "utf8"), "synthetic");
});

test("native snapshot enforces aggregate file and byte limits", async () => {
  const source = tempDir("p1b-cross-limits-");
  writeFileSync(join(source, "one.txt"), "1234");
  writeFileSync(join(source, "two.txt"), "5678");
  const home = tempDir("p1b-cross-home-");
  await assert.rejects(createSnapshot({ sourceType: "hermes", sourceRoot: source, home, maxFiles: 1 }), { reason: "too-many-files" });
  await assert.rejects(createSnapshot({ sourceType: "hermes", sourceRoot: source, home, maxBytes: 6 }), { reason: "too-many-bytes" });
});

test("a broken Hermes profile does not prevent detecting valid profiles", async () => {
  const source = tempDir("p1b-cross-profiles-");
  writeFileSync(join(source, "config.yaml"), "_config_version: 45\n");
  mkdirSync(join(source, "profiles", "broken"), { recursive: true });
  writeFileSync(join(source, "profiles", "broken", "config.yaml"), Buffer.from([255, 254, 0]));
  const report = await detectHermes({ ...context(source), sourceType: "hermes" });
  assert.deepEqual(report.agents.map(a => a.agentId), ["default"]);
  assert.ok(report.warnings.some(w => w.includes("invalid-text-encoding")));
});

test("snapshot manifest traversal and content tampering fail closed before source reads", async () => {
  const { readSource } = await import("../../src/import/source.ts");
  const source = tempDir("p1b-cross-manifest-");
  writeFileSync(join(source, "config.yaml"), "_config_version: 45\n");
  const home = tempDir("p1b-cross-home-");
  const snap = await createSnapshot({ sourceType: "hermes", sourceRoot: source, home });
  const manifest = join(snap.stagingDir, "snapshot.json");
  const original = readFileSync(manifest, "utf8");
  const meta = JSON.parse(original);
  meta.files[0].path = "../outside";
  writeFileSync(manifest, JSON.stringify(meta));
  await assert.rejects(readSource({ sourceType: "hermes", source: snap.stagingDir, home, env: {} }), { reason: "snapshot-path-traversal" });
  writeFileSync(manifest, original);
  writeFileSync(join(snap.stagingDir, "config.yaml"), "_config_version: 44\n");
  await assert.rejects(readSource({ sourceType: "hermes", source: snap.stagingDir, home, env: {} }), { reason: "snapshot-content-mismatch" });
});

test("WSL probe enumerates multiple homes with NUL-separated records", async () => {
  const { probeWslDistro } = await import("../../src/import/wsl.ts");
  const candidates = await probeWslDistro({ name: "Ubuntu", state: "Running", version: 2, isDefault: true }, {
    runner: async () => ({ stdout: Buffer.from("HOME=/home/alice\0OPENCLAW=/home/alice/.openclaw\0HOME=/home/bob\0HERMES=/home/bob/.hermes\0"), stderr: Buffer.alloc(0), exitCode: 0 }),
  });
  assert.deepEqual(candidates.map(c => [c.sourceType, c.sourceHome, c.accessRoot]), [
    ["openclaw", "/home/alice", "\\\\wsl.localhost\\Ubuntu\\home\\alice\\.openclaw"],
    ["hermes", "/home/bob", "\\\\wsl.localhost\\Ubuntu\\home\\bob\\.hermes"],
  ]);
});

test("snapshots omit conventional credential files and preserve key names only", async () => {
  const source = tempDir("p1b-cross-creds-");
  writeFileSync(join(source, ".env"), "SYNTHETIC_API_KEY=FAKE_TOKEN\n");
  writeFileSync(join(source, "auth.json"), '{"access_token":"FAKE_TOKEN"}');
  writeFileSync(join(source, "auth-profiles.json"), '{"token":"FAKE_TOKEN"}');
  const snap = await createSnapshot({ sourceType: "hermes", sourceRoot: source, home: tempDir("p1b-cross-home-") });
  for (const file of [".env", "auth.json", "auth-profiles.json"]) assert.ok(!existsSync(join(snap.stagingDir, file)));
  assert.deepEqual(snap.metadata.envKeys[".env"], ["SYNTHETIC_API_KEY"]);
  assert.ok(!JSON.stringify(snap.metadata).includes("FAKE_TOKEN"));
});

test("native snapshot reports invalid UTF-8 names without confusing them with replacement characters", { skip: process.platform === "win32" }, async (t) => {
  const source = tempDir("p1b-cross-filename-");
  try { writeFileSync(Buffer.concat([Buffer.from(source + "/"), Buffer.from([0xff])]), "synthetic"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EILSEQ") { t.skip("filesystem requires valid Unicode names"); return; }
    throw error;
  }
  const snap = await createSnapshot({ sourceType: "hermes", sourceRoot: source, home: tempDir("p1b-cross-home-") });
  assert.equal(snap.metadata.files.length, 0);
  assert.ok(JSON.stringify(snap.metadata).includes("invalid-filename-encoding"));
});

test("OpenClaw snapshot plan matches apply and a second apply adds no duplicates", async () => {
  const { importOpenclaw } = await import("../../src/import/importers/openclaw.ts");
  const { treeDigest } = await import("./tree.ts");
  const source = tempDir("p1b-cross-roundtrip-");
  mkdirSync(join(source, "workspace"));
  writeFileSync(join(source, "workspace", "SOUL.md"), "Synthetic persona\n");
  writeFileSync(join(source, "openclaw.json"), '{"meta":{"lastTouchedVersion":"2026.3.1"}}');
  const home = tempDir("p1b-cross-home-");
  const snap = await createSnapshot({ sourceType: "openclaw", sourceRoot: source, home });
  // Remove original content to prove that every import read uses the snapshot.
  writeFileSync(join(source, "workspace", "SOUL.md"), "changed after snapshot\n");
  const before = treeDigest(snap.stagingDir);
  const preview = await importOpenclaw({ source: snap.stagingDir, home, env: {} });
  const applied = await importOpenclaw({ source: snap.stagingDir, home, env: {}, apply: true });
  assert.deepEqual(preview.agents.map(a => [a.harnessAgentId, a.action, a.files]), applied.agents.map(a => [a.harnessAgentId, a.action, a.files]));
  const second = await importOpenclaw({ source: snap.stagingDir, home, env: {}, apply: true });
  assert.equal(second.counts.agentsCreated, 0);
  assert.equal(second.counts.filesCreated, 0);
  assert.ok(second.counts.filesMatched > 0);
  assert.equal(treeDigest(snap.stagingDir), before);
});

test("malformed YAML in one Hermes profile is a typed skip", async () => {
  const source = tempDir("p1b-cross-yaml-");
  writeFileSync(join(source, "config.yaml"), "_config_version: 45\n");
  mkdirSync(join(source, "profiles", "broken"), { recursive: true });
  writeFileSync(join(source, "profiles", "broken", "config.yaml"), "_config_version: 45\nFAKE_TOKEN missing colon\n");
  const report = await detectHermes({ ...context(source), sourceType: "hermes" });
  assert.deepEqual(report.agents.map(a => a.agentId), ["default"]);
  assert.deepEqual(report.errors, [{ sourceRef: "profiles/broken/config.yaml", reason: "yaml-unparseable" }]);
  assert.ok(!JSON.stringify(report).includes("FAKE_TOKEN"));
});

test("Hermes snapshot dry-run and apply agree; repeated apply converges", async () => {
  const { importHermes } = await import("../../src/import/importers/hermes.ts");
  const source = tempDir("p1b-cross-hermes-roundtrip-");
  writeFileSync(join(source, "config.yaml"), "_config_version: 45\n");
  writeFileSync(join(source, "SOUL.md"), "Synthetic persona\n");
  const home = tempDir("p1b-cross-home-");
  const snap = await createSnapshot({ sourceType: "hermes", sourceRoot: source, home });
  // No cards in this fixture: the injected engine must never be called.
  const engine = { memory: { import: () => { throw new Error("unexpected memory import"); } } } as any;
  const options = { home, source: snap.stagingDir, env: {}, engine };
  const preview = await importHermes(options);
  const applied = await importHermes({ ...options, apply: true });
  assert.deepEqual(preview.agents.map(a => [a.harnessAgentId, a.action, a.files]), applied.agents.map(a => [a.harnessAgentId, a.action, a.files]));
  const second = await importHermes({ ...options, apply: true });
  assert.equal(second.counts.agentsCreated, 0);
  assert.equal(second.counts.filesCreated, 0);
  assert.ok(second.counts.filesMatched > 0);
});

test("WSL tar rejects undecodable filenames instead of replacing their bytes", async () => {
  const { extractTarStream, packTarBuffer } = await import("../../src/import/snapshot.ts");
  const tar = packTarBuffer([{ path: "name", content: "synthetic" }]);
  tar[0] = 0xff;
  tar.fill(32, 148, 156);
  let checksum = 0;
  for (const byte of tar.subarray(0, 512)) checksum += byte;
  tar.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  await assert.rejects(extractTarStream(tar, tempDir("p1b-cross-tar-")), { reason: "invalid-filename-encoding" });
});

test("snapshot ignores host config and skill overrides outside its tree", async () => {
  const source = tempDir("p1b-cross-overrides-");
  writeFileSync(join(source, "openclaw.json"), '{"meta":{"lastTouchedVersion":"2026.3.1"}}');
  const home = tempDir("p1b-cross-home-");
  const external = tempDir("p1b-cross-external-");
  writeFileSync(join(external, "config.json"), '{"meta":{"lastTouchedVersion":"WRONG"}}');
  const snap = await createSnapshot({ sourceType: "openclaw", sourceRoot: source, home });
  const report = await detectOpenclaw({ sourceType: "openclaw", source: snap.stagingDir, home, homedir: home, target: targetIdentity(home), env: {
    OPENCLAW_CONFIG_PATH: join(external, "config.json"), OPENCLAW_BUNDLED_SKILLS_DIR: external,
  } });
  assert.equal(report.version.release, "2026.3.1");
  assert.ok(report.skillRoots.every(root => root.dir !== external));
});
