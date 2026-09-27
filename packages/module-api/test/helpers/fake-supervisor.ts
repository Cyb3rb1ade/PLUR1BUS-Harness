// A stand-in for the supervisor's config service in TypeScript tests (module-api's own and the core's): a small NDJSON
// server on the home's supervisor address that answers `supervisor.auth` (against the token it writes to
// run/supervisor.token), `config.watch` and `config.set`, and pushes `config.changed` on demand.
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { LineDecoder, encodeLine } from "../../src/framing.ts";
import { runDir, supervisorAddress, supervisorTokenPath } from "../../src/paths.ts";
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
  close(): Promise<void>;
}

export async function startFakeSupervisor(o: { home: string; config: Record<string, unknown>; revision?: string; token?: string }): Promise<FakeSupervisor> {
  const token = o.token ?? randomBytes(32).toString("hex");
  mkdirSync(runDir(o.home), { recursive: true });
  writeFileSync(supervisorTokenPath(o.home), token, { mode: 0o600 });
  const address = supervisorAddress(o.home);
  if (process.platform !== "win32") rmSync(address, { force: true });
  let config = o.config; let revision = o.revision ?? "r1"; let n = 1;
  const sets: FakeSupervisor["sets"] = []; const watches: string[] = [];
  const watchers = new Set<Socket>(); const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    const dec = new LineDecoder(); let authed = false;
    sock.on("error", () => {});
    sock.on("close", () => { watchers.delete(sock); sockets.delete(sock); });
    sock.on("data", (chunk) => {
      let msgs: any[];
      try { msgs = dec.push(chunk) as any[]; } catch { sock.destroy(); return; }
      for (const msg of msgs) {
        const reply = (result: unknown) => sock.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result }));
        const fail = (error: string, reason: string) => sock.write(encodeLine({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: error, data: { error, reason } } }));
        if (msg.method === "supervisor.auth") {
          authed = msg.params?.token === token;
          if (authed) reply({ rpc: "1.3.0", instanceId: "fake-supervisor", pid: process.pid }); else fail("E_UNAUTHORIZED", "bad-token");
          continue;
        }
        if (!authed) { fail("E_UNAUTHORIZED", "auth-required"); continue; }
        if (msg.method === "config.watch") { watchers.add(sock); watches.push(token); reply({ subscriptionId: `s${watches.length}`, config, revision }); continue; }
        if (msg.method === "config.set") {
          sets.push(msg.params);
          reply({ applied: true, dryRun: false, changed: msg.params.changes.map((c: { key: string }) => c.key), restart: { live: [], core: false, modules: [] }, revision, restarted: [], durationMs: 0 });
          continue;
        }
        fail("E_INTERNAL", "method-not-found");
      }
    });
  });
  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(address, () => { server.off("error", rej); res(); }); });
  const send = (params: ConfigChanged) => { for (const s of watchers) s.write(encodeLine({ jsonrpc: "2.0", method: "config.changed", params })); };
  return {
    home: o.home, token,
    get config() { return config; }, get revision() { return revision; },
    sets, watches,
    push(next, extra = {}) {
      const previousRevision = revision;
      n += 1; config = next; revision = `r${n}`;
      const params: ConfigChanged = {
        revision, previousRevision, changed: extra.changed ?? [], restart: extra.restart ?? { live: [], core: false, modules: [] },
        config: next, source: extra.source ?? "set",
      };
      send(params);
      return params;
    },
    pushRaw: send,
    close: () => new Promise<void>((res) => { for (const s of sockets) s.destroy(); server.close(() => res()); }),
  };
}
