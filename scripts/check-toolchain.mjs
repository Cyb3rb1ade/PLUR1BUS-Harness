#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { win32 } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FLOORS = { node: [24, 16, 0], pnpm: [10, 0, 0], cargo: [1, 95, 0] };

function parse(text) {
  const m = String(text).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1, 4).map(Number) : null;
}

function atLeast(actual, floor) {
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] > floor[i]) return true;
    if (actual[i] < floor[i]) return false;
  }
  return true;
}

/** @param {{node: string, pnpm: string, cargo: string}} versions */
export function checkToolchain(versions) {
  const problems = [];
  for (const [tool, floor] of Object.entries(FLOORS)) {
    const actual = parse(versions[tool]);
    if (!actual || !atLeast(actual, floor)) {
      problems.push({ tool, have: versions[tool] ?? "missing", need: floor.join(".") });
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Fixed commands only. pnpm is commonly a .cmd shim on Windows, which execFileSync cannot execute directly. */
export function versionCommand(tool, { platform = process.platform, systemRoot = process.env.SystemRoot } = {}) {
  if (!Object.hasOwn(FLOORS, tool)) throw new TypeError("unsupported tool");
  if (tool === "pnpm" && platform === "win32") {
    if (typeof systemRoot !== "string" || !win32.isAbsolute(systemRoot) || /[\0\r\n]/.test(systemRoot)) throw new TypeError("invalid SystemRoot");
    // /d disables cmd AutoRun. The entire command string is a constant: no path, argv or user value is interpolated.
    return { file: win32.join(systemRoot, "System32", "cmd.exe"), args: ["/d", "/s", "/c", "pnpm --version"] };
  }
  return { file: tool === "node" ? process.execPath : tool, args: ["--version"] };
}

/** Injectable native runner for deterministic platform tests; errors and resource limits produce a missing tool. */
export function readVersion(tool, { platform = process.platform, systemRoot = process.env.SystemRoot, env = process.env, runner = execFileSync } = {}) {
  try {
    const { file, args } = versionCommand(tool, { platform, systemRoot });
    return runner(file, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 65_536, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env }).trim();
  } catch { return "missing"; }
}

export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
  try { return !!entry && realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl)); }
  catch { return false; }
}

if (isMainModule()) {
  const result = checkToolchain({
    node: process.version,
    pnpm: readVersion("pnpm"),
    cargo: readVersion("cargo"),
  });
  if (!result.ok) {
    for (const p of result.problems) console.error(`toolchain: ${p.tool} ${p.have} (need >= ${p.need})`);
    process.exit(1);
  }
  console.log("toolchain ok");
}
