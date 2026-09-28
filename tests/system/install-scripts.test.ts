// The one-line installers (2a-H3b-b Task 10, HB19): scripts/install/install.sh on Linux and macOS,
// scripts/install/install.ps1 on Windows (the windows-2025 CI step runs this file). Each case serves a fake release
// from a local directory through a file:// feed: no network. The fake binary prints its arguments, so "runs setup
// with the given flags" is read from its output. Every case uses its own temp home.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TARGETS = ["linux-x64", "linux-arm64", "darwin-arm64", "win-x64", "win-arm64"];
const INSTALL_SH = resolve("scripts/install/install.sh");
const INSTALL_PS1 = resolve("scripts/install/install.ps1");
const WIN = process.platform === "win32";
const FLAGS = ["--non-interactive", "--accept-nc-licence", "--agent", "two words"];

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** A POSIX fake `plur1bus` that prints each argument in brackets. */
const FAKE_SH = '#!/bin/sh\necho fake-plur1bus\nfor a in "$@"; do printf "[%s]\\n" "$a"; done\n';

/** A Windows fake `plur1bus.exe`, compiled once by Windows PowerShell's Add-Type (csc from .NET Framework). */
let fakeExe: Buffer | null = null;
function fakeWindowsBinary(dir: string): Buffer {
  if (fakeExe) return fakeExe;
  const out = join(dir, "fake-plur1bus.exe");
  const src = 'public static class P { public static int Main(string[] a) { System.Console.WriteLine("fake-plur1bus"); foreach (string s in a) System.Console.WriteLine("[" + s + "]"); return 0; } }';
  // The source goes through a file, not the command line: no quoting between Node, CreateProcess and PowerShell.
  const cs = join(dir, "fake-plur1bus.cs");
  writeFileSync(cs, src);
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -OutputType ConsoleApplication -OutputAssembly '${out}' -Path '${cs}'`], { stdio: "pipe" });
  fakeExe = readFileSync(out);
  return fakeExe;
}

type Fixture = { root: string; home: string; feed: string; binary: Buffer };

/** A temp root with `home/` and `release/` (the fake binaries and `stable.json`). `recorded` replaces the sha256 the
 *  feed records for every binary; `compact` writes the feed on one line with `sha256` before `url` and escaped
 *  slashes, as a JSON serializer may. The core payload entries carry different hashes, so reading the wrong map
 *  fails the checksum. */
function fixture(opts: { recorded?: string; compact?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "p1b-inst-"));
  const home = join(root, "home");
  const rel = join(root, "release");
  mkdirSync(home);
  mkdirSync(rel);
  const binary = WIN ? fakeWindowsBinary(root) : Buffer.from(FAKE_SH);
  const asset = (name: string, digest: string) => {
    const url = pathToFileURL(join(rel, name)).href;
    return opts.compact ? { sha256: digest, url: url.replace(/\//g, "\\/") } : { url, sha256: digest };
  };
  const binaryMap: Record<string, unknown> = {};
  const payloadMap: Record<string, unknown> = {};
  for (const t of TARGETS) {
    const name = `plur1bus-${t}${t.startsWith("win-") ? ".exe" : ""}`;
    writeFileSync(join(rel, name), binary);
    binaryMap[t] = asset(name, opts.recorded ?? sha(binary));
    payloadMap[t] = asset(`core-0.2.0-${t}.tar.gz`, sha(`payload ${t}`));
  }
  const doc = {
    version: "0.2.0",
    channel: "stable",
    kind: "minor",
    security: false,
    notes: { en: "Example release (tests only)." },
    minFromVersion: "0.1.0",
    native: {
      binary: binaryMap,
      core: { version: "0.2.0", contract: "1.9.0", rpc: "1.3.0", payload: payloadMap },
      node: { version: "24.21.0" },
      modules: [],
      configSchemaVersion: 1,
    },
  };
  let text = opts.compact ? JSON.stringify(doc) : JSON.stringify(doc, null, 2);
  if (opts.compact) text = text.replace(/\\\\\//g, "\\/"); // keep the single JSON escape `\/` in URLs
  writeFileSync(join(rel, "stable.json"), text);
  return { root, home, feed: pathToFileURL(join(rel, "{channel}.json")).href.replace(/%7B/g, "{").replace(/%7D/g, "}"), binary };
}

/** The installed binary's path in a temp home. */
function installed(f: Fixture): string {
  return WIN ? join(f.home, "AppData", "Local", "PLUR1BUS", "bin", "plur1bus.exe") : join(f.home, ".local", "bin", "plur1bus");
}

/** Runs the platform's installer against the fixture. `extraPath` goes first on PATH (shims). */
function run(f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}, extraPath?: string) {
  const base: NodeJS.ProcessEnv = { ...process.env, PLUR1BUS_INSTALL_FEED: f.feed, PLUR1BUS_CHANNEL: "stable" };
  if (WIN) {
    // Only LOCALAPPDATA moves into the temp home; PowerShell itself also writes caches below it
    // (Microsoft\Windows\PowerShell), which is why the checks look only at the install root (`ours`).
    base.LOCALAPPDATA = join(f.home, "AppData", "Local");
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", INSTALL_PS1, ...args], { encoding: "utf8", env: { ...base, ...env }, timeout: 60_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  base.HOME = f.home;
  if (extraPath) base.PATH = `${extraPath}:${process.env.PATH}`;
  const r = spawnSync("sh", [INSTALL_SH, ...args], { encoding: "utf8", env: { ...base, ...env }, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Every file the installer may have written: below the home on unix, below %LOCALAPPDATA%\PLUR1BUS on Windows (an
 *  install that refused must leave none, temp files included). */
function ours(f: Fixture): string[] {
  return filesUnder(WIN ? join(f.home, "AppData", "Local", "PLUR1BUS") : f.home);
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

const NAME = WIN ? "install.ps1" : "install.sh";

describe(`one-line installer (${NAME})`, () => {
  it(`${NAME} installs the verified binary and runs setup with the given flags`, () => {
    const f = fixture();
    try {
      const r = run(f, FLAGS);
      assert.equal(r.status, 0, `exit 0\n${r.stdout}\n${r.stderr}`);
      const lines = r.stdout.trim().split(/\r?\n/);
      assert.deepEqual(lines, ["fake-plur1bus", "[setup]", ...FLAGS.map((a) => `[${a}]`)], "setup runs with the flags, word boundaries kept");
      const bin = installed(f);
      assert.deepEqual(readFileSync(bin), f.binary);
      if (!WIN) assert.equal(statSync(bin).mode & 0o777, 0o755);
      assert.deepEqual(ours(f), [bin], "only the binary is left behind");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it(`${NAME} reads a compact feed with keys in any order and escaped slashes`, () => {
    const f = fixture({ compact: true });
    try {
      const r = run(f, ["--non-interactive"]);
      assert.equal(r.status, 0, `exit 0\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /\[setup\]\r?\n\[--non-interactive\]/);
      assert.ok(existsSync(installed(f)));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it(`${NAME} refuses a sha mismatch and installs nothing`, () => {
    const f = fixture({ recorded: sha("something else") });
    try {
      const r = run(f, FLAGS);
      assert.equal(r.status, 1, `exit 1\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /checksum mismatch/i);
      assert.doesNotMatch(r.stdout, /fake-plur1bus/, "nothing ran");
      assert.deepEqual(ours(f), [], "nothing installed, no temp file left");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it(`${NAME} refuses an unknown target`, () => {
    const f = fixture();
    try {
      let r;
      if (WIN) {
        r = run(f, FLAGS, { PROCESSOR_ARCHITECTURE: "x86", PROCESSOR_ARCHITEW6432: undefined });
      } else {
        // A `uname` shim: a host outside the release matrix.
        const shim = join(f.root, "shim");
        mkdirSync(shim);
        writeFileSync(join(shim, "uname"), '#!/bin/sh\ncase "$1" in -m) echo riscv64 ;; *) echo FreeBSD ;; esac\n');
        chmodSync(join(shim, "uname"), 0o755);
        r = run(f, FLAGS, {}, shim);
      }
      assert.equal(r.status, 1, `exit 1\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /unsupported target/i);
      assert.doesNotMatch(r.stdout, /fake-plur1bus/);
      assert.deepEqual(ours(f), [], "nothing installed");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
