import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { decodeWslOutput, listWslDistros, parseWslListOutput, probeWslDistro, enumerateWslCandidates, spawnWslTarStream, validateAndNormalizeSubpaths, type WslRunner } from "../../src/import/wsl.ts";
import { packTarBuffer } from "../../src/import/snapshot.ts";
import { ImportError } from "../../src/import/types.ts";

describe("WSL discovery and probing (G5)", { timeout: 30_000 }, () => {
  it("decodeWslOutput decodes UTF-16LE with BOM, without BOM, and UTF-8", () => {
    // UTF-16LE with BOM
    const str = "NAME STATE VERSION\nUbuntu Running 2";
    const utf16leBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(str, "utf16le")]);
    assert.equal(decodeWslOutput(utf16leBom).trim(), str);

    // UTF-16LE without BOM (detected via null bytes)
    const utf16leNoBom = Buffer.from(str, "utf16le");
    assert.equal(decodeWslOutput(utf16leNoBom).trim(), str);

    // UTF-8
    const utf8Buf = Buffer.from(str, "utf8");
    assert.equal(decodeWslOutput(utf8Buf).trim(), str);

    // Empty buffer
    assert.equal(decodeWslOutput(Buffer.alloc(0)), "");
  });

  it("parseWslListOutput parses normal, default and spaces/non-ASCII distro names", () => {
    const raw = `  NAME                   STATE           VERSION
* Ubuntu-24.04           Running         2
  Debian                 Stopped         2
  Ubuntu 22.04 LTS       Running         2
  J\u00fcrgen Distro           Stopped         1
`;
    const distros = parseWslListOutput(raw);
    assert.equal(distros.length, 4);

    assert.deepEqual(distros[0], {
      name: "Ubuntu-24.04",
      state: "Running",
      version: 2,
      isDefault: true,
    });

    assert.deepEqual(distros[1], {
      name: "Debian",
      state: "Stopped",
      version: 2,
      isDefault: false,
    });

    assert.deepEqual(distros[2], {
      name: "Ubuntu 22.04 LTS",
      state: "Running",
      version: 2,
      isDefault: false,
    });

    assert.deepEqual(distros[3], {
      name: "J\u00fcrgen Distro",
      state: "Stopped",
      version: 1,
      isDefault: false,
    });
  });

  it("parseWslListOutput handles German localized wsl -l -v output (I7)", () => {
    const germanRaw = `  NAME                   STATUS           VERSION
* Ubuntu-24.04           Wird ausgeführt  2
  Debian                 Beendet          2
`;
    const distros = parseWslListOutput(germanRaw);
    assert.equal(distros.length, 2);
    assert.deepEqual(distros[0], {
      name: "Ubuntu-24.04",
      state: "Running",
      version: 2,
      isDefault: true,
    });
    assert.deepEqual(distros[1], {
      name: "Debian",
      state: "Stopped",
      version: 2,
      isDefault: false,
    });
  });

  it("parseWslListOutput throws on unparseable output rather than returning empty array (I7)", () => {
    const unparseable = `Some random error from driver\ncorrupted line without columns`;
    assert.throws(
      () => parseWslListOutput(unparseable),
      (e: unknown) => e instanceof ImportError && e.reason === "wsl-unparseable"
    );
  });

  it("listWslDistros handles an empty list (only header)", async () => {
    const headerOnly = Buffer.from("  NAME                   STATE           VERSION\n", "utf16le");
    const mockRunner: WslRunner = async () => ({ stdout: headerOnly, stderr: Buffer.alloc(0), exitCode: 0 });
    const distros = await listWslDistros(mockRunner);
    assert.deepEqual(distros, []);
  });

  it("listWslDistros handles WSL not installed (ENOENT or non-zero exit)", async () => {
    const mockRunnerEnoent: WslRunner = async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from("wsl.exe not found"), exitCode: 127 });
    const distros = await listWslDistros(mockRunnerEnoent);
    assert.deepEqual(distros, []);

    const mockRunnerErr: WslRunner = async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from("error"), exitCode: 1 });
    const distros2 = await listWslDistros(mockRunnerErr);
    assert.deepEqual(distros2, []);
  });

  it("listWslDistros handles hanging runner with timeout", async () => {
    const hangingRunner: WslRunner = async (_cmd, opts) => {
      throw new ImportError("E_SOURCE_BUSY", "wsl-timeout", `wsl.exe timed out after ${opts?.timeoutMs ?? 1000}ms`);
    };
    await assert.rejects(
      async () => listWslDistros(hangingRunner, 100),
      (e: unknown) => e instanceof ImportError && e.code === "E_SOURCE_BUSY" && e.reason === "wsl-timeout"
    );
  });

  it("probeWslDistro reports stopped (not probed) when distro is stopped and probeWsl is false (C12)", async () => {
    let ran = false;
    const mockRunner: WslRunner = async () => {
      ran = true;
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    };

    const distro = { name: "Ubuntu-24.04", state: "Stopped" as const, version: 2, isDefault: false };
    const candidates = await probeWslDistro(distro, { runner: mockRunner, probeWsl: false });

    assert.equal(ran, false, "must never run wsl.exe probe command on stopped distro without consent (C12)");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.probed, false);
    assert.equal(candidates[0]!.reason, "stopped (not probed)");
  });

  it("probeWslDistro boots and probes stopped distro when probeWsl is true (C12)", async () => {
    let probeCommandExecuted = false;
    const probeOutput = `HOME=/home/juergen
OPENCLAW=/home/juergen/.openclaw
HERMES=/home/juergen/.hermes
`;
    const mockRunner: WslRunner = async (cmd) => {
      if (cmd.includes("-e")) {
        probeCommandExecuted = true;
        return { stdout: Buffer.from(probeOutput, "utf8"), stderr: Buffer.alloc(0), exitCode: 0 };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    };

    const distro = { name: "Ubuntu-24.04", state: "Stopped" as const, version: 2, isDefault: false };
    const candidates = await probeWslDistro(distro, { runner: mockRunner, probeWsl: true });

    assert.equal(probeCommandExecuted, true);
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0]!.sourceType, "openclaw");
    assert.equal(candidates[0]!.sourceRoot, "/home/juergen/.openclaw");
    assert.equal(candidates[0]!.accessRoot, "\\\\wsl.localhost\\Ubuntu-24.04\\home\\juergen\\.openclaw");
    assert.equal(candidates[0]!.probed, true);

    assert.equal(candidates[1]!.sourceType, "hermes");
    assert.equal(candidates[1]!.sourceRoot, "/home/juergen/.hermes");
    assert.equal(candidates[1]!.accessRoot, "\\\\wsl.localhost\\Ubuntu-24.04\\home\\juergen\\.hermes");
    assert.equal(candidates[1]!.probed, true);
  });

  it("enumerateWslCandidates enumerates running and stopped distros properly", async () => {
    const listOutput = Buffer.from(`  NAME            STATE           VERSION
* Ubuntu-24.04    Running         2
  Debian          Stopped         2
`, "utf16le");

    const probeOutput = `HOME=/home/alice
OPENCLAW=/home/alice/.openclaw
`;

    const mockRunner: WslRunner = async (cmd) => {
      if (cmd.includes("-l")) {
        return { stdout: listOutput, stderr: Buffer.alloc(0), exitCode: 0 };
      }
      if (cmd.includes("Ubuntu-24.04")) {
        return { stdout: Buffer.from(probeOutput, "utf8"), stderr: Buffer.alloc(0), exitCode: 0 };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    };

    const candidates = await enumerateWslCandidates({ runner: mockRunner, probeWsl: false });
    assert.equal(candidates.length, 2);

    // Ubuntu was running and probed
    assert.equal(candidates[0]!.distro, "Ubuntu-24.04");
    assert.equal(candidates[0]!.probed, true);
    assert.equal(candidates[0]!.sourceRoot, "/home/alice/.openclaw");

    // Debian was stopped and not probed
    assert.equal(candidates[1]!.distro, "Debian");
    assert.equal(candidates[1]!.probed, false);
    assert.equal(candidates[1]!.reason, "stopped (not probed)");
  });

  it("listWslDistros parses UTF-16LE -l -q and -l --running -q output language-neutrally (Item 6, Item 8)", async () => {
    const namesUtf16 = Buffer.from("Ubuntu-24.04\r\nDebian\r\nopenSUSE-15.5\r\n", "utf16le");
    const runningUtf16 = Buffer.from("Ubuntu-24.04\r\n", "utf16le");
    const verboseUtf16 = Buffer.from(
      "  NAME            STATE           VERSION\r\n* Ubuntu-24.04    Running         2\r\n  Debian          Stopped         2\r\n  openSUSE-15.5   Stopped         1\r\n",
      "utf16le"
    );

    const mockRunner: WslRunner = async (cmd) => {
      if (cmd.includes("-l") && cmd.includes("--running") && cmd.includes("-q")) {
        return { stdout: runningUtf16, stderr: Buffer.alloc(0), exitCode: 0 };
      }
      if (cmd.includes("-l") && cmd.includes("-q")) {
        return { stdout: namesUtf16, stderr: Buffer.alloc(0), exitCode: 0 };
      }
      if (cmd.includes("-l") && cmd.includes("-v")) {
        return { stdout: verboseUtf16, stderr: Buffer.alloc(0), exitCode: 0 };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    };

    const distros = await listWslDistros(mockRunner);
    assert.equal(distros.length, 3);

    assert.deepEqual(distros[0], {
      name: "Ubuntu-24.04",
      state: "Running",
      version: 2,
      isDefault: true,
    });

    assert.deepEqual(distros[1], {
      name: "Debian",
      state: "Stopped",
      version: 2,
      isDefault: false,
    });

    assert.deepEqual(distros[2], {
      name: "openSUSE-15.5",
      state: "Stopped",
      version: 1,
      isDefault: false,
    });
  });

  it("spawnWslTarStream passes subpaths with spaces, $(whoami) and semicolon unchanged as single arguments and rejects leading dash (Item 4, Item 6)", () => {
    let capturedArgs: string[] = [];
    const fakeSpawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      return child;
    }) as any;

    const subpaths = ["sub path/file.txt", "$(whoami).txt", "hello;world.txt"];
    const proc = spawnWslTarStream("Ubuntu-24.04", "/home/user/.openclaw", subpaths, { spawnFn: fakeSpawn });
    proc.dispose();

    // The subpaths must appear normalized with './' prefix as the last 3 arguments
    assert.deepEqual(capturedArgs.slice(-3), subpaths.map((p) => `./${p}`));
    assert.equal(capturedArgs[capturedArgs.length - 4], "--", "must include '--' separator before subpaths");

    // Leading dash subpath must be rejected
    assert.throws(
      () => spawnWslTarStream("Ubuntu-24.04", "/home/user/.openclaw", ["--checkpoint-action=exec=evil.sh"]),
      (e: any) => e instanceof ImportError && e.reason === "invalid-subpath"
    );
  });

  it("spawnWslTarStream fails with wsl-tar-failed if process exits with code 2 even after valid stream (N3)", async () => {
    const tarBuf = packTarBuffer([{ path: "hello.txt", content: "hello" }]);
    const fakeSpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {};

      // Emit stdout data, then close with code 2 ("file changed as we read it")
      process.nextTick(() => {
        stdout.write(tarBuf);
        stdout.end();
        stderr.write("tar: file changed as we read it\n");
        stderr.end();
        process.nextTick(() => {
          child.emit("close", 2);
        });
      });

      return child;
    }) as any;

    const proc = spawnWslTarStream("Ubuntu-24.04", "/home/user/.openclaw", ["."], { spawnFn: fakeSpawn });

    // Stream should complete
    const chunks: Buffer[] = [];
    for await (const chunk of proc.stream) {
      chunks.push(chunk);
    }
    assert.ok(Buffer.concat(chunks).length > 0);

    // But waitClose() must await child exit and throw wsl-tar-failed
    await assert.rejects(
      () => proc.waitClose(),
      (e: any) => {
        assert.ok(e instanceof ImportError);
        assert.equal(e.code, "E_IMPORT_FAILED");
        assert.equal(e.reason, "wsl-tar-failed");
        return true;
      }
    );
  });

  it("spawnWslTarStream drains chatty stderr without stalling (N3)", async () => {
    const fakeSpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {};

      process.nextTick(() => {
        // Send empty tar eof
        stdout.write(Buffer.alloc(1024));
        stdout.end();
        // Emit 100 KB of chatty stderr in chunks
        for (let i = 0; i < 10; i++) {
          stderr.write(Buffer.alloc(10 * 1024, "x"));
        }
        stderr.end();
        process.nextTick(() => {
          child.emit("close", 0);
        });
      });

      return child;
    }) as any;

    const proc = spawnWslTarStream("Ubuntu-24.04", "/home/user/.openclaw", ["."], { spawnFn: fakeSpawn });
    for await (const _chunk of proc.stream) {
      // consume
    }
    await proc.waitClose();
  });

  it("listWslDistros uses exact name matching so prefix names do not inherit default marker or version (Item 6, M8)", async () => {
    const namesUtf16 = Buffer.from("Ubuntu\r\nUbuntu-24.04\r\n", "utf16le");
    const verboseUtf16 = Buffer.from(
      "  NAME            STATE           VERSION\r\n* Ubuntu-24.04    Running         2\r\n  Ubuntu          Stopped         1\r\n",
      "utf16le"
    );

    const mockRunner: WslRunner = async (cmd) => {
      if (cmd.includes("-l") && cmd.includes("-q")) {
        return { stdout: namesUtf16, stderr: Buffer.alloc(0), exitCode: 0 };
      }
      if (cmd.includes("-l") && cmd.includes("-v")) {
        return { stdout: verboseUtf16, stderr: Buffer.alloc(0), exitCode: 0 };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    };

    const distros = await listWslDistros(mockRunner);
    assert.equal(distros.length, 2);

    const u = distros.find((d) => d.name === "Ubuntu")!;
    const u24 = distros.find((d) => d.name === "Ubuntu-24.04")!;

    assert.equal(u.isDefault, false);
    assert.equal(u.version, 1);

    assert.equal(u24.isDefault, true);
    assert.equal(u24.version, 2);
  });

  it("spawnWslTarStream leaves no active timers behind after stream completes (N3)", async () => {
    let clearedTimer = false;
    const origClearTimeout = globalThis.clearTimeout;
    (globalThis as any).clearTimeout = (id: any) => {
      clearedTimer = true;
      origClearTimeout(id);
    };

    try {
      const fakeSpawn = ((_cmd: string, _args: string[]) => {
        const child = new EventEmitter() as any;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        child.stdout = stdout;
        child.stderr = stderr;
        child.kill = () => {};

        process.nextTick(() => {
          stdout.write(Buffer.alloc(1024));
          stdout.end();
          stderr.end();
          child.emit("close", 0);
        });

        return child;
      }) as any;

      const proc = spawnWslTarStream("Ubuntu-24.04", "/home/user/.openclaw", ["."], { spawnFn: fakeSpawn });
      for await (const _chunk of proc.stream) {}
      await proc.waitClose();
      assert.equal(clearedTimer, true, "timer must be cleared upon stream completion");
    } finally {
      globalThis.clearTimeout = origClearTimeout;
    }
  });

  it("spawnWslTarStream with allowLiveCopy treats exit code 1 as a warning instead of aborting (F4)", async () => {
    const tarBuf = packTarBuffer([{ path: "file.txt", content: "data" }]);
    const fakeSpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {};

      process.nextTick(() => {
        stdout.write(tarBuf);
        stdout.end();
        stderr.write("tar: file changed as we read it\n");
        stderr.end();
        child.emit("close", 1);
      });

      return child;
    }) as any;

    const proc = spawnWslTarStream("Ubuntu-24.04", "/home/user/.openclaw", ["."], { spawnFn: fakeSpawn });
    for await (const _chunk of proc.stream) {}
    const res = await proc.waitClose(true);
    assert.equal(res.tarWarnings, 1);
  });

  it("spawnWslTarStream throws wsl-tar-failed when killed by a signal (M2)", async () => {
    const fakeSpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {};

      process.nextTick(() => {
        stdout.end();
        stderr.end();
        child.emit("close", null, "SIGKILL");
      });

      return child;
    }) as any;

    const proc = spawnWslTarStream("Ubuntu-24.04", "/home/user/.openclaw", ["."], { spawnFn: fakeSpawn });
    for await (const _chunk of proc.stream) {}
    await assert.rejects(
      () => proc.waitClose(),
      (e: any) => e instanceof ImportError && e.reason === "wsl-tar-failed" && e.message.includes("SIGKILL")
    );
  });
});

describe("validateAndNormalizeSubpaths (F5)", () => {
  it("rejects subpaths with .. segments", () => {
    assert.throws(
      () => validateAndNormalizeSubpaths(["../x"]),
      (e: any) => e instanceof ImportError && e.reason === "invalid-subpath"
    );
    assert.throws(
      () => validateAndNormalizeSubpaths(["a/../../x"]),
      (e: any) => e instanceof ImportError && e.reason === "invalid-subpath"
    );
    assert.throws(
      () => validateAndNormalizeSubpaths(["sub/.."]),
      (e: any) => e instanceof ImportError && e.reason === "invalid-subpath"
    );
  });

  it("rejects absolute paths (POSIX and Windows)", () => {
    assert.throws(
      () => validateAndNormalizeSubpaths(["/etc"]),
      (e: any) => e instanceof ImportError && e.reason === "invalid-subpath"
    );
    assert.throws(
      () => validateAndNormalizeSubpaths(["C:\\x"]),
      (e: any) => e instanceof ImportError && e.reason === "invalid-subpath"
    );
    assert.throws(
      () => validateAndNormalizeSubpaths(["\\\\server\\share"]),
      (e: any) => e instanceof ImportError && e.reason === "invalid-subpath"
    );
  });

  it("rejects leading dash and NUL bytes", () => {
    assert.throws(
      () => validateAndNormalizeSubpaths(["-flag"]),
      (e: any) => e instanceof ImportError && e.reason === "invalid-subpath"
    );
    assert.throws(
      () => validateAndNormalizeSubpaths(["foo\0bar"]),
      (e: any) => e instanceof ImportError && e.reason === "invalid-subpath"
    );
  });

  it("accepts and normalizes valid subpaths", () => {
    assert.deepEqual(validateAndNormalizeSubpaths(["a/b"]), ["./a/b"]);
    assert.deepEqual(validateAndNormalizeSubpaths(["."]), ["."]);
    assert.deepEqual(validateAndNormalizeSubpaths(["./a/b"]), ["./a/b"]);
    assert.deepEqual(validateAndNormalizeSubpaths(["a", "b/c"]), ["./a", "./b/c"]);
  });
});


