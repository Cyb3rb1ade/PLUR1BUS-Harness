// End-to-end rig for one real channel adapter behind the switchboard: the real binding (so the real adapter), the real identity
// service, session store and turn runner, a scripted provider, the channel's own in-process fake server on the other side, and the
// real `channel.*` RPC surface on top. Nothing touches the network.
import { assert } from "./e2e-assert.ts";
import { buildChannelSurface } from "../../src/rpc/channel-surface.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import type { CallContext } from "../../src/rpc/server.ts";
import { DEFAULT_BINDINGS } from "../../src/channels/bindings.ts";
import { makeRig, flush, type Rig } from "./switchboard-rig.ts";

export { flush };

export interface E2eOptions {
  /** `discord`, `slack`, `matrix`, `signal` or `email`. */
  id: string;
  /** Test seams for the adapter (`fetch`, `webSocket`, `baseUrl`, `sleep`, `connect`, …): they point it at the fake server. */
  adapterDeps: Record<string, unknown>;
  /** Secret name → value, stored before the channel starts. */
  secrets?: Record<string, string>;
  /** `channels.<id>` keys on top of `enabled: true`. */
  config?: Record<string, unknown>;
}

export interface E2e extends Rig {
  id: string;
  /** Calls a `channel.*` method as the given person (default: the human linked by `link`). */
  call(method: string, params?: unknown, person?: string): Promise<any>;
  /** Waits (event-driven, bounded by turns of the event loop, never by the wall clock) until `cond` holds. */
  until(cond: () => boolean | Promise<boolean>, what: string): Promise<void>;
}

export async function startE2e(o: E2eOptions): Promise<E2e> {
  const binding = DEFAULT_BINDINGS.find((b) => b.id === o.id);
  if (!binding) throw new Error(`no binding for ${o.id}`);
  const rig = makeRig({ ids: [o.id], switchboard: { bindings: [binding], adapterDeps: { [o.id]: o.adapterDeps } } });
  for (const [name, value] of Object.entries(o.secrets ?? {})) rig.secrets.put(name, value);
  rig.config.set(o.id, { enabled: true, ...(o.config ?? {}) });

  const call = async (method: string, params: unknown = {}, person = "local-owner"): Promise<any> => {
    const raw = buildChannelSurface({
      config: rig.config.current,
      source: { current: rig.config.current, set: () => null },
      secrets: { list: async () => [...rig.secrets.values.keys()].map((name) => ({ name })) },
      identity: () => rig.identity,
      registry: () => rig.switchboard.view,
      clock: () => rig.clock.now(),
    });
    const methods = guardMethods(raw, { resolve: () => ({ userId: person, role: "owner", kind: "person" }) as never, now: () => 1 });
    const ctx: CallContext = { requestId: "r", connectionId: "c", signal: new AbortController().signal };
    return methods[method]!(params, ctx);
  };
  const until = async (cond: () => boolean | Promise<boolean>, what: string): Promise<void> => {
    // setImmediate turns never block in the poll phase, so on a busy host real socket I/O (the adapters talk to in-process fake
    // servers over loopback) can need more turns than any fixed count. After the cheap spins, yield to the poll phase via a
    // 1 ms timer turn (the rig's clock is virtual, so this never touches adapter timers). The cond is the only thing awaited.
    for (let i = 0; i < 2000; i++) {
      if (await cond()) return;
      await new Promise<void>((r) => setImmediate(r));
    }
    for (let i = 0; i < 20_000; i++) {
      if (await cond()) return;
      await new Promise<void>((r) => setTimeout(r, 1));
    }
    assert.fail(`timed out waiting for: ${what}`);
  };
  const e2e = Object.assign(rig, { id: o.id, call, until }) as E2e;
  await rig.switchboard.start();
  await rig.clock.advance(0); // the registry's start timer (startDelayMs 0) is on the fake clock
  return e2e;
}
