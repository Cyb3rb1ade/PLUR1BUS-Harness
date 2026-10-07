import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderError } from "../../src/errors.ts";
import { guardLocalAdapter, LocalEndpointMonitor } from "../../src/local/index.ts";
import { ProviderRouter } from "../../src/router/index.ts";
import type { StreamingAdapter } from "../../src/router/types.ts";
import type { ChatRequest, ChatStreamEvent } from "../../src/types.ts";
import { FakeClock, REQ, cand, drain } from "../router/helpers.ts";

const T = { timeout: 15_000 };
const CAND = [{ origin: "http://127.0.0.1:9", dialects: ["openai" as const], label: "lm" }];

/** A fake fetch whose server can be switched between up and down, or gated. */
function fakeServer() {
  const st = { up: true, calls: 0, gate: undefined as Promise<void> | undefined, headers: [] as Headers[] };
  const fetch: typeof globalThis.fetch = async (_u, init) => {
    st.calls++;
    st.headers.push(new Headers(init?.headers));
    if (st.gate) await st.gate;
    if (!st.up) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
  };
  return { st, fetch };
}

function setup(ttlMs = 1000) {
  const srv = fakeServer();
  const clock = { t: 10_000 };
  const monitor = new LocalEndpointMonitor({ candidates: CAND, fetch: srv.fetch, ttlMs, now: () => clock.t });
  return { ...srv, clock, monitor };
}

class Inner implements StreamingAdapter {
  calls = 0;
  readonly err: Error | undefined;
  constructor(err?: Error) { this.err = err; }
  async *stream(_r: ChatRequest): AsyncGenerator<ChatStreamEvent, void, void> {
    this.calls++;
    if (this.err) throw this.err;
    yield { type: "text_delta", text: "ok" };
  }
}

describe("LocalEndpointMonitor", () => {
  it("snapshot is synchronous, unknown, and touches no network before refresh", T, () => {
    const { monitor, st } = setup();
    const snap = monitor.snapshot();
    assert.ok(!(snap instanceof Promise));
    assert.deepEqual(snap, [{ label: "lm", origin: "http://127.0.0.1:9", status: "unknown" }]);
    assert.equal(monitor.status("lm")?.status, "unknown");
    assert.equal(monitor.status("nope"), undefined);
    assert.equal(st.calls, 0);
  });

  it("refresh fills statuses; the probe carries no auth header", T, async () => {
    const { monitor, st, clock } = setup();
    const out = await monitor.refresh();
    assert.equal(out[0]?.status, "available");
    assert.deepEqual(out[0]?.availability, { status: "available", models: ["m1"] });
    assert.equal(out[0]?.checkedAt, clock.t);
    assert.equal(out[0]?.baseUrl, "http://127.0.0.1:9/v1");
    assert.equal(st.headers[0]?.get("authorization"), null);
    assert.equal(monitor.snapshot()[0]?.status, "available");
  });

  it("a dead service becomes a status, never a rejection", T, async () => {
    const { monitor, st } = setup();
    st.up = false;
    const out = await monitor.refresh();
    assert.equal(out[0]?.status, "unavailable");
    assert.equal(out[0]?.availability?.reason, "unreachable");
  });

  it("concurrent refreshes share one discovery", T, async () => {
    const { monitor, st } = setup();
    let open!: () => void;
    st.gate = new Promise<void>((ok) => { open = ok; });
    const ps = [monitor.refresh(), monitor.refresh(), monitor.refresh()];
    monitor.refreshInBackground();
    open();
    await Promise.all(ps);
    assert.equal(st.calls, 1);
    await monitor.refresh(); // a later one is a new discovery
    assert.equal(st.calls, 2);
  });

  it("a caller abort rejects with the reason; the shared discovery still completes for others", T, async () => {
    const { monitor, st } = setup();
    let open!: () => void;
    st.gate = new Promise<void>((ok) => { open = ok; });
    const ac = new AbortController();
    const aborted = monitor.refresh({ signal: ac.signal });
    const other = monitor.refresh();
    ac.abort(new Error("stop"));
    await assert.rejects(aborted, /stop/);
    open();
    assert.equal((await other)[0]?.status, "available");
    await assert.rejects(monitor.refresh({ signal: AbortSignal.abort(new Error("pre")) }), /pre/);
  });

  it("refreshInBackground swallows errors", T, async () => {
    const { monitor, st } = setup();
    st.up = false;
    monitor.refreshInBackground();
    await new Promise((ok) => setTimeout(ok, 30));
    assert.equal(monitor.status("lm")?.status, "unavailable");
  });

  it("freshness follows the injected clock and ttl", T, async () => {
    const { monitor, clock } = setup(1000);
    assert.equal(monitor.isFresh("lm"), false);
    await monitor.refresh();
    assert.equal(monitor.isFresh("lm"), true);
    clock.t += 999;
    assert.equal(monitor.isFresh("lm"), true);
    clock.t += 1;
    assert.equal(monitor.isFresh("lm"), false);
  });

  it("reportFailure marks it unavailable right now", T, async () => {
    const { monitor, clock, st } = setup();
    await monitor.refresh();
    clock.t += 5;
    monitor.reportFailure("lm");
    monitor.reportFailure("unknown-label");
    const s = monitor.status("lm");
    assert.equal(s?.status, "unavailable");
    assert.equal(s?.checkedAt, clock.t);
    assert.equal(monitor.isFresh("lm"), true);
    assert.equal(st.calls, 1);
  });
});

describe("guardLocalAdapter", () => {
  const unavailableErr = (e: unknown) => e instanceof ProviderError && e.kind === "network" && e.retryable === false && e.code === "unavailable" && /local provider "lm" is unavailable \(unreachable\)/.test(e.message);

  it("fresh unavailable: fails fast with zero requests", T, async () => {
    const { monitor, st } = setup();
    st.up = false;
    await monitor.refresh();
    const before = st.calls;
    const inner = new Inner();
    await assert.rejects(drain(guardLocalAdapter(monitor, "lm", inner).stream(REQ)), unavailableErr);
    assert.equal(st.calls, before);
    assert.equal(inner.calls, 0);
  });

  it("unknown status: refreshes once, then decides", T, async () => {
    const { monitor, st } = setup();
    st.up = false;
    const inner = new Inner();
    await assert.rejects(drain(guardLocalAdapter(monitor, "lm", inner).stream(REQ)), unavailableErr);
    assert.equal(st.calls, 1);
    assert.equal(inner.calls, 0);
  });

  it("stale unavailable: refresh-then-delegate once the service is back", T, async () => {
    const { monitor, st, clock } = setup(1000);
    st.up = false;
    await monitor.refresh();
    st.up = true;
    clock.t += 1000;
    const inner = new Inner();
    const out = await drain(guardLocalAdapter(monitor, "lm", inner).stream(REQ));
    assert.equal(out[0]?.type, "text_delta");
    assert.equal(st.calls, 2);
    assert.equal(inner.calls, 1);
    assert.equal(monitor.status("lm")?.status, "available");
  });

  it("available and fresh: delegates without probing", T, async () => {
    const { monitor, st } = setup();
    await monitor.refresh();
    const inner = new Inner();
    await drain(guardLocalAdapter(monitor, "lm", inner).stream(REQ));
    assert.equal(st.calls, 1);
    assert.equal(inner.calls, 1);
  });

  it("a network error from the delegate marks the endpoint unavailable and is rethrown; other errors do not", T, async () => {
    const { monitor } = setup();
    await monitor.refresh();
    const other = new ProviderError("invalid_request", "bad");
    await assert.rejects(drain(guardLocalAdapter(monitor, "lm", new Inner(other)).stream(REQ)), (e) => e === other);
    assert.equal(monitor.status("lm")?.status, "available");
    const net = new ProviderError("network", "reset");
    await assert.rejects(drain(guardLocalAdapter(monitor, "lm", new Inner(net)).stream(REQ)), (e) => e === net);
    assert.equal(monitor.status("lm")?.status, "unavailable");
  });

  it("a caller abort during the refresh rejects with its reason", T, async () => {
    const { monitor, st } = setup();
    st.gate = new Promise<void>(() => {});
    const ac = new AbortController();
    const p = drain(guardLocalAdapter(monitor, "lm", new Inner()).stream(REQ, { signal: ac.signal }));
    setTimeout(() => ac.abort(new Error("stop")), 20);
    await assert.rejects(p, /stop/);
  });

  it("an unknown label is a TypeError at construction", () => {
    assert.throws(() => guardLocalAdapter(setup().monitor, "nope", new Inner()), TypeError);
  });
});

describe("router integration", () => {
  it("falls back from a dead guarded local candidate without retrying it", T, async () => {
    const { monitor, st } = setup();
    st.up = false;
    const local = new Inner();
    const cloud = cand("cloud", "c", [{ text: "from cloud" }]);
    const clock = new FakeClock();
    const events: string[] = [];
    const router = new ProviderRouter({
      profiles: { p: [{ provider: "local", model: "m", adapter: guardLocalAdapter(monitor, "lm", local) }, cloud] },
      clock, random: () => 0.5, onEvent: (e) => events.push(e.type),
    });
    for (let i = 0; i < 2; i++) {
      const out = await drain(router.stream("p", REQ));
      assert.deepEqual(out[0], { type: "served", provider: "cloud", model: "c" });
    }
    assert.equal(local.calls, 0);
    assert.deepEqual(clock.sleeps, []); // no backoff, no retry of the dead endpoint
    assert.equal(events.filter((e) => e === "provider.retry").length, 0);
    assert.equal(events.filter((e) => e === "provider.fallback").length, 2);
    assert.equal(st.calls, 1); // the second call was served from the fresh cached status
    assert.equal(cloud.adapter.calls, 2);
  });
});
