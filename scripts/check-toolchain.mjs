#!/usr/bin/env node
import { execFileSync } from "node:child_process";

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

function version(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: "utf8" }).trim(); } catch { return "missing"; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
