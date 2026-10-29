// The packaged producer uses the real shared snapshot copier, with disposable source and destination trees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { treeDigest } from "../../../packages/core/test/import/tree.ts";
import { writeDesktopSourceConfig } from "../../../packages/core/test/import/desktop-source-fixture.ts";

test("host snapshot creates the shared manifest, omits credential files and returns no source paths", () => {
  const root = mkdtempSync(join(tmpdir(), "p1b-desktop-source-"));
  try {
    const source = join(root, "source"); const home = join(root, "host");
    mkdirSync(source); mkdirSync(home);
    const sourceType = writeDesktopSourceConfig(source);
    writeFileSync(join(source, ".env"), "TOKEN=DESKTOP_HOST_SECRET_MARKER\n");
    writeFileSync(join(source, "SOUL.md"), "Host persona\n");
    const before = treeDigest(source);
    const stagingDir = join(home, "snapshot");
    const child = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./import-snapshot.ts", import.meta.url))], {
      input: JSON.stringify({ schema: "desktop.import-snapshot/1", sourceType, sourceRoot: source,
        home, stagingDir, allowLiveCopy: false }), encoding: "utf8", timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.schema, "desktop.import-snapshot-result/1");
    assert.equal(result.ok, true);
    assert.ok(result.fileCount >= 2);
    assert.ok(result.bytes > 0);
    const archive = gunzipSync(readFileSync(join(home, "snapshot.tar.gz")));
    assert.equal(archive.includes(Buffer.from("DESKTOP_HOST_SECRET_MARKER")), false);
    assert.equal(archive.includes(Buffer.from("Host persona")), true);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(result).includes(root), false);
    assert.equal(child.stdout.includes("DESKTOP_HOST_SECRET_MARKER"), false);
    assert.equal(existsSync(join(stagingDir, ".env")), false);
    const manifest = JSON.parse(readFileSync(join(stagingDir, "snapshot.json"), "utf8"));
    assert.equal(manifest.version, 1);
    assert.ok(manifest.omittedCredentials.includes(".env"));
    assert.equal(readFileSync(join(stagingDir, "SOUL.md"), "utf8"), "Host persona\n");
    assert.equal(treeDigest(source), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
