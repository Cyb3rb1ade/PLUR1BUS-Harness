import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { readSourceFileSafe } from "../../src/import/fs-safe.ts";
import { ImportError } from "../../src/import/types.ts";
import { importOpenclaw } from "../../src/import/importers/openclaw.ts";
import { planAndMigrateAgent } from "../../src/import/importers/openclaw-agents.ts";
import { layout } from "../../src/paths.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { buildM7OpenclawFixture, CONTENT_MARKER, SYMLINKS } from "./fixtures.ts";

const timeout = 10_000;
const refused = (reason: string) => (error: unknown) => {
  assert.ok(error instanceof ImportError);
  assert.equal(error.reason, reason);
  return true;
};

describe("readSourceFileSafe", () => {
  it("reads binary content byte-exact, including CRLF and NUL", { timeout }, () => {
    const path = join(tempDir("p1b-safe-"), "binary.md");
    const bytes = Buffer.from([0xff, 0x0d, 0x0a, 0x00, 0x80]);
    fs.writeFileSync(path, bytes);
    assert.deepEqual(readSourceFileSafe(path, 100), bytes);
  });

  it("accepts the exact limit and refuses one byte more without leaking paths or contents", { timeout }, () => {
    const path = join(tempDir("p1b-safe-"), "limit.md");
    fs.writeFileSync(path, "abcd");
    assert.deepEqual(readSourceFileSafe(path, 4), Buffer.from("abcd"));
    fs.appendFileSync(path, "e");
    assert.throws(() => readSourceFileSafe(path, 4), (error: unknown) => {
      refused("file-too-large")(error);
      assert.equal((error as Error).message, "limit.md: file-too-large");
      return true;
    });
  });

  it("accepts an empty file with a zero-byte limit", { timeout }, () => {
    const path = join(tempDir("p1b-safe-"), "empty.md");
    fs.writeFileSync(path, "");
    assert.deepEqual(readSourceFileSafe(path, 0), Buffer.alloc(0));
    fs.writeFileSync(path, "x");
    assert.throws(() => readSourceFileSafe(path, 0), refused("file-too-large"));
  });

  it("refuses a symlink without reading its target", { timeout }, (t) => {
    const dir = tempDir("p1b-safe-");
    const target = join(dir, "target.md");
    const path = join(dir, "link.md");
    fs.writeFileSync(target, CONTENT_MARKER);
    try { fs.symlinkSync(target, path, "file"); } catch (error) {
      if (process.platform !== "win32") throw error;
      t.skip(`file symlinks unavailable: ${(error as NodeJS.ErrnoException).code}`);
      return;
    }
    assert.throws(() => readSourceFileSafe(path, 100), refused("unsafe-symlink"));
  });

  it("refuses a directory", { timeout }, () => {
    assert.throws(() => readSourceFileSafe(tempDir("p1b-safe-"), 100), refused("not-regular-file"));
  });

  it("refuses a FIFO without blocking open", { timeout, skip: process.platform === "win32" ? "mkfifo is POSIX-only" : undefined }, () => {
    const path = join(tempDir("p1b-safe-"), "pipe.md");
    execFileSync("mkfifo", [path], { timeout: 5_000 });
    // A subprocess deadline also interrupts a blocking synchronous open (node:test's timeout cannot).
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import { readSourceFileSafe } from ${JSON.stringify(new URL("../../src/import/fs-safe.ts", import.meta.url).href)};
      try { readSourceFileSafe(${JSON.stringify(path)}, 100); process.exit(1); }
      catch (error) { console.log(error.reason); }
    `], { timeout: 5_000, encoding: "utf8" });
    assert.equal(output.trim(), "not-regular-file");
  });

  it("enforces the limit even when the file grows after fstat, and closes the fd", { timeout }, (t) => {
    const path = join(tempDir("p1b-safe-"), "growing.md");
    fs.writeFileSync(path, "abcd");
    const originalStat = fs.fstatSync;
    t.mock.method(fs, "fstatSync", (fd: number) => {
      const stat = originalStat(fd);
      fs.appendFileSync(path, "e");
      return stat;
    });
    const close = t.mock.method(fs, "closeSync");
    syncBuiltinESMExports();
    try {
      assert.throws(() => readSourceFileSafe(path, 4), refused("file-too-large"));
      assert.equal(close.mock.callCount(), 1);
      const fd = close.mock.calls[0]!.arguments[0];
      assert.throws(() => originalStat(fd), { code: "EBADF" });
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it("loops over short reads and reads files larger than a chunk", { timeout }, (t) => {
    const path = join(tempDir("p1b-safe-"), "chunks.md");
    const bytes = Buffer.alloc(70_000, 0xab);
    fs.writeFileSync(path, bytes);
    const originalRead = fs.readSync;
    t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, length: number, position: null) =>
      originalRead(fd, buffer, offset, Math.min(length, 777), position));
    syncBuiltinESMExports();
    try {
      assert.deepEqual(readSourceFileSafe(path, bytes.length), bytes);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  for (const failure of ["size", "type", "identity", "stat", "read"] as const) {
    it(`closes the fd on ${failure} refusal/failure`, { timeout }, (t) => {
      const path = join(tempDir("p1b-safe-"), "error.md");
      fs.writeFileSync(path, "abcd");
      const originalStat = fs.fstatSync;
      if (failure === "type") {
        t.mock.method(fs, "fstatSync", (fd: number) => ({ ...originalStat(fd), isFile: () => false }));
      } else if (failure === "identity") {
        t.mock.method(fs, "fstatSync", (fd: number) => ({ ...originalStat(fd), ino: originalStat(fd).ino + 1 }));
      } else if (failure === "stat" || failure === "read") {
        t.mock.method(fs, failure === "stat" ? "fstatSync" : "readSync", () => { throw new Error(CONTENT_MARKER); });
      }
      const close = t.mock.method(fs, "closeSync");
      syncBuiltinESMExports();
      try {
        const reason = failure === "size" ? "file-too-large" : failure === "type" ? "not-regular-file"
          : failure === "identity" ? "unsafe-symlink" : "source-unreadable";
        assert.throws(() => readSourceFileSafe(path, failure === "size" ? 3 : 100), refused(reason));
        assert.equal(close.mock.callCount(), 1);
        assert.throws(() => originalStat(close.mock.calls[0]!.arguments[0]), { code: "EBADF" });
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  }

  it("refuses a path swapped at open rather than following a symlink", { timeout }, (t) => {
    if (!SYMLINKS.file) { t.skip(SYMLINKS.reason!); return; }
    const dir = tempDir("p1b-safe-");
    const path = join(dir, "swapped.md");
    const outside = join(dir, "outside.md");
    fs.writeFileSync(path, "small");
    fs.writeFileSync(outside, CONTENT_MARKER);
    const originalOpen = fs.openSync;
    t.mock.method(fs, "openSync", (p: fs.PathLike, flags: number) => {
      fs.unlinkSync(path);
      fs.symlinkSync(outside, path, "file");
      return originalOpen(p, flags);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => readSourceFileSafe(path, 100), refused("unsafe-symlink"));
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  for (const code of ["ELOOP", "EMLINK"]) {
    it(`maps ${code} from open to unsafe-symlink without exposing the OS message`, { timeout }, (t) => {
      const path = join(tempDir("p1b-safe-"), "error.md");
      fs.writeFileSync(path, "small");
      t.mock.method(fs, "openSync", () => { throw Object.assign(new Error(CONTENT_MARKER), { code }); });
      const close = t.mock.method(fs, "closeSync");
      syncBuiltinESMExports();
      try {
        assert.throws(() => readSourceFileSafe(path, 100), (error: unknown) => {
          refused("unsafe-symlink")(error);
          assert.equal((error as Error).message, "error.md: unsafe-symlink");
          return true;
        });
        assert.equal(close.mock.callCount(), 0);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  }
});

describe("OpenClaw safe source reads", () => {
  it("reports a refused SOUL.md and imports other files without reading outside contents", { timeout }, async (t) => {
    if (!SYMLINKS.file) { t.skip(SYMLINKS.reason!); return; }
    const fx = await buildM7OpenclawFixture();
    try {
      fs.unlinkSync(fx.curatedFiles.soul);
      fs.symlinkSync(fx.outside, fx.curatedFiles.soul, "file");
      const outsideStat = fs.statSync(fx.outside);
      const originalRead = fs.readSync;
      t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, length: number, position: null) => {
        const stat = fs.fstatSync(fd);
        assert.ok(stat.dev !== outsideStat.dev || stat.ino !== outsideStat.ino, "outside file must never be read");
        return originalRead(fd, buffer, offset, length, position);
      });
      syncBuiltinESMExports();
      const home = tempDir("p1b-safe-home-");
      const report = await importOpenclaw({ home, source: fx.root, apply: true });
      const alpha = report.agents.find((agent) => agent.harnessAgentId === "alpha")!;
      const soul = alpha.files.find((file) => file.targetFile === "SOUL.md")!;
      assert.equal(soul.action, "skipped");
      assert.equal(soul.reason, "symlink-escape");
      assert.ok(alpha.counts.filesCreated > 0);
      assert.ok(!fs.existsSync(join(layout(home).workspaceDir("alpha"), "SOUL.md")));
      assert.deepEqual(fs.readFileSync(join(layout(home).workspaceDir("alpha"), "memories.md")), fs.readFileSync(fx.curatedFiles.memory));
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      fx.close();
    }
  });

  it("reports in-root and dangling links instead of silently dropping them", { timeout }, async (t) => {
    if (!SYMLINKS.file) { t.skip(SYMLINKS.reason!); return; }
    const fx = await buildM7OpenclawFixture();
    try {
      fs.unlinkSync(fx.curatedFiles.soul);
      fs.symlinkSync(fx.curatedFiles.memory, fx.curatedFiles.soul, "file");
      fs.unlinkSync(fx.curatedFiles.user);
      fs.symlinkSync(join(fx.root, "missing.md"), fx.curatedFiles.user, "file");
      const { report } = planAndMigrateAgent(
        { agentId: "alpha", workspace: fx.agents.matching.workspace, workspaceSource: "config", agentDir: null, foundIn: [] },
        fx.root, layout(tempDir("p1b-safe-home-")), new Set(), false,
      );
      for (const name of ["SOUL.md", "USER.md"]) {
        const file = report.files.find((entry) => entry.targetFile === name)!;
        assert.equal(file.action, "skipped");
        assert.equal(file.reason, "unsafe-symlink");
      }
      assert.ok(report.counts.filesCreated > 0);
    } finally { fx.close(); }
  });

  it("refuses daily notes reached through a symlinked parent directory", { timeout }, async () => {
    const fx = await buildM7OpenclawFixture();
    try {
      const memory = join(fx.agents.matching.workspace, "memory");
      const outside = tempDir("p1b-safe-outside-");
      fs.writeFileSync(join(outside, "2026-01-01.md"), CONTENT_MARKER);
      fs.rmSync(memory, { recursive: true });
      fs.symlinkSync(outside, memory, "junction");
      const { report } = planAndMigrateAgent(
        { agentId: "alpha", workspace: fx.agents.matching.workspace, workspaceSource: "config", agentDir: null, foundIn: [] },
        fx.root, layout(tempDir("p1b-safe-home-")), new Set(), false,
      );
      const daily = report.files.find((file) => file.targetFile === "DailyNote_2026-01-01_000000.md")!;
      assert.equal(daily.action, "skipped");
      assert.equal(daily.reason, "symlink-escape");
      assert.ok(report.counts.filesCreated > 0);
    } finally { fx.close(); }
  });

  it("reports a source FIFO as skipped and continues with regular files", { timeout, skip: process.platform === "win32" ? "mkfifo is POSIX-only" : undefined }, async () => {
    const fx = await buildM7OpenclawFixture();
    try {
      fs.unlinkSync(fx.curatedFiles.soul);
      execFileSync("mkfifo", [fx.curatedFiles.soul], { timeout: 5_000 });
      const output = execFileSync(process.execPath, ["--experimental-strip-types", "--conditions=source", "--input-type=module", "-e", `
        import { planAndMigrateAgent } from ${JSON.stringify(new URL("../../src/import/importers/openclaw-agents.ts", import.meta.url).href)};
        import { layout } from ${JSON.stringify(new URL("../../src/paths.ts", import.meta.url).href)};
        const { report } = planAndMigrateAgent(
          { agentId: "alpha", workspace: ${JSON.stringify(fx.agents.matching.workspace)} },
          ${JSON.stringify(fx.root)}, layout(${JSON.stringify(tempDir("p1b-safe-home-"))}), new Set(), false,
        );
        console.log(JSON.stringify({ soul: report.files.find(file => file.targetFile === "SOUL.md"), count: report.counts.filesCreated }));
      `], { timeout: 5_000, encoding: "utf8" });
      const result = JSON.parse(output);
      assert.equal(result.soul.action, "skipped");
      assert.equal(result.soul.reason, "not-regular-file");
      assert.ok(result.count > 0);
    } finally { fx.close(); }
  });
});
