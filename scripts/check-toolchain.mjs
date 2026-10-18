#!/usr/bin/env node
import { execFileSync } from "node:child_process";
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

// pnpm/action-setup installs pnpm.cmd on Windows. Batch files require cmd.exe;
// only this fixed version command goes through the shell, never caller input.
export function version(cmd, args, { platform = process.platform, run = execFileSync } = {}) {
  try {
    return (platform === "win32" && cmd === "pnpm"
      ? run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "pnpm --version"], { encoding: "utf8" })
      : run(cmd, args, { encoding: "utf8" })).trim();
  } catch { return "missing"; }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const result = checkToolchain({
    node: process.version,
    pnpm: version("pnpm", ["--version"]),
    cargo: version("cargo", ["--version"]),
  });
  if (!result.ok) {
    for (const p of result.problems) console.error(`toolchain: ${p.tool} ${p.have} (need >= ${p.need})`);
    process.exit(1);
  }
  console.log("toolchain ok");
}
