// The representative flows recorded for the self-test. A flow is driven through the same raw client the replayer uses;
// the recorder inside the core's RPC server writes the transcript (tests/core-parity/record.ts). Transcripts are
// recorded, never edited by hand.
import { rawConnect, type RawConnection } from "./raw-client.ts";
import type { ParityTarget } from "./target.ts";

export interface FlowConn {
  /** Sends one request and resolves with the whole response frame (result or error). */
  call(method: string, params?: unknown): Promise<any>;
  /** Sends `core.auth` with the target's credential and resolves with the response frame. */
  auth(): Promise<any>;
  /** Waits until a notification named `method` has arrived. */
  notification(method: string): Promise<any>;
}
export interface FlowEnv { connect(): Promise<FlowConn> }
export interface Flow { name: string; description: string; run(env: FlowEnv): Promise<void> }

export async function runFlow(flow: Flow, target: ParityTarget): Promise<void> {
  const open: RawConnection[] = [];
  const env: FlowEnv = {
    async connect() {
      const raw = await rawConnect(target.address);
      open.push(raw);
      let id = 0;
      const call = async (method: string, params: unknown = {}) => {
        const mine = ++id;
        raw.send({ jsonrpc: "2.0", id: mine, method, params });
        return raw.waitFor((f) => f.id === mine && f.method === undefined, `${flow.name}: the response to ${method}`, 10_000);
      };
      return {
        call,
        auth: () => call("core.auth", { token: target.token }),
        notification: (method) => raw.waitFor((f) => f.method === method, `${flow.name}: the ${method} notification`, 10_000),
      };
    },
  };
  try { await flow.run(env); } finally { await Promise.all(open.map((c) => c.close().catch(() => {}))); }
}

const expectOk = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${JSON.stringify(r.error)}`); return r.result; };
const expectError = (r: any, reason: string, what: string) => { if (r.error?.data?.reason !== reason && r.error?.data?.error !== reason) throw new Error(`${what}: expected ${reason}, got ${JSON.stringify(r)}`); };

export const FLOWS: readonly Flow[] = [
  {
    name: "core-status",
    description: "handshake and core.status of an idle core",
    async run(env) {
      const c = await env.connect();
      expectOk(await c.auth(), "core.auth");
      expectOk(await c.call("core.status"), "core.status");
    },
  },
  {
    name: "auth-handshake",
    description: "a request before the handshake is refused; two connections authenticate; re-authentication on a live connection",
    async run(env) {
      const first = await env.connect();
      expectError(await first.call("core.status"), "auth-required", "core.status before core.auth");
      expectOk(await first.auth(), "core.auth");
      expectOk(await first.call("core.status"), "core.status after core.auth");
      const second = await env.connect();
      expectOk(await second.auth(), "core.auth on the second connection");
      expectOk(await first.auth(), "core.auth again on the first connection");
    },
  },
  {
    name: "settings-roundtrip",
    description: "a persistent setting written and read back (media.preferences; config.get/set belong to the supervisor, not the core)",
    async run(env) {
      const c = await env.connect();
      expectOk(await c.auth(), "core.auth");
      expectOk(await c.call("media.preferences.get"), "media.preferences.get");
      expectOk(await c.call("media.preferences.set", { embedMetadata: true }), "media.preferences.set (global)");
      expectOk(await c.call("media.preferences.get"), "media.preferences.get after set");
      expectOk(await c.call("media.preferences.set", { agentId: "bernd", embedMetadata: false }), "media.preferences.set (agent)");
      expectOk(await c.call("media.preferences.get"), "media.preferences.get after the agent override");
    },
  },
  {
    name: "events-subscribe",
    description: "one subscription, one event: a second connection asks the core to shut down and the subscriber sees core.state",
    async run(env) {
      const watcher = await env.connect();
      expectOk(await watcher.auth(), "watcher core.auth");
      expectOk(await watcher.call("events.subscribe", { names: ["core.state"] }), "events.subscribe");
      const actor = await env.connect();
      expectOk(await actor.auth(), "actor core.auth");
      expectOk(await actor.call("core.shutdown", {}), "core.shutdown");
      await watcher.notification("core.state");
    },
  },
  {
    name: "error-paths",
    description: "an unknown agent, an unknown method and invalid params, each answered with its own error",
    async run(env) {
      const c = await env.connect();
      expectOk(await c.auth(), "core.auth");
      expectError(await c.call("agent.open", { agentId: "nobody" }), "E_AGENT_UNKNOWN", "agent.open on an unknown agent");
      expectError(await c.call("nope.nope"), "method-not-found", "an unknown method");
      expectError(await c.call("core.status", { unexpected: 1 }), "E_INVALID_PARAMS", "core.status with an extra param");
    },
  },
];
