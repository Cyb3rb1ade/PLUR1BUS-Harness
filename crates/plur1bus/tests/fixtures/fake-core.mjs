// A stand-in for dist/core.js in the supervisor's Rust tests (no dependencies). It takes the same flags as core.js,
// listens on the same address, writes run/core.token and run/core.pid like the real core, and answers core.auth,
// core.status and core.shutdown. FAKE_CORE_MODE picks its behaviour:
//   ok                    serve until core.shutdown or lifeline loss
//   crash-after:<ms>      serve, then exit 1 after <ms>
//   exit:<code>           exit with <code> at once, before listening
//   hang-after:<ms>       serve, then stop answering every request after <ms> (no SIGTERM handler)
//   slow-status:<n>:<ms>  delay the reply to the n-th core.status (counted across connections) by <ms>
// Every event (started, shutdown, orphaned, exiting) is appended as one JSON line to $FAKE_CORE_EVENTS.
// On lifeline EOF it reports `orphaned` and exits 0 after FAKE_CORE_GRACE_MS (default 1000).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
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

function coreStatus() {
  return {
    process: { state, since: started }, contract: "1.7.0", rpc: "1.2.0", instanceId, pid: process.pid,
    uptimeMs: Date.now() - started, engine: { ready: true, degraded: null }, agents: [],
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
      send({ id, result: { contract: "1.7.0", rpc: "1.2.0", instanceId, pid: process.pid } });
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

server.listen(address, () => {
  writeFileSync(path.join(run, "core.token"), token, { mode: 0o600 });
  writeFileSync(path.join(run, "core.pid"), `${process.pid} ${instanceId}\n`, { mode: 0o600 });
  if (kind === "crash-after") setTimeout(() => exit(1), Number(a));
  if (kind === "hang-after") setTimeout(() => { hung = true; }, Number(a));
});

if (values.lifeline === "stdin") {
  process.stdin.on("data", () => {});
  process.stdin.on("end", () => {
    if (stopping) return;
    state = "orphaned";
    event("orphaned");
    setTimeout(() => { removeRunFiles(); exit(0); }, Number(process.env.FAKE_CORE_GRACE_MS ?? 1000));
  });
  process.stdin.on("error", () => {});
}
