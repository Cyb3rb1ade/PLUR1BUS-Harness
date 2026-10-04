import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { detect } from "../../src/import/detect.ts";
import {
  createSnapshot,
  extractTarStream,
  packTarBuffer,
} from "../../src/import/snapshot.ts";
import { ImportError } from "../../src/import/types.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { buildLayout, type Layout } from "./layouts.ts";

describe("snapshot — tar extractor security and boundaries (G6)", { timeout: 15_000 }, () => {
  it("rejects path traversal ('..') entries", async () => {
    const staging = tempDir("p1b-snap-test-");
    const tar = packTarBuffer([{ path: "../evil.txt", content: "evil" }]);
    await assert.rejects(
      () => extractTarStream(tar, staging),
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_TAR_SECURITY");
        assert.equal(err.reason, "path-traversal");
        assert.ok(!existsSync(staging), "staging dir must be cleaned up on failure");
        return true;
      }
    );
  });

  it("rejects absolute path entries", async () => {
    const staging = tempDir("p1b-snap-test-");
    const tar = packTarBuffer([{ path: "/etc/passwd", content: "root:x:0:0" }]);
    await assert.rejects(
      () => extractTarStream(tar, staging),
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_TAR_SECURITY");
        assert.equal(err.reason, "absolute-path");
        assert.ok(!existsSync(staging), "staging dir must be cleaned up on failure");
        return true;
      }
    );
  });

  it("rejects symlinks that point outside the staging directory", async () => {
    const staging = tempDir("p1b-snap-test-");
    const tar = packTarBuffer([
      { path: "link-to-outside", typeflag: "2", linkname: "../../etc/passwd" },
    ]);
    await assert.rejects(
      () => extractTarStream(tar, staging),
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_TAR_SECURITY");
        assert.equal(err.reason, "symlink-escape");
        assert.ok(!existsSync(staging), "staging dir must be cleaned up on failure");
        return true;
      }
    );
  });

  it("rejects character devices, block devices, and FIFOs", async () => {
    for (const [typeflag, desc] of [["3", "char-dev"], ["4", "block-dev"], ["6", "fifo"]] as const) {
      const staging = tempDir("p1b-snap-test-");
      const tar = packTarBuffer([{ path: `dev-${desc}`, typeflag }]);
      await assert.rejects(
        () => extractTarStream(tar, staging),
        (err: any) => {
          assert.ok(err instanceof ImportError);
          assert.equal(err.code, "E_TAR_SECURITY");
          assert.equal(err.reason, "forbidden-device");
          assert.ok(!existsSync(staging));
          return true;
        }
      );
    }
  });

  it("enforces max files cap", async () => {
    const staging = tempDir("p1b-snap-test-");
    const tar = packTarBuffer([
      { path: "file1.txt", content: "1" },
      { path: "file2.txt", content: "2" },
      { path: "file3.txt", content: "3" },
    ]);
    await assert.rejects(
      () => extractTarStream(tar, staging, { maxFiles: 2 }),
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_LIMIT_EXCEEDED");
        assert.equal(err.reason, "too-many-files");
        assert.ok(!existsSync(staging));
        return true;
      }
    );
  });

  it("enforces max bytes cap", async () => {
    const staging = tempDir("p1b-snap-test-");
    const tar = packTarBuffer([
      { path: "file1.txt", content: Buffer.alloc(100) },
      { path: "file2.txt", content: Buffer.alloc(200) },
    ]);
    await assert.rejects(
      () => extractTarStream(tar, staging, { maxBytes: 150 }),
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_LIMIT_EXCEEDED");
        assert.equal(err.reason, "too-large");
        assert.ok(!existsSync(staging));
        return true;
      }
    );
  });

  it("cleans up staging directory on a broken or truncated stream", async () => {
    const staging = tempDir("p1b-snap-test-");
    const validTar = packTarBuffer([
      { path: "valid.txt", content: "hello world" },
      { path: "truncated.txt", content: Buffer.alloc(1024, "A") },
    ]);
    // Truncate in the middle of truncated.txt payload
    const truncated = validTar.subarray(0, 512 + 512 + 512 + 100);
    await assert.rejects(
      () => extractTarStream(truncated, staging),
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_TAR_CORRUPT");
        assert.equal(err.reason, "stream-truncated");
        assert.ok(!existsSync(staging), "staging dir must be removed after truncated stream");
        return true;
      }
    );
  });
});

describe("snapshot — native copier and detect comparison (G6)", { timeout: 30_000 }, () => {
  let layout: Layout;
  let home: string;

  before(async () => {
    layout = await buildLayout("linux");
    home = tempDir("p1b-harness-home-");
  });

  after(() => {
    try { rmSync(layout.base, { recursive: true, force: true }); } catch {}
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  });

  it("creates a native snapshot and matches direct detect report", async () => {
    const directReport = await detect({
      sourceType: "openclaw",
      source: layout.openclawRoot,
      home,
      env: layout.env,
      homedir: layout.home,
    });

    const snap = await createSnapshot({
      sourceType: "openclaw",
      sourceRoot: layout.openclawRoot,
      home,
      env: layout.env,
      homedir: layout.home,
    });

    assert.ok(existsSync(snap.stagingDir));
    const metaFile = join(snap.stagingDir, "snapshot.json");
    assert.ok(existsSync(metaFile));

    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    assert.equal(meta.version, 1);
    assert.equal(meta.origin, "native");
    assert.ok(meta.files.length > 0);

    // Assert no secret values in snapshot.json
    const metaStr = JSON.stringify(meta);
    assert.ok(!metaStr.includes("fake-token"), "secrets must not leak into snapshot.json");
    assert.ok(meta.envKeys[".env"]);
    assert.deepEqual(meta.envKeys[".env"], ["OPENAI_API_KEY"]);

    // Run detect against the snapshot
    const snapReport = await detect({
      sourceType: "openclaw",
      source: snap.stagingDir,
      home,
      env: layout.env,
      homedir: layout.home,
    });

    // Both reports should find the exact same number of agents and skills
    assert.equal(snapReport.agents.length, directReport.agents.length);
    assert.deepEqual(
      snapReport.agents.map((a) => a.agentId).sort(),
      directReport.agents.map((a) => a.agentId).sort()
    );

    assert.equal(snapReport.skills.length, directReport.skills.length);
    assert.deepEqual(
      snapReport.skills.map((s) => s.id).sort(),
      directReport.skills.map((s) => s.id).sort()
    );

    // Planned actions should match
    assert.deepEqual(
      snapReport.skills.map((s) => ({ id: s.id, action: s.plannedAction, problems: s.problems })).sort((a, b) => a.id.localeCompare(b.id)),
      directReport.skills.map((s) => ({ id: s.id, action: s.plannedAction, problems: s.problems })).sort((a, b) => a.id.localeCompare(b.id))
    );

    // Clean up snapshot staging dir
    rmSync(snap.stagingDir, { recursive: true, force: true });
  });
});

describe("snapshot — running source and live copy (C7)", { timeout: 15_000 }, () => {
  it("fails with E_SOURCE_BUSY when a database changes during copy without --allow-live-copy", async () => {
    const dir = tempDir("p1b-busy-sqlite-");
    const dbPath = join(dir, "live.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");

    const home = tempDir("p1b-harness-");

    try {
      await assert.rejects(
        () =>
          createSnapshot({
            sourceType: "openclaw",
            sourceRoot: dir,
            home,
            allowLiveCopy: false,
            afterCopy: () => {
              // Deterministically mutate source db during the copy
              db.exec("INSERT INTO t VALUES (2);");
            },
          }),
        (err: any) => {
          assert.ok(err instanceof ImportError);
          assert.equal(err.code, "E_SOURCE_BUSY");
          assert.equal(err.reason, "source-running");
          return true;
        }
      );
    } finally {
      db.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });

  it("handles live copy with --allow-live-copy without hanging", async () => {
    const dir = tempDir("p1b-busy-sqlite-");
    const dbPath = join(dir, "live.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");

    const home = tempDir("p1b-harness-");

    let writes = 0;
    const interval = setInterval(() => {
      try {
        db.exec(`INSERT INTO t VALUES (${++writes});`);
      } catch {}
    }, 15);

    try {
      const snap = await createSnapshot({
        sourceType: "openclaw",
        sourceRoot: dir,
        home,
        allowLiveCopy: true,
      });

      assert.ok(existsSync(snap.stagingDir));
      assert.ok(snap.metadata.sqlite["live.sqlite"]);
      // Should record either copy or source-busy, never hang
      const status = snap.metadata.sqlite["live.sqlite"]!.status;
      assert.ok(status === "copy" || status === "source-busy");
      rmSync(snap.stagingDir, { recursive: true, force: true });
    } finally {
      clearInterval(interval);
      db.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("snapshot — WSL tar stream with injected runner (G5, G6)", { timeout: 15_000 }, () => {
  it("extracts WSL tar stream through runner and emits snapshot.json", async () => {
    const tarBuf = packTarBuffer([
      { path: "openclaw.json", content: JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" }, agents: { list: [{ id: "wsl-agent" }] } }) },
      { path: "skills/test-skill/SKILL.md", content: "---\nname: test-skill\n---\n" },
      { path: ".env", content: "TEST_SECRET=12345\n" },
    ]);

    const mockWslRunner = async (cmd: string[]) => {
      assert.equal(cmd[0], "wsl.exe");
      assert.equal(cmd[1], "-d");
      assert.equal(cmd[2], "Ubuntu-24.04");
      assert.equal(cmd[4], "tar");
      return { stdout: tarBuf, stderr: Buffer.alloc(0), exitCode: 0 };
    };

    const home = tempDir("p1b-wsl-snap-home-");
    const snap = await createSnapshot({
      sourceType: "openclaw",
      sourceRoot: "wsl:Ubuntu-24.04:/home/ubuntu/.openclaw",
      home,
      wslRunner: mockWslRunner,
    });

    assert.ok(existsSync(snap.stagingDir));
    const metaFile = join(snap.stagingDir, "snapshot.json");
    assert.ok(existsSync(metaFile));

    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    assert.equal(meta.version, 1);
    assert.equal(meta.origin, "wsl:Ubuntu-24.04");
    assert.equal(meta.flavour, "posix");
    assert.equal(meta.sourceRoot, "/home/ubuntu/.openclaw");
    assert.deepEqual(meta.envKeys[".env"], ["TEST_SECRET"]);

    const report = await detect({
      sourceType: "openclaw",
      source: snap.stagingDir,
      home,
      homedir: "/nonexistent-home",
    });

    assert.equal(report.agents.length, 1);
    assert.equal(report.agents[0]!.agentId, "wsl-agent");
    assert.equal(report.skills.length, 1);
    assert.equal(report.skills[0]!.id, "test-skill");

    rmSync(snap.stagingDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
});
