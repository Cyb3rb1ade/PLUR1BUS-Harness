// A stand-in for dist/core.js in the supervisor's Rust tests (no dependencies; on Windows it borrows the real core's
// packages/core/src/platform.ts to secure run/). It takes the same flags as core.js,
// takes state/core.lock the way core.ts does (SQLite EXCLUSIVE, released by the OS when the process dies; held → exit
// 3), writes run/core.token and run/core.pid and then listens on the same address like the real core, and answers
// core.auth, core.status, core.shutdown and core.adopt. FAKE_CORE_MODE picks its behaviour:
//   ok                    serve until core.shutdown or lifeline loss
//   crash-after:<ms>      serve, then exit 1 after <ms>
//   exit:<code>           exit with <code> at once, before the lock
//   listen-after:<ms>     hold the lock and write the run files, but listen only after <ms> (a core still starting)
//   hang-after:<ms>       serve, then stop answering every request after <ms> (no SIGTERM handler; event `hung`)
//   no-listen             start (run files not written) but never listen
//   slow-status:<n>:<ms>  delay the reply to the n-th core.status (counted across connections) by <ms>
// FAKE_CORE_ENGINE (JSON) replaces core.status's `engine` object (default: ready, not degraded).
// FAKE_CORE_JOBS (JSON) is core.status's `jobs` object (default: absent, as from a core without job health).
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
const mode = process.env.FAKE_CORE_MODE ?? "ok";
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
  });
}
/** The state core.status reports: `starting` while the run files are being secured. */
function reportedState() {
  return state === "ready" && !secured ? "starting" : state;
}
let lifeline = null; // "stdin" or the adopting socket
let graceTimer = null;

function lost(source) {
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
    process: { state: reportedState(), since: started }, contract: "1.8.0", rpc: "1.2.0", instanceId, pid: process.pid,
    uptimeMs: Date.now() - started, engine: process.env.FAKE_CORE_ENGINE ? JSON.parse(process.env.FAKE_CORE_ENGINE) : { ready: true, degraded: null }, agents: [],
    ...(process.env.FAKE_CORE_JOBS ? { jobs: JSON.parse(process.env.FAKE_CORE_JOBS) } : {}),
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
      send({ id, result: { contract: "1.8.0", rpc: "1.2.0", instanceId, pid: process.pid } });
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

if (kind !== "no-listen") {
  // Before listen, as core.ts does.
  writeFileSync(path.join(run, "core.token"), token, { mode: 0o600 });
  writeFileSync(path.join(run, "core.pid"), `${process.pid} ${instanceId}\n`, { mode: 0o600 });
  const listen = () => server.listen(address, () => {
    event("listening");
    secureRunFiles();
    if (kind === "crash-after") setTimeout(() => exit(1), Number(a));
    if (kind === "hang-after") setTimeout(() => { hung = true; event("hung"); }, Number(a));
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
