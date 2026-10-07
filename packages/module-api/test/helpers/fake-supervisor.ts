// A stand-in for the supervisor's config service in TypeScript tests (module-api's own and the core's): a small NDJSON
// server on the home's supervisor address that answers `supervisor.auth` (against the token it writes to
// run/supervisor.token), `config.watch` and `config.set`, and pushes `config.changed` on demand.
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { LineDecoder, encodeLine } from "../../src/framing.ts";
import { runDir, supervisorAddress, supervisorPidPath, supervisorTokenPath } from "../../src/paths.ts";
import type { ConfigChanged } from "../../src/config-watch.ts";

export interface FakeSupervisor {
  readonly home: string;
  readonly token: string;
  readonly config: Record<string, unknown>;
  readonly revision: string;
  /** Every `config.set` params received, in order. */
  readonly sets: { changes: { key: string; value: unknown }[] }[];
  /** The token each successful `config.watch` connection authenticated with, in order. */
  readonly watches: string[];
  /** Makes `config` the running configuration and sends `config.changed` to every watcher. */
  push(config: Record<string, unknown>, o?: Partial<Omit<ConfigChanged, "config" | "revision" | "previousRevision">>): ConfigChanged;
  /** Sends raw `config.changed` params without changing what `config.watch` answers (e.g. an invalid config). */
  pushRaw(params: ConfigChanged): void;
  /** Stops accepting connections; the connections already open stay (a supervisor process that is going away while
   *  its peers have not noticed yet). */
  stopListening(): Promise<void>;
  /**
   * Supervisor B takes the home over from this one (A) while A's open connections stay: from now on every new
   * connection to the address is B's (B's token is written to run/supervisor.token), A's are still A's. B answers on
   * A's listener rather than a new one because on Windows a named pipe cannot be re-listened while any instance of it
   * is still connected (libuv binds with FILE_FLAG_FIRST_PIPE_INSTANCE → EADDRINUSE), so "A's connection stays open
   * while B listens" is only reachable there through one listener. A's `close()` then closes only A's connections;
   * B's closes the listener.
   */
  handOver(o: { config: Record<string, unknown>; revision?: string; token?: string; onWatch?: () => void }): FakeSupervisor;
  close(): Promise<void>;
}

/** Windows only: a pipe name stays taken until every instance of it is closed, which can trail `server.close()`'s
 *  callback by a moment; a re-listen on the same home retries EADDRINUSE briefly instead of failing. */
async function listenWithRetry(server: Server, address: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(address, () => { server.off("error", rej); res(); }); });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || process.platform !== "win32" || Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

/** `onWatch` runs right after a `config.watch` reply is written, synchronously: a `push()` in it lands on the socket
 *  directly behind the reply (the I1 race). */
interface Persona {
  token: string; config: Record<string, unknown>; revision: string; n: number; onWatch?: () => void;
  sets: FakeSupervisor["sets"]; watches: string[]; watchers: Set<Socket>; sockets: Set<Socket>;
}

function persona(home: string, o: { config: Record<string, unknown>; revision?: string; token?: string; onWatch?: () => void }): Persona {
  const token = o.token ?? randomBytes(32).toString("hex");
  mkdirSync(runDir(home), { recursive: true });
  writeFileSync(supervisorTokenPath(home), token, { mode: 0o600 });
  // On Windows the client refuses a pipe whose expected server pid is unknown; the fake is served by this process.
  writeFileSync(supervisorPidPath(home), `${process.pid} fake-supervisor`, { mode: 0o600 });
  return { token, config: o.config, revision: o.revision ?? "r1", n: 1, ...(o.onWatch ? { onWatch: o.onWatch } : {}), sets: [], watches: [], watchers: new Set(), sockets: new Set() };
}

/** `onWatch` runs right after a `config.watch` reply is written, synchronously: a `push()` in it lands on the socket
 *  directly behind the reply (the I1 race). */
export async function startFakeSupervisor(o: { home: string; config: Record<string, unknown>; revision?: string; token?: string; onWatch?: () => void }): Promise<FakeSupervisor> {
  const address = supervisorAddress(o.home);
  if (process.platform !== "win32") rmSync(address, { force: true });
  // The persona new connections are served as; `handOver` replaces it, connections keep the one they were accepted by.
  let current = persona(o.home, o);
  const server: Server = createServer((sock) => {
    const p = current;
    p.sockets.add(sock);
    const dec = new LineDecoder(); let authed = false;
    sock.on("error", () => {});
    sock.on("close", () => { p.watchers.delete(sock); p.sockets.delete(sock); });
    sock.on("data", (chunk) => {
      let msgs: any[];
      try { msgs = dec.push(chunk) as any[]; } catch { sock.destroy(); return; }
      for (const msg of msgs) {
        const reply = (result: unknown) => sock.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result }));
        const fail = (error: string, reason: string) => sock.write(encodeLine({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: error, data: { error, reason } } }));
        if (msg.method === "supervisor.auth") {
          authed = msg.params?.token === p.token;
          if (authed) reply({ rpc: "1.4.0", instanceId: "fake-supervisor", pid: process.pid }); else fail("E_UNAUTHORIZED", "bad-token");
          continue;
        }
        if (!authed) { fail("E_UNAUTHORIZED", "auth-required"); continue; }
        if (msg.method === "config.watch") {
          p.watchers.add(sock); p.watches.push(p.token);
          // Corked: the reply and whatever onWatch pushes go out in one write, so the peer reads them in one chunk.
          sock.cork(); reply({ subscriptionId: `s${p.watches.length}`, config: p.config, revision: p.revision }); p.onWatch?.(); process.nextTick(() => sock.uncork());
          continue;
        }
        if (msg.method === "config.set") {
          p.sets.push(msg.params);
          reply({ applied: true, dryRun: false, changed: msg.params.changes.map((c: { key: string }) => c.key), restart: { live: [], core: false, modules: [] }, revision: p.revision, restarted: [], durationMs: 0 });
          continue;
        }
        fail("E_INTERNAL", "method-not-found");
      }
    });
  });
  await listenWithRetry(server, address);
  const view = (p: Persona): FakeSupervisor => {
    const send = (params: ConfigChanged) => { for (const s of p.watchers) s.write(encodeLine({ jsonrpc: "2.0", method: "config.changed", params })); };
    const owns = () => current === p;
    return {
      home: o.home, token: p.token,
      get config() { return p.config; }, get revision() { return p.revision; },
      sets: p.sets, watches: p.watches,
      push(next, extra = {}) {
        const previousRevision = p.revision;
        p.n += 1; p.config = next; p.revision = `r${p.n}`;
        const params: ConfigChanged = {
          revision: p.revision, previousRevision, changed: extra.changed ?? [], restart: extra.restart ?? { live: [], core: false, modules: [] },
          config: next, source: extra.source ?? "set",
        };
        send(params);
        return params;
      },
      pushRaw: send,
      // server.close()'s callback waits for every open connection; stopping to listen does not. A handed-over persona
      // no longer listens.
      stopListening: async () => { if (owns() && server.listening) server.close(); },
      handOver(next) {
        if (!owns()) throw new Error("this fake supervisor already handed the home over");
        current = persona(o.home, next);
        return view(current);
      },
      close: () => new Promise<void>((res) => {
        for (const s of p.sockets) s.destroy();
        if (!owns() || !server.listening) return res();
        server.close(() => res());
      }),
    };
  };
  return view(current);
}
