import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, existsSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { layout } from "../src/paths.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const dist = fileURLToPath(new URL("../dist/core.js", import.meta.url));
// Rebuild when dist is missing or older than any src file, so these tests never run a stale core.
const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const newestSrc = Math.max(...readdirSync(srcDir, { recursive: true }).map((f) => statSync(join(srcDir, String(f))).mtimeMs));
if (!existsSync(dist) || statSync(dist).mtimeMs < newestSrc) execFileSync("pnpm", ["build"], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "inherit", shell: process.platform === "win32" });

function startCore(home: string) {
  const child = spawn(process.execPath, [dist, "--home", home, "--test-internals", "flat-embedder"], { env: { ...process.env, PLUR1BUS_ALLOW_TEST_INTERNALS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise<{ address: string }>((res, rej) => { child.stdout.once("data", (d) => res(JSON.parse(String(d)))); child.once("exit", (c) => rej(new Error(`exited ${c}`))); });
  return { child, ready };
}

/** Graceful stop. POSIX: SIGTERM. Windows has no deliverable SIGTERM (child.kill terminates hard, exit code null),
 *  so there the core is stopped the way the H2 supervisor will stop it: a core.shutdown RPC. */
async function stopGracefully(child: ReturnType<typeof spawn>, home: string, address: string): Promise<number | null> {
  const exited = new Promise<number | null>((r) => child.once("exit", r));
  if (process.platform === "win32") {
    const c = await connect({ address, token: readFileSync(layout(home).coreToken, "utf8") });
    await c.call("core.shutdown", {}); await c.close();
  } else child.kill("SIGTERM");
  return exited;
}

describe("dist/core.js", () => {
  it("starts, answers status, stops cleanly on SIGTERM; a second start exits 3", async () => {
    const home = tempDir("p1b-bin-"); const l = layout(home);
    const cfg = defaults(); cfg.agents.bernd = {}; cfg.engine = { reranker: { enabled: false }, dreaming: { enabled: false }, neo: { enabled: false } };
    writeFileSync(l.configPath, JSON.stringify(cfg));
    const { child, ready } = startCore(home); const { address } = await ready;
    const token = readFileSync(l.coreToken, "utf8");
    const c = await connect({ address, token }); assert.equal((await c.call<any>("core.status")).process.state, "ready"); await c.close();
    const second = startCore(home); second.ready.catch(() => {}); // exit 3 is expected here; avoid an unhandled rejection from the unawaited `ready` promise
    const code = await new Promise<number | null>((r) => second.child.once("exit", r)); assert.equal(code, 3);
    assert.equal(await stopGracefully(child, home, address), 0);
    assert.equal(existsSync(l.coreSocket) && process.platform !== "win32", false, "socket removed");
  });
  it("I1: exits 0 within a few seconds after a core.shutdown RPC, lock released and socket removed", async () => {
    const home = tempDir("p1b-bin-"); const l = layout(home);
    const cfg = defaults(); cfg.agents.bernd = {}; cfg.engine = { reranker: { enabled: false }, dreaming: { enabled: false }, neo: { enabled: false } };
    writeFileSync(l.configPath, JSON.stringify(cfg));
    const { child, ready } = startCore(home); const { address } = await ready;
    const exited = new Promise<number | null>((r) => child.once("exit", r));
    const c = await connect({ address, token: readFileSync(l.coreToken, "utf8") });
    assert.deepEqual(await c.call<any>("core.shutdown", {}), { accepted: true }); await c.close();
    let timer: NodeJS.Timeout | undefined;
    const code = await Promise.race([exited, new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), 5000); })]);
    clearTimeout(timer);
    if (code === "timeout") child.kill("SIGKILL");
    assert.equal(code, 0, "the core process exits after core.shutdown");
    assert.equal(existsSync(l.coreToken), false, "run files removed");
    assert.equal(existsSync(l.coreSocket) && process.platform !== "win32", false, "socket removed");
    const next = startCore(home); const nextReady = await next.ready; // the lock was released: a new core starts on the same home
    assert.equal(await stopGracefully(next.child, home, nextReady.address), 0);
  });
  it("refuses --test-internals without the env guard", async () => {
    const child = spawn(process.execPath, [dist, "--home", tempDir("p1b-bin-"), "--test-internals", "flat-embedder"], { stdio: "ignore" });
    assert.equal(await new Promise((r) => child.once("exit", r)), 2);
  });
  it("R20.5: a second SIGTERM while stopping is ignored, not a crash", { skip: process.platform === "win32" && "POSIX signal semantics; on Windows the core is stopped via core.shutdown" }, async () => {
    const home = tempDir("p1b-bin-");
    const cfg = defaults(); cfg.agents.bernd = {}; cfg.engine = { reranker: { enabled: false }, dreaming: { enabled: false }, neo: { enabled: false } };
    writeFileSync(layout(home).configPath, JSON.stringify(cfg));
    const { child, ready } = startCore(home); await ready;
    child.kill("SIGTERM"); child.kill("SIGTERM"); // fired back-to-back, before the first stop() settles
    const exit = await new Promise<number | null>((r) => child.once("exit", r));
    assert.equal(exit, 0);
  });
  it("--lifeline other than stdin exits 2", async () => {
    const child = spawn(process.execPath, [dist, "--home", tempDir("p1b-bin-"), "--lifeline", "fd3"], { stdio: "ignore" });
    assert.equal(await new Promise((r) => child.once("exit", r)), 2);
  });
  it("--instance not a uuid exits 2", async () => {
    const child = spawn(process.execPath, [dist, "--home", tempDir("p1b-bin-"), "--instance", "not-a-uuid"], { stdio: "ignore" });
    assert.equal(await new Promise((r) => child.once("exit", r)), 2);
  });
  it("--lifeline stdin: stdin EOF orphans the core and it exits 0 after the grace; core.pid names --instance", async () => {
    const home = tempDir("p1b-bin-"); const l = layout(home);
    const cfg = defaults(); cfg.agents.bernd = {}; cfg.supervisor.graceMs = 1000; cfg.engine = { reranker: { enabled: false }, dreaming: { enabled: false }, neo: { enabled: false } };
    writeFileSync(l.configPath, JSON.stringify(cfg));
    const instance = "0b6f3c2e-6d7a-4c1e-9f3b-2a5d8e7c1f40";
    const child = spawn(process.execPath, [dist, "--home", home, "--test-internals", "flat-embedder", "--lifeline", "stdin", "--instance", instance],
      { env: { ...process.env, PLUR1BUS_ALLOW_TEST_INTERNALS: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<number | null>((r) => child.once("exit", r));
    const { address } = await new Promise<{ address: string }>((res, rej) => { child.stdout.once("data", (d) => res(JSON.parse(String(d)))); child.once("exit", (c) => rej(new Error(`exited ${c}`))); });
    assert.equal(readFileSync(l.corePid, "utf8"), `${child.pid} ${instance}\n`);
    child.stdin.end();
    const c = await connect({ address, token: readFileSync(l.coreToken, "utf8") });
    const t0 = Date.now(); let state = "";
    while (Date.now() - t0 < 3000 && state !== "orphaned") { state = (await c.call<any>("core.status")).process.state; if (state !== "orphaned") await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(state, "orphaned");
    let timer: NodeJS.Timeout | undefined;
    const code = await Promise.race([exited, new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), 8000); })]);
    clearTimeout(timer); await c.close();
    if (code === "timeout") child.kill("SIGKILL");
    assert.equal(code, 0, "exits 0 once the grace expires");
    assert.equal(existsSync(l.corePid), false, "run files removed");
  });

  it("--lifeline stdin: a dead supervisor's stdout/stderr pipes (EPIPE) do not crash the grace-expiry stop", { skip: process.platform === "win32" && "EPIPE on a closed pipe reader is POSIX; Windows reports a broken pipe differently" }, async () => {
    const home = tempDir("p1b-bin-"); const l = layout(home);
    const cfg = defaults(); cfg.agents.bernd = {}; cfg.supervisor.graceMs = 1000;
    writeFileSync(l.configPath, JSON.stringify(cfg));
    // The supervisor gives the core real OS pipes (a Node parent would give socketpairs, whose closed peer does not
    // fail a write the same way): a FIFO whose only reader this test closes is exactly the pipe a SIGKILLed supervisor leaves.
    const fifo = join(home, "out.fifo"); execFileSync("mkfifo", [fifo]);
    let reader: number | null = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK); const writer = openSync(fifo, constants.O_WRONLY);
    const child = spawn(process.execPath, [dist, "--home", home, "--test-internals", "flat-embedder", "--lifeline", "stdin"],
      { env: { ...process.env, PLUR1BUS_ALLOW_TEST_INTERNALS: "1" }, stdio: ["pipe", writer, writer] });
    closeSync(writer);
    const exited = new Promise<number | null>((r) => child.once("exit", r));
    try {
      const t0 = Date.now();
      // core.pid is written just before the socket listens (S6), so wait for the socket too; its stdout (the ready line) goes to the FIFO.
      const up = () => existsSync(l.corePid) && existsSync(l.coreSocket);
      while (!up() && child.exitCode === null && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
      assert.ok(up(), "the core became ready");
      // Exercise the engine (default engine config, one capture) the way a real session does before its supervisor dies.
      const c = await connect({ address: l.coreSocket, token: readFileSync(l.coreToken, "utf8") });
      try {
        const cap = await c.call<any>("memory.capture", { caller: { channel: "cli", accountId: "a1", userId: "u1" }, agentId: "bernd", sessionKey: "s1", wait: true, waitMs: 10_000,
          messages: [{ role: "user", content: "Please remember that the boiler service is on Tuesday." }, { role: "assistant", content: "Noted." }] });
        assert.equal(cap.stored, 1, JSON.stringify(cap));
      } finally { await c.close(); }
      // Nobody reads the core's stdout/stderr any more, and its stdin lifeline is at EOF.
      closeSync(reader); reader = null; child.stdin!.end();
      let timer: NodeJS.Timeout | undefined;
      const code = await Promise.race([exited, new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), 8000); })]);
      clearTimeout(timer);
      assert.equal(code, 0, "the stop after the grace completes and exits 0");
      assert.equal(existsSync(l.corePid), false, "run files removed");
      assert.equal(existsSync(join(home, "run", "core.sock")), false, "socket removed");
    } finally {
      // An early failure must not leave the core running or the FIFO's read end open.
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      if (reader !== null) closeSync(reader);
    }
  });
});
