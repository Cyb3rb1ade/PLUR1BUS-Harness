// #836 scale: keep synchronous work bounded with 512 secrets, including nested JSON escape spellings.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createSecretRedaction } from "../../src/secrets/redaction.ts";
import { dispatcherProbe } from "./fixtures/dispatcher.ts";

const MARK = "[REDACTED:secret]";
// A regression ceiling for shared runners, not a production latency SLO. Each case measures one complete dispatch.
const MAX_DELAY_MS = 2000;

for (const shape of ["one-mib-no-hit", "nested-escaped-no-hit", "escaped-hit", "many-short-values", "overlapping-values"] as const)
  test(`512-secret load stays bounded: ${shape}`, { timeout: 10000 }, async t => {
    const repeated = randomUUID()[0]!;
    const secrets = Array.from({ length: 512 }, (_, i) => shape === "overlapping-values" ? repeated.repeat(8 + i) : `${randomUUID()}:"\\/é`);
    const registry = createSecretRedaction();
    registry.replaceGroup(Symbol("load"), secrets);
    const forms = registry.forms();
    const escaped = JSON.stringify(secrets[511]!).slice(1, -1).replaceAll("/", "\\/");
    const value = shape === "one-mib-no-hit" ? { ordinary: "public ".repeat(Math.floor((1024 * 1024 - 64) / 7)) }
      : shape === "nested-escaped-no-hit" ? { ordinary: "public\\u0020".repeat(75000) }
      : shape === "escaped-hit" ? { ordinary: "public ".repeat(8000) + escaped }
      : shape === "many-short-values" ? { ordinary: Array.from({ length: 50000 }, (_, i) => i === 25000 ? escaped : "public content!!") }
      : { ordinary: repeated.repeat(1024 * 1024 - 64) };
    const probe = dispatcherProbe(async () => value, () => registry.values(), { limits: { maxResultBytes: 1024 * 1024 } }, () => registry.forms());
    const started = performance.now();
    const heartbeat = delay(0).then(() => performance.now() - started);
    const result = await probe.run();
    const elapsed = performance.now() - started;
    const eventLoopDelay = await heartbeat;
    t.diagnostic(JSON.stringify({ shape, secretCount: secrets.length, inputBytes: Buffer.byteLength(JSON.stringify(value)),
      dispatchMs: Math.round(elapsed), eventLoopDelayMs: Math.round(eventLoopDelay) }));
    assert.equal(result.isError, false);
    assert.ok(eventLoopDelay < MAX_DELAY_MS, `event-loop delay ${Math.round(eventLoopDelay)} ms exceeds ${MAX_DELAY_MS} ms`);
    if (!result.isError) {
      if (shape.endsWith("no-hit")) assert.deepEqual(result.value, value);
      else {
        assert.ok(JSON.stringify(result.value).includes(MARK));
        assert.ok(!JSON.stringify(result.value).includes(shape === "overlapping-values" ? secrets[0]! : escaped));
      }
    }
    assert.equal(registry.forms(), forms, "an unchanged 512-secret set must retain its cached variants");
  });
