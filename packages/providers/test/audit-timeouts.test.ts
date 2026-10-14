// Audit c16: `setTimeout` treats a delay that is NaN, below 1 or above 2^31-1 (Infinity included) as 1 ms, so a bound
// written as `Infinity` ("no limit") or a typo'd one made every call time out at once. Bounds are validated up front.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatCompletionsAdapter, ProviderError } from "../src/index.ts";
import type { ChatRequest, Timeouts } from "../src/index.ts";

const T = { timeout: 15_000 };
const REQ: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };
const BODY = JSON.stringify({ id: "c", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });

function adapter(timeouts: Partial<Timeouts>, calls: { n: number }) {
  const fetch = (async (_u: unknown, init: RequestInit) => {
    calls.n += 1;
    await new Promise((r) => setTimeout(r, 40)); // longer than the 1 ms a broken timer would allow
    if (init.signal?.aborted) throw init.signal.reason;
    return new Response(BODY, { headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return createChatCompletionsAdapter({ baseUrl: "https://example.test/v1", credentials: { authorization: () => undefined }, fetch, timeouts });
}

for (const phase of ["headersMs", "idleMs", "totalMs"] as const) {
  test(`${phase}: Infinity and a delay beyond the timer range mean "no bound", not "1 ms"`, T, async () => {
    for (const v of [Infinity, 3_000_000_000]) {
      const calls = { n: 0 };
      const r = await adapter({ [phase]: v }, calls).complete(REQ);
      assert.equal(r.text, "ok", `${phase}=${v}`);
    }
  });

  test(`${phase}: NaN, zero and negative bounds are refused before any I/O`, T, async () => {
    for (const v of [Number.NaN, 0, -5]) {
      const calls = { n: 0 };
      await assert.rejects(adapter({ [phase]: v }, calls).complete(REQ),
        (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request" && /timeout/i.test(e.message), `${phase}=${v}`);
      assert.equal(calls.n, 0, "no request left the process");
    }
  });
}

test("a per-call bound is validated like the adapter's", T, async () => {
  const calls = { n: 0 };
  const a = adapter({}, calls);
  await assert.rejects(a.complete(REQ, { timeouts: { totalMs: Number.NaN } }), (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request");
  assert.equal((await a.complete(REQ, { timeouts: { totalMs: Infinity } })).text, "ok");
  const it = a.stream(REQ, { timeouts: { idleMs: -1 } });
  await assert.rejects(it.next(), (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request");
});

test("an explicitly undefined bound or limit means 'not set', never 'zero' or 'unlimited'", T, async () => {
  const calls = { n: 0 };
  // `{ totalMs: cfg.totalMs }` with nothing configured must keep the default, not become a 1 ms timer
  const r = await adapter({ headersMs: undefined, idleMs: undefined, totalMs: undefined } as unknown as Partial<Timeouts>, calls).complete(REQ);
  assert.equal(r.text, "ok");
  // `{ maxEventBytes: undefined }` must keep the 4 MiB default, not switch the check off (`n > undefined` is false)
  const huge = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "x".repeat(5 * 1024 * 1024) } }] })}\n\n`;
  const fetch = (async () => new Response(huge, { headers: { "content-type": "text/event-stream" } })) as typeof globalThis.fetch;
  const a = createChatCompletionsAdapter({
    baseUrl: "https://example.test/v1", credentials: { authorization: () => undefined }, fetch,
    limits: { maxEventBytes: undefined } as unknown as { maxEventBytes: number },
  });
  await assert.rejects(async () => { for await (const _ of a.stream(REQ)) { /* drain */ } },
    (e: unknown) => e instanceof ProviderError && e.code === "protocol" && /exceeds/.test(e.message));
});
