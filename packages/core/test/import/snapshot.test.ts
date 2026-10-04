import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("rejects extended header payload exceeding 1 MiB (Item 8)", async () => {
    const staging = tempDir("p1b-snap-test-");
    const header = Buffer.alloc(512);
    Buffer.from("pax_header").copy(header, 0);
    Buffer.from("0000644\0").copy(header, 100);
    Buffer.from("0000000\0").copy(header, 108);
    Buffer.from("0000000\0").copy(header, 116);
    Buffer.from((1048577).toString(8).padStart(11, "0") + "\0").copy(header, 124);
    Buffer.from("00000000000\0").copy(header, 136);
    header[156] = "x".charCodeAt(0);
    Buffer.from("ustar\0").copy(header, 257);
    Buffer.from("00").copy(header, 263);

    header.fill(32, 148, 156);
    let chk = 0;
    for (let b = 0; b < 512; b++) chk += header[b]!;
    Buffer.from(chk.toString(8).padStart(6, "0") + "\0 ").copy(header, 148);

    const oversizedTar = Buffer.concat([header, Buffer.alloc(1024)]);

    await assert.rejects(
      () => extractTarStream(oversizedTar, staging),
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_TAR_SECURITY");
        assert.equal(err.reason, "header-too-large");
        return true;
      }
    );
  });

  it("rejects Windows hazard entry names on win32 target platform (Item 8)", async () => {
    const hazards = [
      "bad:stream.txt",
      "CON",
      "folder/NUL.txt",
      "trailing-dot.",
      "trailing-space ",
    ];

    for (const h of hazards) {
      const staging = tempDir("p1b-snap-test-");
      const tar = packTarBuffer([{ path: h, content: "hazard" }]);
      await assert.rejects(
        () => extractTarStream(tar, staging, { targetPlatform: "win32" }),
        (err: any) => {
          assert.ok(err instanceof ImportError);
          assert.equal(err.code, "E_TAR_SECURITY");
          assert.equal(err.reason, "unportable-name");
          return true;
        }
      );
    }
  });

  it("counts directory entries towards maxFiles cap (Item 8, N7)", async () => {
    const staging = tempDir("p1b-snap-test-");
    const tar = packTarBuffer([
      { path: "dir1/", typeflag: "5" },
      { path: "dir2/", typeflag: "5" },
      { path: "dir3/", typeflag: "5" },
    ]);
    await assert.rejects(
      () => extractTarStream(tar, staging, { maxFiles: 2 }),
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_LIMIT_EXCEEDED");
        assert.equal(err.reason, "too-many-files");
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

  it("handles live copy with --allow-live-copy: records copy on stable db and source-busy on mutating db", async () => {
    const dir = tempDir("p1b-busy-sqlite-");
    const dbPath = join(dir, "live.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");

    const home = tempDir("p1b-harness-");

    try {
      // 1. Without mutation during copy -> strictly 'copy'
      const snap1 = await createSnapshot({
        sourceType: "openclaw",
        sourceRoot: dir,
        home,
        allowLiveCopy: true,
      });

      assert.ok(existsSync(snap1.stagingDir));
      assert.ok(snap1.metadata.sqlite["live.sqlite"]);
      assert.equal(snap1.metadata.sqlite["live.sqlite"]!.status, "copy");
      assert.equal(snap1.metadata.sqlite["live.sqlite"]!.attempts, 1);
      rmSync(snap1.stagingDir, { recursive: true, force: true });

      // 2. With mutation during copy -> strictly 'source-busy' with 3 attempts
      const snap2 = await createSnapshot({
        sourceType: "openclaw",
        sourceRoot: dir,
        home,
        allowLiveCopy: true,
        afterCopy: () => {
          db.exec("INSERT INTO t VALUES (2);");
        },
      });

      assert.ok(existsSync(snap2.stagingDir));
      assert.ok(snap2.metadata.sqlite["live.sqlite"]);
      assert.equal(snap2.metadata.sqlite["live.sqlite"]!.status, "source-busy");
      assert.equal(snap2.metadata.sqlite["live.sqlite"]!.attempts, 4);
      rmSync(snap2.stagingDir, { recursive: true, force: true });
    } finally {
      db.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("snapshot — WSL tar stream with injected runner (G5, G6)", { timeout: 15_000 }, () => {
  it("extracts WSL tar stream through runner and emits snapshot.json (N2)", async () => {
    const tarBuf = packTarBuffer([
      { path: "openclaw.json", content: JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" }, agents: { list: [{ id: "wsl-agent" }] } }) },
      { path: "skills/test-skill/SKILL.md", content: "---\nname: test-skill\n---\n" },
      { path: ".env", content: "TEST_SECRET=12345\n" },
    ]);

    let runningCheckCalled = false;
    let symlinkCheckCalled = false;
    let tarCalled = false;

    const mockWslRunner = async (cmd: string[]) => {
      assert.equal(cmd[0], "wsl.exe");
      if (cmd[1] === "-l") {
        return { stdout: Buffer.from("Ubuntu-24.04\n"), stderr: Buffer.alloc(0), exitCode: 0 };
      }
      assert.equal(cmd[1], "-d");
      assert.equal(cmd[2], "Ubuntu-24.04");
      assert.equal(cmd[3], "--exec");

      if (cmd[4] === "sh") {
        // running check or symlink check
        assert.equal(cmd[8], "/home/ubuntu/.openclaw", "path must be passed as argv positional argument $1 without interpolation");
        const script = cmd[6] ?? "";
        if (script.includes("gateway.pid")) {
          runningCheckCalled = true;
          return { stdout: Buffer.from("stopped\n"), stderr: Buffer.alloc(0), exitCode: 0 };
        }
        if (script.includes("find . -type l")) {
          symlinkCheckCalled = true;
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
        }
      }

      if (cmd[4] === "tar") {
        tarCalled = true;
        assert.equal(cmd[cmd.indexOf("-C") + 1], "/home/ubuntu/.openclaw");
        return { stdout: tarBuf, stderr: Buffer.alloc(0), exitCode: 0 };
      }

      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const home = tempDir("p1b-wsl-snap-home-");
    const snap = await createSnapshot({
      sourceType: "openclaw",
      sourceRoot: "wsl:Ubuntu-24.04:/home/ubuntu/.openclaw",
      home,
      wslRunner: mockWslRunner,
    });

    assert.ok(runningCheckCalled, "must call running check inside WSL");
    assert.ok(symlinkCheckCalled, "must call symlink pre-pass inside WSL");
    assert.ok(tarCalled, "must call tar inside WSL");

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

  it("detects and excludes external symlinks inside WSL, recording in skippedLinks (N1)", async () => {
    let capturedExcludeArgs: string[] = [];
    const tarBuf = packTarBuffer([
      { path: "openclaw.json", content: "{}" },
    ]);

    const mockRunner = async (cmd: string[]) => {
      if (cmd[1] === "-l") {
        return { stdout: Buffer.from("Ubuntu-24.04\n"), stderr: Buffer.alloc(0), exitCode: 0 };
      }
      if (cmd[4] === "sh") {
        const script = cmd[6] ?? "";
        if (script.includes("gateway.pid")) {
          return { stdout: Buffer.from("stopped\n"), stderr: Buffer.alloc(0), exitCode: 0 };
        }
        if (script.includes("find . -type l")) {
          // Reports external symlink pointing outside root
          return { stdout: Buffer.from("skills/bad-link\nsecrets\n"), stderr: Buffer.alloc(0), exitCode: 0 };
        }
      }
      if (cmd[4] === "tar") {
        capturedExcludeArgs = cmd.filter((arg) => arg.startsWith("--exclude="));
        return { stdout: tarBuf, stderr: Buffer.alloc(0), exitCode: 0 };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    };

    const home = tempDir("p1b-wsl-symlink-");
    const snap = await createSnapshot({
      sourceType: "openclaw",
      sourceRoot: "wsl:Ubuntu-24.04:/home/ubuntu/.openclaw",
      home,
      wslRunner: mockRunner,
    });

    assert.ok(capturedExcludeArgs.includes("--exclude=skills/bad-link"));
    assert.ok(capturedExcludeArgs.includes("--exclude=./skills/bad-link"));
    assert.deepEqual(snap.metadata.skippedLinks, ["skills/bad-link", "secrets"]);

    rmSync(snap.stagingDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("refuses running source in WSL without --allow-live-copy, succeeds with it (N2, C7)", async () => {
    const mockRunningRunner = async (cmd: string[]) => {
      if (cmd[1] === "-l") {
        return { stdout: Buffer.from("Ubuntu-24.04\n"), stderr: Buffer.alloc(0), exitCode: 0 };
      }
      if (cmd[4] === "sh") {
        const script = cmd[6] ?? "";
        if (script.includes("gateway.pid")) {
          return { stdout: Buffer.from("running:/home/ubuntu/.openclaw/gateway.pid:1234\n"), stderr: Buffer.alloc(0), exitCode: 0 };
        }
      }
      if (cmd[4] === "tar") {
        return { stdout: packTarBuffer([{ path: "openclaw.json", content: "{}" }]), stderr: Buffer.alloc(0), exitCode: 0 };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    };

    const home = tempDir("p1b-wsl-runcheck-");
    try {
      await assert.rejects(
        () => createSnapshot({
          sourceType: "openclaw",
          sourceRoot: "wsl:Ubuntu-24.04:/home/ubuntu/.openclaw",
          home,
          wslRunner: mockRunningRunner,
          allowLiveCopy: false,
        }),
        (e: any) => e instanceof ImportError && e.code === "E_SOURCE_BUSY" && e.reason === "source-running"
      );

      // With allowLiveCopy: true, it proceeds
      const snap = await createSnapshot({
        sourceType: "openclaw",
        sourceRoot: "wsl:Ubuntu-24.04:/home/ubuntu/.openclaw",
        home,
        wslRunner: mockRunningRunner,
        allowLiveCopy: true,
      });
      assert.ok(existsSync(snap.stagingDir));
      rmSync(snap.stagingDir, { recursive: true, force: true });
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });

  it("executes the production WSL branch end-to-end with fake wsl.exe binary on PATH (N2)", async () => {
    const fakeBinDir = tempDir("p1b-fake-bin-");
    const fakeWslPath = join(fakeBinDir, "wsl.exe");
    const home = tempDir("p1b-wsl-real-home-");

    // Create a shell script acting as fake wsl.exe
    const fakeWslScript = `#!/bin/sh
if [ "$1" = "-l" ] && [ "$2" = "-q" ]; then
  printf "Ubuntu-24.04\\n"
  exit 0
fi
if [ "$1" = "-l" ] && [ "$2" = "--running" ] && [ "$3" = "-q" ]; then
  printf "Ubuntu-24.04\\n"
  exit 0
fi
if [ "$1" = "-l" ] && [ "$2" = "-v" ]; then
  printf "* Ubuntu-24.04 Running 2\\n"
  exit 0
fi
if [ "$3" = "--exec" ] && [ "$4" = "sh" ]; then
  printf "stopped\\n"
  exit 0
fi
if [ "$3" = "--exec" ] && [ "$4" = "tar" ]; then
  shift 4
  exec tar "$@"
fi
exit 0
`;
    writeFileSync(fakeWslPath, fakeWslScript, { mode: 0o755 });

    const dummySrc = tempDir("p1b-dummy-wsl-src-");
    writeFileSync(join(dummySrc, "openclaw.json"), '{"agents":{"list":[]}}', "utf8");

    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${oldPath}`;
    try {
      const snap = await createSnapshot({
        sourceType: "openclaw",
        sourceRoot: `wsl:Ubuntu-24.04:${dummySrc}`,
        home,
        // No injected runner or spawnFn! Exercises production spawnWslTarStream path.
      });
      assert.ok(existsSync(snap.stagingDir));
      assert.ok(existsSync(join(snap.stagingDir, "openclaw.json")));
      assert.ok(existsSync(join(snap.stagingDir, "snapshot.json")));
      rmSync(snap.stagingDir, { recursive: true, force: true });
    } finally {
      process.env.PATH = oldPath;
      try { rmSync(fakeBinDir, { recursive: true, force: true }); } catch {}
      try { rmSync(dummySrc, { recursive: true, force: true }); } catch {}
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
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

  it("records status: 'source-busy' under lancedb in snapshot.json when Lance copy fails during live copy (Item 7, Item 5)", async () => {
    const dir = tempDir("p1b-lance-busy-src-");
    const home = tempDir("p1b-lance-busy-home-");
    try {
      const tableDir = join(dir, "my_table.lance");
      const versionsDir = join(tableDir, "_versions");
      mkdirSync(versionsDir, { recursive: true });
      writeFileSync(join(versionsDir, "1.manifest"), "v1\n", "utf8");
      writeFileSync(join(tableDir, "data.lance"), "lance-data\n", "utf8");

      let mutateCount = 0;
      const snap = await createSnapshot({
        sourceType: "openclaw",
        sourceRoot: dir,
        home,
        allowLiveCopy: true,
        afterCopy: () => {
          // Mutate manifest during copy to trigger live copy retry failure
          writeFileSync(join(versionsDir, `${++mutateCount + 10}.manifest`), "mutated\n", "utf8");
        },
      });

      assert.ok(existsSync(snap.stagingDir));
      assert.ok(snap.metadata.lancedb);
      const tableKey = "my_table.lance";
      assert.ok(snap.metadata.lancedb[tableKey]);
      assert.equal(snap.metadata.lancedb[tableKey]!.status, "source-busy");
      assert.equal(snap.metadata.lancedb[tableKey]!.attempts, 3);
      rmSync(snap.stagingDir, { recursive: true, force: true });
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      try { rmSync(home, { recursive: true, force: true }); } catch {}
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

  it("refuses snapshot directory reached via symlink pointing outside (Item 5, Item 7)", () => {
    const home = tempDir("p1b-harness-home-");
    const outsideDir = tempDir("p1b-outside-snap-");
    const runParent = join(home, "import", "run-symlink");
    mkdirSync(runParent, { recursive: true });
    const symlinkSnap = join(runParent, "snapshot");

    try {
      // Put valid snapshot.json in outsideDir
      writeFileSync(
        join(outsideDir, "snapshot.json"),
        JSON.stringify({
          version: 1,
          origin: "container",
          flavour: "posix",
          sourceRoot: "/container/source",
          mounts: [],
        }),
        "utf8"
      );

      // Symlink <home>/import/run-symlink/snapshot -> outsideDir
      symlinkSync(outsideDir, symlinkSnap);

      const loc = locateSource({
        accessRoot: symlinkSnap,
        platform: "linux",
        env: {},
        home,
      });

      // Because realpath resolves outside <home>/import/, it must NOT be trusted
      assert.equal(loc.origin, "native");
      assert.equal(loc.sourceRoot, symlinkSnap);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
      try { rmSync(outsideDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("strips mounts pointing to /etc or C:\\ inside snapshot.json (Item 5, Item 7)", () => {
    const home = tempDir("p1b-harness-home-");
    const snapDir = join(home, "import", "run-mounts", "snapshot");
    mkdirSync(snapDir, { recursive: true });
    try {
      writeFileSync(
        join(snapDir, "snapshot.json"),
        JSON.stringify({
          version: 1,
          origin: "container",
          flavour: "posix",
          sourceRoot: "/container/source",
          mounts: [
            { from: "data", to: "/etc" },
            { from: "sys", to: "C:\\Windows" },
            { from: "trav", to: "../../outside" },
            { from: "valid", to: "valid-subdir" },
          ],
        }),
        "utf8"
      );

      const loc = locateSource({
        accessRoot: snapDir,
        platform: "linux",
        env: {},
        home,
      });

      // Mounts to /etc, C:\Windows, and outside traversal are stripped! Only valid-subdir remains.
      assert.equal(loc.mounts.length, 1);
      assert.equal(loc.mounts[0]!.from, "valid");
      assert.equal(loc.mounts[0]!.to, "valid-subdir");
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });

  it("treats sourceRoot and sourceHome as display-only values (Item 5, Item 7)", () => {
    const home = tempDir("p1b-harness-home-");
    const snapDir = join(home, "import", "run-display", "snapshot");
    mkdirSync(snapDir, { recursive: true });
    try {
      writeFileSync(
        join(snapDir, "snapshot.json"),
        JSON.stringify({
          version: 1,
          origin: "container",
          flavour: "posix",
          sourceRoot: "/etc",
          sourceHome: "/root",
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

      // Preserves metadata fields for display, but loc.accessRoot is the actual path
      assert.equal(loc.sourceRoot, "/etc");
      assert.equal(loc.accessRoot, snapDir);
      assert.notEqual(loc.accessRoot, loc.sourceRoot);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });
});

