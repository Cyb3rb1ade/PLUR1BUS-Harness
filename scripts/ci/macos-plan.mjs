#!/usr/bin/env node
// The single place that decides which macOS CI legs run (policy: docs/ci.md).
//
//   node scripts/ci/macos-plan.mjs [--extra <glob>]...
//
// Reads its inputs from the environment (never interpolated into a shell line):
//   EVENT_NAME  github.event_name          ACTION     github.event.action
//   LABEL_NAME  github.event.label.name    LABELS     JSON array of the PR's label names
//   BASE_SHA / HEAD_SHA  the PR base and head (only for pull_request events; needs full history)
// Writes to $GITHUB_OUTPUT (or stdout):
//   proceed=false  only for a `labeled` event whose label is not `ci:macos` (nothing should run)
//   macos=true     run the non-unit macOS legs: any non-PR event, label `ci:macos`, or a platform-sensitive path changed
//   python_matrix  the python-host matrix, with the macOS entry only when macos=true
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LABEL = "ci:macos";
// Platform-sensitive paths: a change here can behave differently on macOS. Edit ONLY this list.
export const SENSITIVE = [
  "crates/**",
  "Cargo.lock",
  "packages/core/src/platform*",
  "packages/core/src/**/acl*",
  "packages/module-api/**",
  "packages/core/src/rpc/**",
  "packages/core/src/secrets/**",
  "hosts/hermes/**",
  "clients/python/**",
  "scripts/install*",
  ".github/workflows/**",
];

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("**/", i)) { re += "(?:.*/)?"; i += 3; }
    else if (glob.startsWith("**", i)) { re += ".*"; i += 2; }
    else if (glob[i] === "*") { re += i === glob.length - 1 ? ".*" : "[^/]*"; i += 1; } // trailing * is a prefix match
    else { re += glob[i].replace(/[.+?^${}()|[\]\\]/g, "\\$&"); i += 1; }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(files, globs) {
  const res = globs.map(globToRegExp);
  return files.some((f) => res.some((r) => r.test(f)));
}

export function plan({ event, action, labelName, labels, files, extra = [] }) {
  if (event === "pull_request" && action === "labeled" && labelName !== LABEL) {
    return { proceed: false, macos: false };
  }
  if (event !== "pull_request") return { proceed: true, macos: true }; // push to main, schedule, workflow_dispatch: full matrix
  const macos = labels.includes(LABEL) || matchesAny(files, [...SENSITIVE, ...extra]);
  return { proceed: true, macos };
}

export function pythonMatrix(macos) {
  return [
    { os: "ubuntu-24.04", python: "3.11" },
    { os: "ubuntu-24.04", python: "3.13" },
    ...(macos ? [{ os: "macos-15", python: "3.13" }] : []),
    { os: "windows-2025", python: "3.13" },
    { os: "windows-11-arm", python: "3.13", informational: true },
  ];
}

/** Paths changed between two commits, as git stores them. `-z` keeps non-ASCII names unquoted (the default output wraps
 *  them in quotes with octal escapes, which no glob matches); `--no-renames` lists both the old and the new path of a
 *  moved file, so moving a file out of a platform-sensitive directory still counts as a change there. */
export function changedFiles(base, head, cwd = process.cwd()) {
  return execFileSync("git", ["diff", "--name-only", "-z", "--no-renames", `${base}...${head}`], { encoding: "utf8", cwd, maxBuffer: 256 * 1024 * 1024 })
    .split("\0").filter(Boolean);
}

function main() {
  const env = process.env;
  const extra = [];
  for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === "--extra") extra.push(process.argv[++i]);
  const event = env.EVENT_NAME ?? "";
  let files = [];
  if (event === "pull_request") {
    files = changedFiles(env.BASE_SHA, env.HEAD_SHA);
  }
  const labels = JSON.parse(env.LABELS || "[]");
  const r = plan({ event, action: env.ACTION ?? "", labelName: env.LABEL_NAME ?? "", labels, files, extra });
  const out = [`proceed=${r.proceed}`, `macos=${r.macos}`, `python_matrix=${JSON.stringify(pythonMatrix(r.macos))}`].join("\n") + "\n";
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, out); else process.stdout.write(out);
  console.error(`macos-plan: event=${event} files=${files.length} -> ${out.trim().split("\n").slice(0, 2).join(" ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
