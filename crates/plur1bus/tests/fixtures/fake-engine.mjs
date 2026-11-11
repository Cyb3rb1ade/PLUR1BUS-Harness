// A stand-in for `plur1bus-engine serve` in the supervisor's engine-slot tests (no dependencies, no engine build).
// The test hard-links Node as `plur1bus-engine` into a directory that also holds a file named `serve`; the supervisor
// runs that directory as its working directory, so `plur1bus-engine serve --home <home> --lifeline stdin --instance
// <id>` is Node running `./serve`, which imports this file (FAKE_ENGINE_JS). The process the supervisor spawned is
// the one that serves, as with the real binary.
//
// It writes a fresh run/engine.token and `<pid> <instanceId>` to run/engine.pid, listens on the engine address and
// answers engine.auth (token + clientId), engine.status (with the `process` object), engine.adopt and engine.shutdown.
//
// Where it differs from the real engine (docs/engine-process.md), on purpose or for lack of a Node API:
// - Single instance: an SQLite EXCLUSIVE lock on state/fake-engine.lock (held → exit 3), not the OS-held
//   run/engine.process.lock plus the incarnation-aware JobLock stamp. There is no stamp-age rule, no stamp take-over
//   after a crash and no `endpoint-live` refusal; its exit 3 means only "another fake holds the lock".
// - run/engine.process.lock (the OS lock the supervisor and `backup restore` test) is held only when
//   FAKE_ENGINE_LOCK_HELPER names a helper process (a JSON argv) that takes it with the same OS lock the Rust code
//   uses and holds it until its stdin closes, i.e. until this process is gone. Without it the file is not locked.
// - The run files are written before `listen` (the real engine publishes them after binding).
// - A method before engine.auth is answered `auth-required` and the connection stays open (the real engine closes it).
// - No home checks: the real engine refuses (exit 2) a home reached through a symlink or open to other users.
// - Its status is the recorded contract fixture with a ready embedder; nothing is composed.
//
// FAKE_ENGINE_MODE picks its behaviour:
//   ok                serve until engine.shutdown or lifeline loss
//   exit:<code>       exit with <code> at once, before any lock
//   crash-after:<ms>  serve, then exit 1 <ms> after it listens
//   hang              listen, but never answer anything (not even engine.auth)
// In every mode it stops answering (and ignores its lifeline) once <home>/state/fake-engine-hang exists.
// FAKE_ENGINE_LATER_MODE (with PLUR1BUS_ALLOW_TEST_INTERNALS=1): the mode of every engine of a home but the first.
// FAKE_ENGINE_STATUS (JSON) is merged over engine.status's top-level members.
// FAKE_ENGINE_GRACE_MS: the orphan grace after the lifeline is lost (default 1000).
// Every event (started, os-lock, listening, shutdown, orphaned, adopted, exiting) is appended as one JSON line to
// $FAKE_ENGINE_EVENTS with `role: "engine"`.
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { home: { type: "string" }, "test-internals": { type: "string" }, lifeline: { type: "string" }, instance: { type: "string" } },
  allowPositionals: true,
  strict: true,
});
const home = path.resolve(values.home ?? ".");
const instanceId = values.instance ?? "00000000-0000-4000-8000-000000000000";
const run = path.join(home, "run");
const stateDir = path.join(home, "state");
mkdirSync(run, { recursive: true });
mkdirSync(stateDir, { recursive: true });
const hangFile = path.join(stateDir, "fake-engine-hang");

function laterEngine() {
  try { writeFileSync(path.join(stateDir, "fake-engine-first"), `${process.pid}\n`, { flag: "wx" }); return false; } catch { return true; }
}
const internals = process.env.PLUR1BUS_ALLOW_TEST_INTERNALS === "1";
const mode = internals && process.env.FAKE_ENGINE_LATER_MODE && laterEngine()
  ? process.env.FAKE_ENGINE_LATER_MODE
  : process.env.FAKE_ENGINE_MODE ?? "ok";
const [kind, a] = mode.split(":");
const hung = () => kind === "hang" || existsSync(hangFile);

function event(name, extra = {}) {
  const file = process.env.FAKE_ENGINE_EVENTS;
  if (!file) return;
  appendFileSync(file, JSON.stringify({ role: "engine", event: name, pid: process.pid, instanceId, at: Date.now(), ...extra }) + "\n");
}
function exit(code) {
  event("exiting", { code });
  process.exit(code);
}

event("started", { mode, lifeline: values.lifeline ?? null, testInternals: values["test-internals"] ?? null, home, cwd: process.cwd() });
process.stderr.write(`fake-engine stderr marker pid=${process.pid}\n`);
if (kind === "exit") exit(Number(a));

const lock = new DatabaseSync(path.join(stateDir, "fake-engine.lock"));
try {
  lock.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE;");
  lock.exec("CREATE TABLE IF NOT EXISTS holder(pid INTEGER NOT NULL)");
  lock.exec("BEGIN EXCLUSIVE");
} catch {
  lock.close();
  event("locked");
  exit(3);
}
globalThis.fakeEngineLock = lock;
process.on("exit", () => { try { globalThis.fakeEngineLock.close(); } catch { /* already closed */ } });

// The OS-held process lock through the test's helper: taken before the endpoint, released when this process ends.
if (process.env.FAKE_ENGINE_LOCK_HELPER) {
  const [command, ...args] = JSON.parse(process.env.FAKE_ENGINE_LOCK_HELPER);
  const helper = spawn(command, args, {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, ENGINE_LOCK_HOLDER_PATH: path.join(run, "engine.process.lock") },
    windowsHide: true,
  });
  globalThis.fakeEngineLockHelper = helper;
  await new Promise((resolve) => {
    let out = "";
    helper.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
      if (out.includes("engine-lock-held")) resolve();
    });
    helper.on("exit", () => { event("lock-helper-gone"); exit(3); });
  });
  event("os-lock");
}

const address = process.platform === "win32"
  ? `\\\\.\\pipe\\plur1bus-${createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, 16)}-engine`
  : path.join(run, "engine.sock");
if (process.platform !== "win32") rmSync(address, { force: true });
const token = randomBytes(32).toString("hex");
const started = Date.now();

// The frozen status shape, taken from the engine crate's recorded contract fixture so the models block stays valid.
const fixture = JSON.parse(readFileSync(new URL("../../../plur1bus-engine/tests/fixtures/contract/engine-status.json", import.meta.url), "utf8"));
let state = "ready";
let orphanedSince = null;
let stopping = false;
let lifeline = null;
let graceTimer = null;

function status() {
  const models = structuredClone(fixture.models);
  models.embedder.state = "ready";
  models.embedder.checkedAt = started;
  const base = {
    ...structuredClone(fixture),
    ready: true,
    degraded: null,
    contract: "1.18.0",
    jobs: { ledger: "ok", agents: [] },
    journal: { entries: 0, oldestAt: null },
    models,
    rpc: "1.25.0",
    instanceId,
    pid: process.pid,
    process: { state, orphanedSince },
  };
  return { ...base, ...(process.env.FAKE_ENGINE_STATUS ? JSON.parse(process.env.FAKE_ENGINE_STATUS) : {}) };
}

function removeRunFiles() {
  rmSync(path.join(run, "engine.token"), { force: true });
  rmSync(path.join(run, "engine.pid"), { force: true });
}

function lost(source) {
  if (hung() || stopping || lifeline !== source) return;
  lifeline = null;
  if (graceTimer) return;
  state = "orphaned";
  orphanedSince = Date.now();
  event("orphaned");
  graceTimer = setTimeout(() => {
    if (hung()) return;
    removeRunFiles();
    exit(0);
  }, Number(process.env.FAKE_ENGINE_GRACE_MS ?? 1000));
}

function shutdown(budgetMs) {
  if (stopping) return;
  stopping = true;
  state = "stopping";
  event("shutdown", { budgetMs: budgetMs ?? null });
  server.close();
  removeRunFiles();
  setTimeout(() => exit(0), 20);
}

const capabilities = { methods: {}, notifications: {}, extensionPoints: {}, features: [] };
const server = net.createServer((sock) => {
  let buf = "";
  let authed = false;
  sock.on("error", () => {});
  sock.on("close", () => lost(sock));
  const send = (msg) => { if (!sock.destroyed) sock.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n"); };
  const refuse = (id, reason) => send({ id, error: { code: -32000, message: reason, data: { error: "E_UNAUTHORIZED", reason } } });
  const handle = (msg) => {
    if (hung()) return;
    const { id, method, params = {} } = msg;
    if (id === undefined) return;
    if (method === "engine.auth") {
      const t = Buffer.from(String(params.token ?? ""));
      if (t.length !== 64 || !timingSafeEqual(t, Buffer.from(token)) || typeof params.clientId !== "string" || !params.clientId) {
        refuse(id, "bad-token");
        sock.end();
        return;
      }
      authed = true;
      send({ id, result: { contract: "1.18.0", rpc: "1.25.0", instanceId, pid: process.pid, capabilities } });
      return;
    }
    if (!authed) { refuse(id, "auth-required"); return; }
    if (method === "engine.status") { send({ id, result: status() }); return; }
    if (method === "engine.adopt") {
      if (stopping) {
        send({ id, error: { code: -32000, message: "engine is stopping", data: { error: "E_NOT_AVAILABLE", reason: "stopping" } } });
        return;
      }
      let expected = null;
      try { expected = readFileSync(path.join(run, "supervisor.token"), "utf8").trim().toLowerCase(); } catch { /* refused below */ }
      const nonce = String(params.nonce ?? "").toLowerCase();
      if (expected === null || expected.length !== 64 || nonce !== expected) { refuse(id, "adopt-nonce"); return; }
      lifeline = sock;
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      state = "ready";
      orphanedSince = null;
      event("adopted");
      send({ id, result: { status: status() } });
      return;
    }
    if (method === "engine.shutdown") {
      send({ id, result: {} });
      shutdown(params.budgetMs);
      return;
    }
    send({ id, error: { code: -32601, message: `method not found: ${method}`, data: { error: "E_INTERNAL", reason: "method-not-found" } } });
  };
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { handle(JSON.parse(line)); } catch { /* not JSON: ignored */ }
    }
  });
});

writeFileSync(path.join(run, "engine.token"), token, { mode: 0o600 });
writeFileSync(path.join(run, "engine.pid"), `${process.pid} ${instanceId}\n`, { mode: 0o600 });
server.listen(address, () => {
  event("listening");
  if (kind === "crash-after") setTimeout(() => exit(1), Number(a));
});

if (values.lifeline === "stdin") {
  lifeline = "stdin";
  process.stdin.on("data", () => {});
  process.stdin.on("end", () => lost("stdin"));
  process.stdin.on("error", () => {});
}
