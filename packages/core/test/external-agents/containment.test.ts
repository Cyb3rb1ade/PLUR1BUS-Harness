import { provisionFixture, mountOptions, limitsHelper } from "./fixture.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { ContainmentError, containedRead, containedTerminal, containedWrite, gitDenyPaths } from "../../src/external-agents/containment.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { launchExternalAgent, type LaunchHandle } from "../../src/external-agents/launcher.ts";
import { detectSandbox } from "../../src/tools/sandbox/backends.ts";

function gitWorktree(root: string): { repo: string; worktree: string; home: string } {
  const home = join(root, "home");
  const repo = join(root, "repo");
  let worktree: string;
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"], { stdio: "pipe" });
  worktree = provisionFixture(home, repo);
  return { repo, worktree, home };
}

const reason = (e: unknown) => e instanceof ContainmentError && e.reason;

test("filesystem writes stay in the worktree", async () => {
  const root = tempDir("m6b-fs-");
  const { worktree, home } = gitWorktree(root);
  const box = { worktree, home };
  await containedWrite(box, join(worktree, "ok.txt"), "hello");
  assert.equal(await containedRead(box, join(worktree, "ok.txt")), "hello");
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "secret");
  symlinkSync(outside, join(worktree, "link"));
  await assert.rejects(containedWrite(box, join(worktree, "link"), "x"), (e) => reason(e) === "outside-root" || reason(e) === "deny-listed");
  await assert.rejects(containedWrite(box, join(worktree, "..", "outside.txt"), "x"), (e) => typeof reason(e) === "string");
  await assert.rejects(containedWrite(box, outside, "x"), (e) => reason(e) === "outside-root" || reason(e) === "deny-listed");
  await assert.rejects(containedWrite(box, join(home, "notes.txt"), "x"), (e) => reason(e) === "deny-listed" || reason(e) === "outside-root");
  const target = join(root, "hard-target.txt");
  writeFileSync(target, "a");
  try { linkSync(target, join(worktree, "hard")); } catch { return; }
  await assert.rejects(containedWrite(box, join(worktree, "hard"), "b"), (e) => reason(e) === "hard-link");
});

test("a worktree under the harness home stays writable and the rest of home does not", async () => {
  const root = tempDir("m6b-fs-home-");
  const home = join(root, "home");
  const repo = join(root, "repo");
  const worktree = join(home, "state", "worktrees", "prj", "prj");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", "p1b/demo-abcdef/main", worktree, "main"], { stdio: "pipe" });
  const box = { worktree, home };
  await containedWrite(box, "inside.txt", "yes");
  assert.equal(await containedRead(box, "inside.txt"), "yes");
  await assert.rejects(containedWrite(box, join(home, "secret.txt"), "no"), (e) => typeof reason(e) === "string");
  assert.equal(existsSync(join(home, "secret.txt")), false);
});

test("windows name rules refuse 8.3 and device names through the same canonicaliser", async () => {
  const root = tempDir("m6b-win-");
  const { worktree, home } = gitWorktree(root);
  const box = { worktree, home, ...mountOptions(worktree), windowsRules: true };
  await assert.rejects(containedWrite(box, join(worktree, "CON"), "x"), (e) => typeof reason(e) === "string");
  await assert.rejects(containedWrite(box, join(worktree, "NOTES~1.TXT"), "x"), (e) => typeof reason(e) === "string");
  await assert.rejects(() => containedRead(box, join(worktree, "ok.txt:secret")), (e) => typeof reason(e) === "string");
});

test("terminal callbacks are refused on Windows and cannot write the shared gitdir", async () => {
  const refused = await containedTerminal({ argv: ["/bin/true"], worktree: "/tmp", home: "/tmp", platform: "win32" });
  assert.deepEqual(refused, { ok: false, reason: "sandbox-unavailable" });
  if (process.platform === "win32") return;
  const root = tempDir("m6b-term-");
  const { repo, worktree, home } = gitWorktree(root);
  const touch = process.platform === "darwin" ? "/usr/bin/touch" : "/usr/bin/touch";
  const inside = await containedTerminal({ argv: [touch, join(worktree, "from-terminal.txt")], worktree, home, ...mountOptions(worktree) });
  assert.equal(inside.ok, true, JSON.stringify(inside));
  if (inside.ok) assert.equal(inside.exitCode, 0, inside.stderr);
  assert.equal(existsSync(join(worktree, "from-terminal.txt")), true);
  const hook = join(repo, ".git", "hooks", "pre-commit");
  const denied = await containedTerminal({ argv: [touch, hook], worktree, home, ...mountOptions(worktree) });
  assert.equal(existsSync(hook), false);
  if (denied.ok) assert.notEqual(denied.exitCode, 0);
  const git = process.platform === "darwin" ? "/usr/bin/git" : "/usr/bin/git";
  const cfg = await containedTerminal({ argv: [git, "-C", repo, "config", "core.hooksPath", "/tmp/evil"], worktree, home, ...mountOptions(worktree) });
  if (cfg.ok) assert.notEqual(cfg.exitCode, 0, cfg.stderr);
  let hooks = "";
  try { hooks = execFileSync("git", ["-C", repo, "config", "--get", "core.hooksPath"], { encoding: "utf8" }).trim(); } catch { hooks = ""; }
  assert.equal(hooks.includes("/tmp/evil"), false);
  assert.ok(gitDenyPaths(worktree).some((p) => p.endsWith("/hooks") || p.endsWith("\\hooks") || p.includes(".git")));
});

test("the agent process itself confines direct filesystem and TCP access", { timeout: 30000 }, async t => {
  if (process.platform === "win32") {
    await assert.rejects(launchExternalAgent({ argv: [process.execPath], cwd: "/missing" }), /sandbox-unavailable/);
    return;
  }
  const detection = await detectSandbox(limitsHelper);
  if (process.platform === "linux" && !detection.available && !process.env.CI) {
    t.skip(detection.reason);
    return;
  }
  // Missing/disabled bwrap must fail on CI, where the runner installs it. macOS acceptance is mandatory too.
  assert.equal(detection.available, true, detection.reason);
  const root = tempDir("m6b-agent-process-");
  const { repo, worktree, home } = gitWorktree(root);
  const gitDir = realpathSync(execFileSync("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim());
  const commonGitDir = realpathSync(join(repo, ".git"));
  assert.notEqual(gitDir, commonGitDir, "exercise both linked-worktree metadata directories");
  const inside = join(worktree, "agent-output");
  const outside = join(root, "outside-canary");
  const gitMarker = join(gitDir, "agent-must-not-write");
  const commonMarker = join(commonGitDir, "agent-must-not-write");
  const testHome = join(root, "test-home");
  mkdirSync(join(testHome, ".ssh"), { recursive: true });
  const privateFile = join(testHome, ".ssh", "id_test");
  writeFileSync(privateFile, "PRIVATE-FIXTURE");
  writeFileSync(outside, "unchanged");
  let connections = 0;
  const listenerErrors: Error[] = [];
  const listener = createServer(socket => {
    connections++;
    // A regressed agent closes immediately after connect; its reset must reach the assertions below.
    socket.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") listenerErrors.push(error); });
    socket.end("listener-ready");
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  let agent: LaunchHandle | undefined;
  try {
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    const checkListener = () => new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      let data = "";
      socket.setTimeout(2000, () => socket.destroy(new Error("listener control timed out")));
      socket.on("data", chunk => { data += chunk; });
      socket.once("error", reject);
      socket.once("end", () => {
        socket.destroy();
        try { assert.equal(data, "listener-ready"); resolve(); } catch (error) { reject(error); }
      });
    });
    await checkListener();
    // These are the stub agent's own syscalls: no AcpClient, containment callbacks or terminal requests.
    const script = join(worktree, "direct-agent.cjs");
    writeFileSync(script, `const fs = require("node:fs"), net = require("node:net");
const result = {};
for (const [name, path] of ${JSON.stringify([["inside", inside], ["outside", outside], ["gitDir", gitMarker], ["commonGitDir", commonMarker]])}) {
  try { fs.writeFileSync(path, "agent-write"); result[name] = "allowed"; }
  catch (error) { result[name] = error.code; }
}
try { result.privateRead = fs.readFileSync(${JSON.stringify(privateFile)}, "utf8"); }
catch (error) { result.privateRead = error.code; }
const socket = net.createConnection({ host: "127.0.0.1", port: ${port} });
socket.setTimeout(2000, () => { result.tcp = "timeout"; socket.destroy(); });
socket.once("connect", () => { result.tcp = "allowed"; socket.destroy(); });
socket.once("error", error => { result.tcp = error.code; });
socket.once("close", () => { process.stdout.write(JSON.stringify(result)); });
`);
    agent = await launchExternalAgent({ argv: [process.execPath, script], cwd: worktree, worktree, home,
      ...mountOptions(worktree), timeoutMs: 10000 });
    let stdout = "", stderr = "";
    agent.stdout.on("data", chunk => { stdout += chunk; });
    agent.stderr.on("data", chunk => { stderr += chunk; });
    assert.equal(await agent.exited, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.inside, "allowed");
    assert.equal(readFileSync(inside, "utf8"), "agent-write");
    for (const name of ["outside", "gitDir", "commonGitDir", "privateRead"])
      assert.ok(["EACCES", "EPERM", "EROFS", "ENOENT"].includes(result[name]), `${name}: ${stdout}`);
    assert.ok(["EACCES", "EPERM", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"].includes(result.tcp), stdout);
    assert.equal(readFileSync(outside, "utf8"), "unchanged");
    assert.equal(readFileSync(privateFile, "utf8"), "PRIVATE-FIXTURE");
    assert.equal(existsSync(gitMarker), false);
    assert.equal(existsSync(commonMarker), false);
    // The listener remains reachable from the host before and after the agent's denied connection.
    await checkListener();
    assert.equal(connections, 2, "only the two host controls reached the listener");
    assert.deepEqual(listenerErrors, []);
  } finally {
    if (agent) { agent.stop(); await agent.exited; }
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
});
