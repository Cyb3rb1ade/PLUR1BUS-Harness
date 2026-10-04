import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { detect } from "../../src/import/detect.ts";
import { locateSource } from "../../src/import/paths.ts";
import {
  copyLanceTableWithManifest,
  createSnapshot,
  extractTarStream,
  isSourceRunning,
  packTarBuffer,
  parseLanceManifestVersion,
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

  it("rejects all symlink entries and prevents symlink chain directory escapes (C1)", async () => {
    const parentDir = tempDir("p1b-snap-parent-");
    const staging = join(parentDir, "staging");
    mkdirSync(staging, { recursive: true });

    // Review reproduction chain: a -> ., then b -> a/.., then b/pwned.txt
    const tar = packTarBuffer([
      { path: "a", typeflag: "2", linkname: "." },
      { path: "b", typeflag: "2", linkname: "a/.." },
      { path: "b/pwned.txt", content: "pwned!" },
    ]);

    await assert.rejects(
      () => extractTarStream(tar, staging),
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_TAR_SECURITY");
        assert.equal(err.reason, "symlink-forbidden");
        assert.ok(!existsSync(staging), "staging dir must be cleaned up on failure");
        assert.ok(!existsSync(join(parentDir, "pwned.txt")), "must not write outside staging directory");
        return true;
      }
    );

    try { rmSync(parentDir, { recursive: true, force: true }); } catch {}
  });

  it("rejects hardlink entries (I1)", async () => {
    const staging = tempDir("p1b-snap-test-");
    const tar = packTarBuffer([
      { path: "hardlink-target", typeflag: "1", linkname: "../../etc/passwd" },
    ]);
    await assert.rejects(
      () => extractTarStream(tar, staging),
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_TAR_SECURITY");
        assert.equal(err.reason, "hardlink-forbidden");
        assert.ok(!existsSync(staging));
        return true;
      }
    );
  });

  it("rejects tar header with corrupted checksum (I1)", async () => {
    const staging = tempDir("p1b-snap-test-");
    const validTar = packTarBuffer([{ path: "valid.txt", content: "hello" }]);
    const corruptedTar = Buffer.from(validTar);
    // Mutate checksum field (bytes 148..156)
    corruptedTar.write("999999\0", 148);

    await assert.rejects(
      () => extractTarStream(corruptedTar, staging),
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_TAR_CORRUPT");
        assert.equal(err.reason, "invalid-checksum");
        assert.ok(!existsSync(staging));
        return true;
      }
    );
  });

  it("rejects tar stream without standard EOF zero blocks (I1)", async () => {
    const staging = tempDir("p1b-snap-test-");
    const validTar = packTarBuffer([{ path: "valid.txt", content: "hello" }]);
    // Slice off trailing 1024 zero bytes (EOF marker)
    const truncatedWithoutEof = validTar.subarray(0, validTar.length - 1024);

    await assert.rejects(
      () => extractTarStream(truncatedWithoutEof, staging),
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_TAR_CORRUPT");
        assert.equal(err.reason, "stream-truncated");
        assert.ok(!existsSync(staging));
        return true;
      }
    );
  });

  it("rejects unsupported or unknown typeflags (I1)", async () => {
    const staging = tempDir("p1b-snap-test-");
    // Typeflag '7' is contiguous file, 'S' is GNU sparse
    const tar = packTarBuffer([{ path: "contiguous.bin", typeflag: "7" }]);
    await assert.rejects(
      () => extractTarStream(tar, staging),
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_TAR_SECURITY");
        assert.equal(err.reason, "unsupported-typeflag");
        assert.ok(!existsSync(staging));
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

  it("enforces max bytes cap and aborts chunk streaming early (I2)", async () => {
    const staging = tempDir("p1b-snap-test-");
    const tar = packTarBuffer([
      { path: "file1.txt", content: Buffer.alloc(100) },
      { path: "file2.txt", content: Buffer.alloc(200) },
    ]);

    // Stream chunks as an async iterable
    async function* chunkStream(): AsyncIterable<Buffer> {
      const chunkSize = 128;
      for (let i = 0; i < tar.length; i += chunkSize) {
        yield tar.subarray(i, i + chunkSize);
      }
    }

    await assert.rejects(
      () => extractTarStream(chunkStream(), staging, { maxBytes: 150 }),
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

describe("snapshot — PID file running detection (I3, C7)", { timeout: 15_000 }, () => {
  it("detects live PID in gateway.pid and refuses snapshot without --allow-live-copy", async () => {
    const dir = tempDir("p1b-running-src-");
    const home = tempDir("p1b-harness-");
    try {
      // Current process is guaranteed alive
      writeFileSync(join(dir, "gateway.pid"), String(process.pid) + "\n", "utf8");
      const check = isSourceRunning(dir);
      assert.equal(check.running, true);
      assert.equal(check.pid, process.pid);

      await assert.rejects(
        () => createSnapshot({ sourceType: "openclaw", sourceRoot: dir, home, allowLiveCopy: false }),
        (err: any) => {
          assert.ok(err instanceof ImportError);
          assert.equal(err.code, "E_SOURCE_BUSY");
          assert.equal(err.reason, "source-running");
          return true;
        }
      );

      // With --allow-live-copy it proceeds
      const snap = await createSnapshot({ sourceType: "openclaw", sourceRoot: dir, home, allowLiveCopy: true });
      assert.ok(existsSync(snap.stagingDir));
      rmSync(snap.stagingDir, { recursive: true, force: true });
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });

  it("ignores dead PID in pid file", async () => {
    const dir = tempDir("p1b-dead-src-");
    const home = tempDir("p1b-harness-");
    try {
      // 9999999 is exceedingly unlikely to be alive on POSIX/macOS
      writeFileSync(join(dir, "gateway.pid"), "9999999\n", "utf8");
      const check = isSourceRunning(dir);
      assert.equal(check.running, false);

      const snap = await createSnapshot({ sourceType: "openclaw", sourceRoot: dir, home, allowLiveCopy: false });
      assert.ok(existsSync(snap.stagingDir));
      rmSync(snap.stagingDir, { recursive: true, force: true });
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("snapshot — relative path keys for duplicate database names (I3)", { timeout: 15_000 }, () => {
  it("keys SQLite metadata by relative path preventing collisions", async () => {
    const dir = tempDir("p1b-multi-db-");
    const home = tempDir("p1b-harness-");
    try {
      mkdirSync(join(dir, "agents", "alpha"), { recursive: true });
      mkdirSync(join(dir, "agents", "beta"), { recursive: true });

      const db1Path = join(dir, "agents", "alpha", "memory.sqlite");
      const db1 = new DatabaseSync(db1Path);
      db1.exec("CREATE TABLE alpha (id INT); INSERT INTO alpha VALUES (1);");
      db1.close();

      const db2Path = join(dir, "agents", "beta", "memory.sqlite");
      const db2 = new DatabaseSync(db2Path);
      db2.exec("CREATE TABLE beta (id INT); INSERT INTO beta VALUES (2);");
      db2.close();

      const snap = await createSnapshot({ sourceType: "openclaw", sourceRoot: dir, home, allowLiveCopy: true });
      assert.ok(existsSync(snap.stagingDir));

      const alphaKey = join("agents", "alpha", "memory.sqlite").replace(/\\/g, "/");
      const betaKey = join("agents", "beta", "memory.sqlite").replace(/\\/g, "/");

      assert.ok(snap.metadata.sqlite[alphaKey], `Missing SQLite status for ${alphaKey}`);
      assert.ok(snap.metadata.sqlite[betaKey], `Missing SQLite status for ${betaKey}`);
      assert.equal(snap.metadata.sqlite[alphaKey]!.status, "copy");
      assert.equal(snap.metadata.sqlite[betaKey]!.status, "copy");

      // Verify both files in staging are independent valid databases
      const checkDb1 = new DatabaseSync(join(snap.stagingDir, "agents", "alpha", "memory.sqlite"), { readOnly: true });
      const row1 = checkDb1.prepare("SELECT * FROM alpha").get() as any;
      assert.equal(row1.id, 1);
      checkDb1.close();

      const checkDb2 = new DatabaseSync(join(snap.stagingDir, "agents", "beta", "memory.sqlite"), { readOnly: true });
      const row2 = checkDb2.prepare("SELECT * FROM beta").get() as any;
      assert.equal(row2.id, 2);
      checkDb2.close();

      rmSync(snap.stagingDir, { recursive: true, force: true });
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("snapshot — LanceDB V2 manifest selection (I4)", { timeout: 15_000 }, () => {
  it("parseLanceManifestVersion handles standard and inverted u64 manifest versions", () => {
    // V1 ascending
    assert.equal(parseLanceManifestVersion("1.manifest"), 1n);
    assert.equal(parseLanceManifestVersion("00000000000000000002.manifest"), 2n);

    // V2 inverted u64 (u64::MAX - version)
    // version 1: 18446744073709551615 - 1 = 18446744073709551614
    // version 2: 18446744073709551615 - 2 = 18446744073709551613
    const v1 = parseLanceManifestVersion("18446744073709551614.manifest");
    const v2 = parseLanceManifestVersion("18446744073709551613.manifest");
    assert.equal(v1, 1n);
    assert.equal(v2, 2n);
    assert.ok(v2 > v1, "V2 manifest version 2 must be greater than version 1");

    // Invalid manifest names
    assert.equal(parseLanceManifestVersion("other.txt"), -1n);
    assert.equal(parseLanceManifestVersion("not-a-number.manifest"), -1n);
  });

  it("copyLanceTableWithManifest selects the newest manifest in inverted u64 format", () => {
    const tableSrc = tempDir("p1b-lance-src-");
    const tableDst = tempDir("p1b-lance-dst-");
    try {
      const versionsDir = join(tableSrc, "_versions");
      mkdirSync(versionsDir, { recursive: true });

      // Write two manifests: v1 and v2 (newer)
      writeFileSync(join(versionsDir, "18446744073709551614.manifest"), "version-1-content\n", "utf8");
      writeFileSync(join(versionsDir, "18446744073709551613.manifest"), "version-2-newest-content\n", "utf8");
      writeFileSync(join(tableSrc, "data.lance"), "lance-table-data\n", "utf8");

      const res = copyLanceTableWithManifest(tableSrc, tableDst, {});
      assert.equal(res.success, true);

      // Verify the newest manifest (v2, 18446744073709551613) exists in destination _versions
      const copiedManifest = join(tableDst, "_versions", "18446744073709551613.manifest");
      assert.ok(existsSync(copiedManifest));
      assert.equal(readFileSync(copiedManifest, "utf8"), "version-2-newest-content\n");
    } finally {
      try { rmSync(tableSrc, { recursive: true, force: true }); } catch {}
      try { rmSync(tableDst, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("snapshot — WSL argument validation and injection defense (I5)", { timeout: 15_000 }, () => {
  it("rejects distro names with shell injection characters or leading dash", async () => {
    const home = tempDir("p1b-harness-");
    try {
      await assert.rejects(
        () => createSnapshot({
          sourceType: "openclaw",
          sourceRoot: "wsl:Ubuntu;rm -rf /:/home/user/.openclaw",
          home,
          distro: "Ubuntu;rm -rf /",
        }),
        (err: any) => {
          assert.ok(err instanceof ImportError);
          assert.equal(err.code, "E_INVALID_PARAMS");
          assert.equal(err.reason, "invalid-distro-name");
          return true;
        }
      );

      await assert.rejects(
        () => createSnapshot({
          sourceType: "openclaw",
          sourceRoot: "wsl:-bad-distro:/home/user/.openclaw",
          home,
          distro: "-bad-distro",
        }),
        (err: any) => {
          assert.ok(err instanceof ImportError);
          assert.equal(err.code, "E_INVALID_PARAMS");
          assert.equal(err.reason, "invalid-distro-name");
          return true;
        }
      );
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });

  it("rejects subpaths with leading dash or NUL bytes", async () => {
    const home = tempDir("p1b-harness-");
    try {
      await assert.rejects(
        () => createSnapshot({
          sourceType: "openclaw",
          sourceRoot: "wsl:Ubuntu-24.04:/home/user/.openclaw",
          home,
          distro: "Ubuntu-24.04",
          subpaths: ["--checkpoint-action=exec=evil.sh"],
        }),
        (err: any) => {
          assert.ok(err instanceof ImportError);
          assert.equal(err.code, "E_TAR_SECURITY");
          assert.equal(err.reason, "invalid-subpath");
          return true;
        }
      );

      await assert.rejects(
        () => createSnapshot({
          sourceType: "openclaw",
          sourceRoot: "wsl:Ubuntu-24.04:/home/user/.openclaw",
          home,
          distro: "Ubuntu-24.04",
          subpaths: ["bad\0path"],
        }),
        (err: any) => {
          assert.ok(err instanceof ImportError);
          assert.equal(err.code, "E_TAR_SECURITY");
          assert.equal(err.reason, "invalid-subpath");
          return true;
        }
      );
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("snapshot — snapshot.json trust anchor (I6)", { timeout: 15_000 }, () => {
  it("ignores snapshot.json outside <home>/import/<run>/snapshot/", () => {
    const home = tempDir("p1b-harness-home-");
    const untrustedDir = tempDir("p1b-untrusted-");
    try {
      // Attacker places a crafted snapshot.json in an arbitrary directory
      writeFileSync(
        join(untrustedDir, "snapshot.json"),
        JSON.stringify({
          version: 1,
          origin: "wsl:Ubuntu-24.04",
          flavour: "posix",
          sourceRoot: "/etc",
          mounts: [{ from: "/etc", to: "etc" }],
        }),
        "utf8"
      );

      // locateSource with accessRoot = untrustedDir
      const loc = locateSource({
        accessRoot: untrustedDir,
        platform: "linux",
        env: {},
        home,
      });

      // It must NOT trust the snapshot.json: falls back to native origin and untrustedDir as sourceRoot
      assert.equal(loc.origin, "native");
      assert.equal(loc.sourceRoot, untrustedDir);
      assert.deepEqual(loc.mounts, []);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
      try { rmSync(untrustedDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("accepts snapshot.json within <home>/import/<runId>/snapshot/", () => {
    const home = tempDir("p1b-harness-home-");
    const snapDir = join(home, "import", "run-123", "snapshot");
    mkdirSync(snapDir, { recursive: true });
    try {
      writeFileSync(
        join(snapDir, "snapshot.json"),
        JSON.stringify({
          version: 1,
          origin: "container",
          flavour: "posix",
          sourceRoot: "/container/source",
          mounts: [],
        }),
        "utf8"
      );

      const loc = locateSource({
        accessRoot: snapDir,
        platform: "linux",
        env: {},
        home,
      });

      assert.equal(loc.origin, "container");
      assert.equal(loc.sourceRoot, "/container/source");
      assert.equal(loc.flavour, "posix");
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });
});

