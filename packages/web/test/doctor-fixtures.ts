// Fixtures for the Doctor page tests: the two REAL routes (GET /api/v1/health, GET /api/v1/agents) simulated through the
// mock server's extension hook, the assumed core.status RPC, and a 1staid.check/1 document. Not a test file itself.
import type { MockHarnessServer } from "./mock-server.ts";

export const HEALTH_OK = { schema: "health/1", status: "ok", api: { version: "1.4.0" }, core: { reachable: true, rpc: "1.3.0", contract: "2.0.0", uptimeMs: ((1 * 24 + 3) * 60 + 7) * 60_000, engineReady: true, degraded: false } };
export const HEALTH_DEGRADED = { ...HEALTH_OK, status: "degraded", core: { ...HEALTH_OK.core, degraded: true } };
export const HEALTH_DOWN = { schema: "health/1", status: "down", api: { version: "1.4.0" }, core: { reachable: false } };

export const AGENTS = {
  schema: "agents.list/1",
  agents: [
    { agentId: "main", open: true, activity: { state: "idle", since: Date.UTC(2026, 9, 6, 12, 0, 0) } },
    { agentId: "scribe", open: false, activity: { state: "dreaming", since: Date.UTC(2026, 9, 6, 13, 30, 0), phase: "rem" } },
  ],
};

export const CORE_OK = {
  process: { state: "ready" }, contract: "2.0.0", rpc: "1.3.0", instanceId: "inst-1", pid: 4242, uptimeMs: 1000, agents: [],
  engine: {
    ready: true, degraded: null,
    models: { embedder: { state: "ready", warming: false, checkedAt: 1, id: "e5" }, reranker: { state: "disabled", warming: false, checkedAt: null, id: null } },
    sharedMemory: { supported: true, mode: "verified-path" }, storeSchema: { current: "4", expected: "4" },
  },
};
export const CORE_DEGRADED = {
  ...CORE_OK, process: { state: "degraded", reason: "embedder-failed" },
  engine: { ...CORE_OK.engine, ready: true, degraded: { reason: "embedder-failed", capability: "semantic-recall", detail: "model file missing" } },
};

/** What `plur1bus 1staid check --json` prints (shape: crates/plur1bus/src/commands/firstaid.rs). `detail` carries a path on purpose. */
export const CHECK_DOC = {
  schema: "1staid.check/1", ok: false,
  checks: [
    { id: "config.valid", status: "ok", summary: "config.json is valid" },
    { id: "models.warm", status: "info", summary: "embedder is warming" },
    { id: "run.permissions", status: "fail", summary: "run/ is 777, expected 0700", detail: { path: "/Users/someone/.plur1bus/run" }, hint: "Run: plur1bus 1staid repair --yes" },
    { id: "journal.backlog", status: "warn", summary: "128 entries waiting", hint: "Wait or run: plur1bus dreams status" },
    { id: "windows.pipe-acl", status: "skip", summary: "not on Windows" },
  ],
};
/** Deliberately odd whitespace: the export must return exactly this text. */
export const CHECK_RAW = `\n  ${JSON.stringify(CHECK_DOC, null, 3)}\n\n`;

export type RouteAnswer = { status: number; body: unknown };

/** Simulates the two real REST routes; tests set `health` / `agents` and read the hit counters. */
export class DoctorMock {
  health: RouteAnswer = { status: 200, body: HEALTH_OK };
  agents: RouteAnswer = { status: 200, body: AGENTS };
  readonly hits = { health: 0, agents: 0, core: 0 };
  readonly #server: MockHarnessServer;

  constructor(server: MockHarnessServer, opts: { core?: unknown | "off" } = {}) {
    this.#server = server;
    server.extensions.push((req, res, path) => {
      const which = path === "/api/v1/health" ? "health" : path === "/api/v1/agents" ? "agents" : null;
      if (which === null) return false;
      const send = (status: number, body: unknown): true => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(body));
        return true;
      };
      if (!server.sessionOf(req)) return send(401, { schema: "error/1", error: "E_UNAUTHORIZED", message: "no-session", reason: "no-session" });
      this.hits[which] += 1;
      const a = this[which];
      return send(a.status, a.body);
    });
    const core = opts.core === undefined ? CORE_OK : opts.core;
    if (core !== "off") server.rpc.handle("core.status", () => { this.hits.core += 1; return core; }, { write: false });
  }

  get server(): MockHarnessServer { return this.#server; }
}

export async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
