import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeWslOutput, listWslDistros, parseWslListOutput, probeWslDistro, enumerateWslCandidates, type WslRunner } from "../../src/import/wsl.ts";
import { ImportError } from "../../src/import/types.ts";

describe("WSL discovery and probing (G5)", () => {
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
});
