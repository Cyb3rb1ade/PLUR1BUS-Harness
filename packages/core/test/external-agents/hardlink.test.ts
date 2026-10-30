import { provisionFixture, mountOptions } from "./fixture.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { CollabError } from "../../src/collab/errors.ts";
import { runWithAgentScope, scopeFor } from "../../src/collab/scope.ts";
import { containedTerminal, containedWrite, findHardlink } from "../../src/external-agents/containment.ts";
import { ExternalDelegationTarget } from "../../src/external-agents/delegation.ts";
import { tempDir } from "../helpers/temp-dir.ts";

function gitWorktree(root: string): { worktree: string; home: string; outside: string } {
  const home = join(root, "home");
  const repo = join(root, "repo");
  let worktree: string;
  const outside = join(root, "outside.txt");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"], { stdio: "pipe" });
  worktree = provisionFixture(home, repo);
  writeFileSync(outside, "safe");
  return { worktree, home, outside };
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

test("an existing hard link refuses the terminal and leaves the outside file unchanged", async () => {
  const root = tempDir("m6b-hl-have-");
  const { worktree, home, outside } = gitWorktree(root);
  linkSync(outside, join(worktree, "hard"));
  const logs: { event: string; fields?: Record<string, number | string> }[] = [];
  const result = await containedTerminal({
    argv: ["/usr/bin/true"],
    worktree, home, ...mountOptions(worktree),
    log: (event, fields) => logs.push({ event, ...(fields ? { fields } : {}) }),
  });
  assert.deepEqual(result, { ok: false, reason: "hardlink-in-worktree" });
  assert.equal(readFileSync(outside, "utf8"), "safe");
  assert.equal(logs[0]?.event, "hardlink-in-worktree");
  assert.equal(logs[0]?.fields?.count, 1);
  assert.equal(logs[0]?.fields?.path, "hard");
  assert.equal(findHardlink(worktree)?.path, "hard");
});

test("a hard link created inside the sandbox does not change the outside file", async () => {
  const root = tempDir("m6b-hl-new-");
  const { worktree, home, outside } = gitWorktree(root);
  const script = join(worktree, "link.cjs");
  writeFileSync(script, `const fs = require("fs");
const [src, dst] = process.argv.slice(2);
try { fs.linkSync(src, dst); console.log("OK"); }
catch (e) { console.log(e.code); }
`);
  const dst = join(worktree, "new-hard");
  const run = (src: string) => containedTerminal({ argv: [process.execPath, script, src, dst], worktree, home, ...mountOptions(worktree), timeoutMs: 15_000 });
  if (process.platform === "linux") {
    const hidden = join(root, "not-mounted.txt");
    writeFileSync(hidden, "safe");
    const missing = await run(hidden);
    assert.equal(missing.ok, true);
    if (missing.ok) assert.match(missing.stdout, /ENOENT/);
    const system = await run("/etc/passwd");
    assert.equal(system.ok, true);
    if (system.ok) assert.match(system.stdout, /EXDEV/);
  } else if (process.platform === "darwin") {
    const created = await run(outside);
    assert.equal(created.ok, true, JSON.stringify(created));
    if (created.ok) assert.match(created.stdout, /EPERM/);
    assert.equal(existsSync(dst), false);
  } else {
    const refused = await containedTerminal({ argv: [process.execPath, script], worktree, home, ...mountOptions(worktree), platform: "win32" });
    assert.deepEqual(refused, { ok: false, reason: "sandbox-unavailable" });
  }
  assert.equal(readFileSync(outside, "utf8"), "safe");
});

test("a symlink out of the worktree is still refused on write", async () => {
  const root = tempDir("m6b-hl-sym-");
  const { worktree, home, outside } = gitWorktree(root);
  symlinkSync(outside, join(worktree, "link"));
  await assert.rejects(() => containedWrite({ worktree, home }, join(worktree, "link"), "pwned"), (e: unknown) => e instanceof Error);
  assert.equal(readFileSync(outside, "utf8"), "safe");
});

test("Windows terminal stays refused", async () => {
  const refused = await containedTerminal({ argv: ["/bin/true"], worktree: "/tmp", home: "/tmp", platform: "win32" });
  assert.deepEqual(refused, { ok: false, reason: "sandbox-unavailable" });
});

test("pnpm installs and builds offline; the next Linux mount refuses its resulting hardlinks", async () => {
  const pnpm = onPath("pnpm");
  assert.ok(pnpm, "pnpm is on PATH");
  const entry = pnpmEntry(pnpm);
  assert.ok(entry, "pnpm package can be copied into the worktree");
  const root = tempDir("m6b-hl-pnpm-");
  const { worktree, home } = gitWorktree(root);
  cpSync(dirname(dirname(entry)), join(worktree, "pnpm-pkg"), { recursive: true });
  const vendor = join(worktree, "vendor", "tiny-lib");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "package.json"), JSON.stringify({ name: "tiny-lib", version: "1.0.0", main: "index.js" }));
  writeFileSync(join(vendor, "index.js"), "module.exports = 1\n");
  writeFileSync(join(worktree, "package.json"), JSON.stringify({ name: "app", private: true, scripts: { build: `${JSON.stringify(process.execPath)} build.cjs` }, dependencies: { "tiny-lib": "file:./vendor/tiny-lib" } }));
  mkdirSync(join(worktree, "src"));
  writeFileSync(join(worktree, "src", "index.ts"), "import tiny from 'tiny-lib'; const answer: number = tiny + 41; console.log(answer); export { answer };\n");
  writeFileSync(join(worktree, "build.cjs"), "const fs=require('fs');const {stripTypeScriptTypes}=require('node:module');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.mjs',stripTypeScriptTypes(fs.readFileSync('src/index.ts','utf8')));\n");
  const script = join(worktree, "install.cjs");
  const localEntry = join(worktree, "pnpm-pkg", "bin", "pnpm.cjs");
  const store = join(worktree, "store");
  writeFileSync(script, `const { spawn } = require("child_process");
const child = spawn(process.execPath, ${JSON.stringify([localEntry, "install", "--offline", "--ignore-scripts", "--store-dir", store, "--dir", worktree])}, { cwd: ${JSON.stringify(worktree)}, stdio: "inherit" });
child.on("exit", (code) => {
  if(code!==0) process.exit(code??1);
  const build=spawn(process.execPath, ${JSON.stringify([localEntry, "run", "build"])}, {cwd:${JSON.stringify(worktree)},stdio:"inherit"});
  build.on("exit",code=>{
    if(code!==0) process.exit(code??1);
    const check=spawn(process.execPath,["dist/index.mjs"],{cwd:${JSON.stringify(worktree)},stdio:"inherit"});
    check.on("exit",code=>process.exit(code??1));
  });
});
`);
  const result = await containedTerminal({ argv: [process.execPath, script], worktree, home, ...mountOptions(worktree), timeoutMs: 60_000 });
  assert.equal(result.ok && result.exitCode, 0, JSON.stringify(result));
  assert.ok(result.ok && /42/.test(result.stdout), JSON.stringify(result));
  assert.doesNotMatch(readFileSync(join(worktree, "dist", "index.mjs"), "utf8"), /: number/);
  const installed = join(worktree, "node_modules", "tiny-lib", "index.js");
  // Owner #820 Q3: Linux checks every alias before EACH mount. Same-run internal links are possible;
  // macOS denies file-link entirely. Neither backend permits linking an external source.
  assert.equal(statSync(installed).nlink, process.platform === "linux" ? 2 : 1);
  if (process.platform === "linux") assert.deepEqual(
    await containedTerminal({ argv: ["/usr/bin/true"], worktree, home, ...mountOptions(worktree) }),
    { ok: false, reason: "hardlink-in-worktree" },
  );
  assert.equal(spawnSync(process.execPath, ["-e", "process.exit(require(process.argv[1]) === 1 ? 0 : 2)", installed]).status, 0);
});

function pnpmEntry(bin: string): string | null {
  let dir = dirname(realpathSync(bin));
  for (let i = 0; i < 5; i++) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const name = JSON.parse(readFileSync(manifest, "utf8")).name;
        const found = join(dir, "bin", "pnpm.cjs");
        if (name === "pnpm" && existsSync(found)) return found;
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

test("a session is not opened when the worktree already contains a hard link", async () => {
  const root = tempDir("m6b-hl-ses-");
  const { worktree, home, outside } = gitWorktree(root);
  linkSync(outside, join(worktree, "hard"));
  let started = false;
  const target = new ExternalDelegationTarget({
    engineOf: () => ({ kind: "external", connector: "agy", maxTurns: 1, timeoutMs: 1000 }),
    worktreeOf: () => worktree,
    home,
    sessions: () => { throw new Error("no session"); },
    approvals: async () => null,
    connect: () => { started = true; throw new Error("started"); },
    log: () => {},
  });
  await runWithAgentScope(scopeFor("coder", "prj"), async () => {
    await assert.rejects(
      () => target.run({ agentId: "coder", question: "q", context: "", signal: AbortSignal.timeout(5000) }),
      (e: unknown) => e instanceof CollabError && e.reason === "hardlink-in-worktree",
    );
  });
  assert.equal(started, false);
  assert.equal(readFileSync(outside, "utf8"), "safe");
});
