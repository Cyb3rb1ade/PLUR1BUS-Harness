// #836 scale: keep synchronous work bounded with 512 secrets, including nested JSON escape spellings.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createSecretRedaction } from "../../src/secrets/redaction.ts";
import { dispatcherProbe } from "./fixtures/dispatcher.ts";
import { maskSecretsInJson } from "../../src/logs/redact.ts";
import type { SecretFormsSnapshot } from "../../src/logs/secret-forms.ts";

const MARK = "[REDACTED:secret]";
// A regression ceiling for shared runners, not a production latency SLO. Each case measures one complete dispatch.
const MAX_DELAY_MS = 10000;
function assertLinearWork(snapshot: SecretFormsSnapshot, json: string): number {
  const scan = snapshot.matcher.scanJson(json);
  // At most five input streams (wire, decoded/nested and their well-formed spellings), linear failure traversal, then one
  // reverse automaton walk. The form-length term bounds compiled states, including each form's JSON wire spelling.
  const budget = json.length * 16 + snapshot.forms.reduce((sum, form) => sum + form.length * 10, 0);
  assert.ok(scan.operations <= budget, `matcher work ${scan.operations} exceeds linear budget ${budget}`);
  return scan.operations;
}

for (const hit of [false, true]) test(`512 secrets and 170000 short escaped tokens use bounded scanning: ${hit ? "late hit" : "no hit"}`, { timeout: 30000 }, t => {
  const secrets = Array.from({ length: 512 }, () => `${randomUUID()}:"\\/é`);
  const registry = createSecretRedaction(); registry.replaceGroup(Symbol("short-escaped"), secrets);
  const forms = registry.forms();
  const value = Array.from({ length: 170000 }, () => "\n");
  if (hit) value.push(JSON.stringify(secrets[511]!).slice(1, -1));
  const json = JSON.stringify(value);
  const operations = assertLinearWork(registry.snapshot(), json);
  // Count real substring probes, rather than relying on a shared runner's clock. The old forms × tokens loop exceeds this
  // budget before completing; stop it before the full billion-probe workload completes. Instrumentation overhead is not a timing baseline.
  let probes = 0;
  const includes = String.prototype.includes;
  t.mock.method(String.prototype, "includes", function (this: string, ...args: Parameters<typeof includes>) {
    assert.ok(++probes <= json.length * 4, "substring probes grew with forms × escaped tokens");
    return Reflect.apply(includes, this, args);
  });
  const masked = maskSecretsInJson(json, value, [], forms);
  assert.equal(masked !== undefined, hit);
  if (hit) assert.equal((masked!.value as string[]).at(-1), MARK);
  t.diagnostic(JSON.stringify({ shape: hit ? "short-escaped-late-hit" : "short-escaped-no-hit", tokens: value.length, probes, operations }));
});

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
    const operations = assertLinearWork(registry.snapshot(), JSON.stringify(value));
    const probe = dispatcherProbe(async () => value, () => registry.values(), { limits: { maxResultBytes: 1024 * 1024 } }, () => registry.forms());
    const started = performance.now();
    const heartbeat = delay(0).then(() => performance.now() - started);
    const result = await probe.run();
    const elapsed = performance.now() - started;
    const eventLoopDelay = await heartbeat;
    t.diagnostic(JSON.stringify({ shape, secretCount: secrets.length, inputBytes: Buffer.byteLength(JSON.stringify(value)),
      dispatchMs: Math.round(elapsed), eventLoopDelayMs: Math.round(eventLoopDelay), operations }));
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
