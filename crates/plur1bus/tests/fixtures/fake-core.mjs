// A stand-in for dist/core.js in the supervisor's Rust tests (no dependencies; on Windows it borrows the real core's
// packages/core/src/platform.ts to secure run/). It takes the same flags as core.js,
// takes state/core.lock the way core.ts does (SQLite EXCLUSIVE, released by the OS when the process dies; held → exit
// 3), writes run/core.token and run/core.pid and then listens on the same address like the real core, and answers
// core.auth, core.status, core.shutdown and core.adopt. FAKE_CORE_MODE picks its behaviour:
//   ok                    serve until core.shutdown or lifeline loss
//   crash-after:<ms>      serve, then exit 1 <ms> after it reports ready (on Windows: once run/ is secured)
//   exit:<code>           exit with <code> at once, before the lock
//   listen-after:<ms>     hold the lock and write the run files, but listen only after <ms> (a core still starting)
//   hang-after:<ms>       serve, then stop answering every request <ms> after it reports ready (on Windows: once run/
//                         is secured; no SIGTERM handler; event `hung`)
//   no-listen             start (run files not written) but never listen
//   slow-status:<n>:<ms>  delay the reply to the n-th core.status (counted across connections) by <ms>
// FAKE_CORE_ENGINE (JSON) replaces core.status's `engine` object (default: ready, not degraded).
// FAKE_CORE_JOBS (JSON) is core.status's `jobs` object (default: absent, as from a core without job health).
// FAKE_CORE_CONFIG_CHECK=1: exit 2 at start when <home>/config.json exists but is not JSON (core.js exits 2 on an
// invalid config.json).
// FAKE_CORE_RESTART_PENDING=1 (one-shot): the first core of a home (the one that creates state/fake-core-restart-pending)
// reports core.status config.restartPending true; every later one false (H3B-R7).
// Both need PLUR1BUS_ALLOW_TEST_INTERNALS=1.
// FAKE_CORE_WATCH_CONFIG=1: before listening, call config.watch on the supervisor (auth with run/supervisor.token) and
// wait up to 10 s for its reply, like core.js under a supervisor (B7); event `config-watched` { revision } or
// `config-watch-failed`. The connection stays open.
// Every event (started, listening, hung, shutdown, orphaned, adopted, exiting) is appended as one JSON line to $FAKE_CORE_EVENTS.
// The lifeline (S4) is stdin with --lifeline stdin, then the connection of the last successful core.adopt (whose nonce
// must equal run/supervisor.token, compared lower-cased). Losing the current lifeline reports `orphaned` and exits 0
// after FAKE_CORE_GRACE_MS (default 1000) unless a core.adopt arrives first.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { home: { type: "string" }, "test-internals": { type: "string" }, lifeline: { type: "string" }, instance: { type: "string" } },
  strict: true,
});
const home = path.resolve(values.home ?? ".");
const instanceId = values.instance ?? "00000000-0000-4000-8000-000000000000";
// FAKE_CORE_LATER_MODE (with PLUR1BUS_ALLOW_TEST_INTERNALS=1): the mode of every core of a home but the first (the one
// that creates state/fake-core-first); the first runs FAKE_CORE_MODE.
function laterCore() {
  mkdirSync(path.join(home, "state"), { recursive: true });
  try { writeFileSync(path.join(home, "state", "fake-core-first"), `${process.pid}\n`, { flag: "wx" }); return false; } catch { return true; }
}
const mode = process.env.PLUR1BUS_ALLOW_TEST_INTERNALS === "1" && process.env.FAKE_CORE_LATER_MODE && laterCore()
  ? process.env.FAKE_CORE_LATER_MODE
  : process.env.FAKE_CORE_MODE ?? "ok";
const started = Date.now();

function event(name, extra = {}) {
  const file = process.env.FAKE_CORE_EVENTS;
  if (!file) return;
  appendFileSync(file, JSON.stringify({ event: name, pid: process.pid, instanceId, at: Date.now(), ...extra }) + "\n");
}
function exit(code) {
  event("exiting", { code });
  process.exit(code);
}

event("started", { mode, lifeline: values.lifeline ?? null, testInternals: values["test-internals"] ?? null, home });
// A marker on stderr for the supervisor's out log.
process.stderr.write(`fake-core stderr marker pid=${process.pid}\n`);

const [kind, a, b] = mode.split(":");
if (kind === "exit") exit(Number(a));
if (process.env.FAKE_CORE_CONFIG_CHECK === "1") {
  try {
    JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") exit(2);
  }
}

// Like packages/core/src/lock.ts, before anything touches run/: a second core must not remove the first one's socket.
const stateDir = path.join(home, "state");
mkdirSync(stateDir, { recursive: true });
const lock = new DatabaseSync(path.join(stateDir, "core.lock"));
try {
  lock.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE;");
  lock.exec("CREATE TABLE IF NOT EXISTS holder(pid INTEGER NOT NULL)");
  lock.exec("BEGIN EXCLUSIVE");
} catch {
  lock.close();
  event("locked");
  exit(3);
}
// Held for the process lifetime: an unreferenced DatabaseSync is garbage-collected, and its finalizer unlocks and
// closes the file (a second core would then get the lock). The exit handler keeps it reachable and releases it.
globalThis.fakeCoreLock = lock;
process.on("exit", () => { try { globalThis.fakeCoreLock.close(); } catch { /* already closed */ } });
// Started with --expose-gc (the tests' hand-started cores): collect garbage often, so a lock that is only weakly
// held is lost at once instead of whenever V8 gets to it.
if (typeof globalThis.gc === "function") setInterval(() => globalThis.gc(), 50).unref();

if (kind === "no-listen") setInterval(() => {}, 1000);

const run = path.join(home, "run");
const address = process.platform === "win32"
  ? `\\\\.\\pipe\\plur1bus-${createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, 16)}-core`
  : path.join(run, "core.sock");
mkdirSync(run, { recursive: true });
if (process.platform !== "win32") rmSync(address, { force: true });
const token = randomBytes(32).toString("hex");

// One-shot (H3B-R7): only the core that creates the marker reports a pending restart, so its successor does not.
let restartPending = null;
// Test seams of the global constraints: honoured only with PLUR1BUS_ALLOW_TEST_INTERNALS=1 (the supervisor's own gate).
const internals = process.env.PLUR1BUS_ALLOW_TEST_INTERNALS === "1";
if (internals && process.env.FAKE_CORE_RESTART_PENDING === "1") {
  try { writeFileSync(path.join(stateDir, "fake-core-restart-pending"), `${process.pid}\n`, { flag: "wx" }); restartPending = true; }
  catch { restartPending = false; }
}

let statusCalls = 0;
let hung = false;
let stopping = false;
let state = "ready";
// S11 on Windows: run/ and the token and pid files get the owner-only DACL through the real core's own securePath
// (packages/core/src/platform.ts, imported rather than copied; Node 24 strips the types). The icacls calls take
// about a second on a CI runner, longer than the supervisor's scaled ready timeout, and a synchronous run would stall
// the health polls past the scaled hang threshold. So they run in a separate node process after listen, and the core
// reports `starting` until they are done, the way the real core reports `starting` until its journal replay is done.
// Elsewhere mkdirSync/writeFileSync modes already match core.ts.
let secured = process.platform !== "win32";
let onSecured = [];
/** Runs `f` once the run files are secured (at once where there is nothing to secure). */
function whenSecured(f) {
  if (secured) f();
  else onSecured.push(f);
}
function secureRunFiles() {
  if (secured) return;
  const script = [
    "const { createPlatformCapabilities } = await import(process.argv[1]);",
    "const p = createPlatformCapabilities({ logger: { warn: (m, f) => { process.stderr.write(`${m} ${JSON.stringify(f)}\\n`); process.exitCode = 1; } } });",
    "p.securePath(process.argv[2], { mode: 0o700 });",
    "for (const f of process.argv.slice(3)) p.securePath(f);",
  ].join("\n");
  const platformTs = new URL("../../../../packages/core/src/platform.ts", import.meta.url).href;
  const files = [run, path.join(run, "core.token"), path.join(run, "core.pid")];
  execFile(process.execPath, ["--input-type=module", "-e", script, platformTs, ...files], { windowsHide: true }, (err, _out, stderr) => {
    secured = true;
    event("secured", { ok: !err, ...(err ? { stderr: String(stderr) } : {}) });
    if (err) process.stderr.write(`fake-core: securing run/ failed: ${stderr}\n`);
    for (const f of onSecured.splice(0)) f();
  });
}
/** The state core.status reports: `starting` while the run files are being secured. */
function reportedState() {
  return state === "ready" && !secured ? "starting" : state;
}
let lifeline = null; // "stdin" or the adopting socket
let graceTimer = null;

function lost(source) {
  // A hung core's event loop answers nothing, so it cannot notice its lifeline either: it never exits by itself, only
  // the supervisor's kill ends it. (Reacting here let a late kill on a loaded Windows runner lose the race to the
  // orphan grace, and the core "exited by itself".)
  if (hung) return;
  if (stopping || lifeline !== source) return;
  lifeline = null;
  if (graceTimer) return;
  state = "orphaned";
  event("orphaned");
  graceTimer = setTimeout(() => { removeRunFiles(); exit(0); }, Number(process.env.FAKE_CORE_GRACE_MS ?? 1000));
}

function adopted(sock, nonce) {
  lifeline = sock;
  if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  state = "ready";
  event("adopted", { nonce });
}

function coreStatus() {
  return {
    process: { state: reportedState(), since: started }, contract: "1.9.0", rpc: "1.3.0", instanceId, pid: process.pid,
    uptimeMs: Date.now() - started, engine: process.env.FAKE_CORE_ENGINE ? JSON.parse(process.env.FAKE_CORE_ENGINE) : { ready: true, degraded: null }, agents: [],
    ...(process.env.FAKE_CORE_JOBS ? { jobs: JSON.parse(process.env.FAKE_CORE_JOBS) } : {}),
    ...(restartPending === null ? {} : { config: { revision: null, source: "file", restartPending } }),
  };
}

function removeRunFiles() {
  rmSync(path.join(run, "core.token"), { force: true });
  rmSync(path.join(run, "core.pid"), { force: true });
}

function shutdown(budgetMs) {
  if (stopping) return;
  stopping = true;
  event("shutdown", { budgetMs: budgetMs ?? null });
  server.close();
  removeRunFiles();
  setTimeout(() => exit(0), 20);
}

const server = net.createServer((sock) => {
  let buf = "";
  let authed = false;
  sock.on("error", () => {});
  sock.on("close", () => lost(sock));
  const send = (msg) => { if (!sock.destroyed) sock.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n"); };
  const handle = (msg) => {
    if (hung) return;
    const { id, method, params = {} } = msg;
    if (id === undefined) return;
    if (method === "core.auth") {
      const t = Buffer.from(String(params.token ?? ""));
      if (t.length !== 64 || !timingSafeEqual(t, Buffer.from(token))) {
        send({ id, error: { code: -32000, message: "bad token", data: { error: "E_UNAUTHORIZED", reason: "bad-token" } } });
        sock.end();
        return;
      }
      authed = true;
      send({ id, result: { contract: "1.9.0", rpc: "1.3.0", instanceId, pid: process.pid } });
      return;
    }
    if (!authed) {
      send({ id, error: { code: -32000, message: "authenticate first", data: { error: "E_UNAUTHORIZED", reason: "auth-required" } } });
      return;
    }
    if (method === "core.status") {
      statusCalls += 1;
      const reply = () => send({ id, result: coreStatus() });
      if (kind === "slow-status" && statusCalls === Number(a)) setTimeout(reply, Number(b));
      else reply();
      return;
    }
    if (method === "core.adopt") {
      if (stopping) {
        send({ id, error: { code: -32000, message: "core is stopping", data: { error: "E_NOT_AVAILABLE", reason: "stopping" } } });
        return;
      }
      let expected = null;
      try { expected = readFileSync(path.join(run, "supervisor.token"), "utf8").trim().toLowerCase(); } catch { /* refused below */ }
      const nonce = String(params.nonce ?? "").toLowerCase();
      if (expected === null || expected.length !== 64 || nonce !== expected) {
        send({ id, error: { code: -32000, message: "adoption refused", data: { error: "E_UNAUTHORIZED", reason: "adopt-nonce" } } });
        return;
      }
      adopted(sock, nonce);
      send({ id, result: { status: coreStatus() } });
      return;
    }
    if (method === "core.shutdown") {
      send({ id, result: { accepted: true } });
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

/** B7 as core.js does it under a supervisor: config.watch before the core serves. */
function watchConfig() {
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\plur1bus-${createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, 16)}-supervisor`
    : path.join(run, "supervisor.sock");
  return new Promise((resolve) => {
    let settled = false;
    const done = (name, extra = {}) => { if (settled) return; settled = true; clearTimeout(timer); event(name, extra); resolve(); };
    const timer = setTimeout(() => done("config-watch-failed", { reason: "timeout" }), 10_000);
    let token = "";
    try { token = readFileSync(path.join(run, "supervisor.token"), "utf8").trim(); } catch { done("config-watch-failed", { reason: "no-token" }); return; }
    const sock = net.createConnection(address);
    globalThis.fakeCoreWatch = sock; // kept open, like the core's subscription
    let buf = "";
    sock.on("error", () => done("config-watch-failed", { reason: "error" }));
    sock.on("connect", () => {
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "supervisor.auth", params: { token } }) + "\n");
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "config.watch", params: {} }) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2) done(msg.result ? "config-watched" : "config-watch-failed", msg.result ? { revision: msg.result.revision } : { error: msg.error });
      }
    });
  });
}

if (kind !== "no-listen" && internals && process.env.FAKE_CORE_WATCH_CONFIG === "1") await watchConfig();

if (kind !== "no-listen") {
  // Before listen, as core.ts does.
  writeFileSync(path.join(run, "core.token"), token, { mode: 0o600 });
  writeFileSync(path.join(run, "core.pid"), `${process.pid} ${instanceId}\n`, { mode: 0o600 });
  const listen = () => server.listen(address, () => {
    event("listening");
    secureRunFiles();
    // From the moment it reports ready: securing run/ takes a second or more on a Windows runner, and a core that
    // crashes before that is never ready (a test waiting for ready would see only crashes, then the give-up).
    if (kind === "crash-after") whenSecured(() => setTimeout(() => exit(1), Number(a)));
    // Also from ready: a core that hangs while it still reports `starting` is never ready, and the supervisor kills
    // it at the ready timeout and starts another, which is not the hung core a test then stops.
    if (kind === "hang-after") whenSecured(() => setTimeout(() => { hung = true; event("hung"); }, Number(a)));
  });
  if (kind === "listen-after") setTimeout(listen, Number(a));
  else listen();
}

if (values.lifeline === "stdin") {
  lifeline = "stdin";
  process.stdin.on("data", () => {});
  process.stdin.on("end", () => lost("stdin"));
  process.stdin.on("error", () => {});
}
