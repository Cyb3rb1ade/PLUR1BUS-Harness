// core/toolcall results: capResult budget semantics, idempotencyKey, MemoryIdempotency, executeBatch ordering/barriers
// and the policy boundary (does a call that needs approval ever run without it?).
// Expectations come from the doc comments in src/toolcall/results.ts and the ToolErrorCode taxonomy, not from running the code.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { capResult, idempotencyKey, MemoryIdempotency, executeBatch, type BatchCall, type IdempotencyPort } from "../../src/toolcall/results.ts";
import { ToolDispatcher, type DispatchContext } from "../../src/tools/dispatcher.ts";
import { ToolRegistry, type ToolDef } from "../../src/tools/registry.ts";
import type { ApprovalAsk } from "../../src/tools/approval.ts";
import type { Grant } from "../../src/policy/index.ts";
import { mulberry32, gap, deferred, flushMicrotasks, recordingStore, randomJson } from "./helpers.ts";

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const CODES = ["tool-unknown", "tool-call-invalid", "tool-denied", "tool-not-approved", "tool-timeout", "tool-failed", "tool-result-too-large", "tool-result-invalid", "aborted"];

/** A string value whose inline envelope is exactly `target` bytes. */
function fitting(target: number, unit = "a"): string {
  const overhead = bytes({ isError: false, value: "", truncated: false });
  const n = target - overhead;
  assert.ok(n >= 0, "target too small for an envelope");
  const per = Buffer.byteLength(unit);
  assert.equal(n % per, 0, "target must be a multiple of the unit size");
  return unit.repeat(n / per);
}

describe("capResult: budget boundary", () => {
  for (const [label, unit] of [["ascii", "a"], ["2-byte", "é"], ["3-byte", "€"], ["4-byte", "😀"]] as const) {
    it(`exactly maxBytes stays inline, one byte more is referenced (${label} payload)`, async () => {
      const overhead = bytes({ isError: false, value: "", truncated: false });
      const per = Buffer.byteLength(unit);
      const target = overhead + per * Math.floor((600 - overhead) / per); // largest envelope <= 600 bytes made of whole units
      const store = recordingStore();
      const inline = await capResult(fitting(target, unit), store, target);
      assert.equal(inline.isError, false); assert.equal(inline.truncated, false);
      assert.equal(typeof inline.value, "string"); assert.equal(inline.reference, undefined);
      assert.equal(store.puts.length, 0);
      assert.equal(bytes(inline), target, "the envelope fills the budget exactly");
      const over = await capResult(fitting(target, unit), store, target - 1);
      assert.deepEqual(over, { isError: false, truncated: true, reference: "ref-1" });
      assert.equal(store.puts.length, 1);
    });
  }

  it("the budget counts bytes, not characters: a 300-char emoji string is over a 600-byte budget", async () => {
    const value = "😀".repeat(150); // 150 chars... 300 UTF-16 units, 600 bytes + envelope
    const store = recordingStore();
    const r = await capResult(value, store, 600);
    assert.equal(r.truncated, true); assert.equal(r.reference, "ref-1"); assert.equal(store.puts[0], value);
  });

  it("minimum budget is 128 bytes; smaller, fractional and non-finite budgets are rejected", async () => {
    const store = recordingStore();
    await assert.rejects(capResult("x", store, 127), /at least 128/);
    await assert.rejects(capResult("x", store, 0), /at least 128/);
    await assert.rejects(capResult("x", store, -1), /at least 128/);
    await assert.rejects(capResult("x", store, 128.5), /at least 128/);
    await assert.rejects(capResult("x", store, Number.NaN), /at least 128/);
    await assert.rejects(capResult("x", store, Number.POSITIVE_INFINITY), /at least 128/);
    await assert.rejects(capResult("x", store, Number.MAX_SAFE_INTEGER + 2), /at least 128/);
    const ok = await capResult("x", store, 128);
    assert.deepEqual(ok, { isError: false, value: "x", truncated: false });
    assert.equal(store.puts.length, 0, "a rejected budget never reaches the store");
  });

  it("default budget is 32 KiB (documented: 8k tokens conservatively budgeted as 32 KiB)", async () => {
    const store = recordingStore();
    const inline = await capResult(fitting(32 * 1024), store);
    assert.equal(inline.truncated, false);
    const over = await capResult(fitting(32 * 1024 + 1), store);
    assert.equal(over.truncated, true);
  });

  it("an inline result is a detached copy: mutating it never touches the tool's own object", async () => {
    const source = { rows: [{ id: 1 }, { id: 2 }] };
    const r = await capResult(source, recordingStore());
    (r.value as typeof source).rows[0]!.id = 99;
    assert.equal(source.rows[0]!.id, 1);
  });

  it("a referenced result hands the ORIGINAL value to the store, once, and returns the store's reference verbatim", async () => {
    const big = { text: "q".repeat(5000) };
    const store = recordingStore(() => "blob/42");
    const r = await capResult(big, store, 1024);
    assert.deepEqual(r, { isError: false, truncated: true, reference: "blob/42" });
    assert.equal(store.puts.length, 1); assert.equal(store.puts[0], big);
    assert.ok(!("value" in r));
  });

  it("a rejecting store makes capResult reject (no silent inline fallback of an oversized value)", async () => {
    const failing = { async put(): Promise<string> { throw new Error("store offline"); } };
    await assert.rejects(capResult("y".repeat(5000), failing, 1024), /store offline/);
  });

  it("a reference that itself does not fit the budget is an error, not a truncated reference", async () => {
    const store = recordingStore(() => "r".repeat(500));
    await assert.rejects(capResult("y".repeat(5000), store, 128), /reference exceeds result budget/);
  });
});

describe("capResult: value classes", () => {
  it("binary values (Uint8Array, Buffer, ArrayBuffer) are always referenced, however small", async () => {
    for (const value of [new Uint8Array([1, 2, 3]), Buffer.from("hi"), new ArrayBuffer(2), new Uint8Array(0)]) {
      const store = recordingStore();
      const r = await capResult(value, store);
      assert.deepEqual(r, { isError: false, truncated: true, reference: "ref-1" });
      assert.equal(store.puts[0], value);
    }
  });

  it("values JSON cannot encode (BigInt, cycles) are referenced instead of throwing", async () => {
    const cyc: Record<string, unknown> = {}; cyc["self"] = cyc;
    for (const value of [10n, cyc, { n: 1n }]) {
      const store = recordingStore();
      const r = await capResult(value, store);
      assert.equal(r.truncated, true); assert.equal(r.reference, "ref-1"); assert.equal(store.puts[0], value);
    }
  });

  it("null, booleans, numbers and strings pass through unchanged", async () => {
    for (const value of [null, true, false, 0, -7.5, "", "text"]) {
      const r = await capResult(value, recordingStore());
      assert.deepEqual(r, { isError: false, value, truncated: false });
    }
  });

  it("an Error instance becomes a fixed tool-failed result; message, stack and cause are not returned", async () => {
    const e = new Error("redact-probe-alpha", { cause: "redact-probe-beta" });
    const r = await capResult(e, recordingStore());
    assert.equal(r.isError, true); assert.equal(r.truncated, false);
    assert.equal(r.error?.code, "tool-failed");
    const text = JSON.stringify(r);
    assert.ok(!text.includes("redact-probe-alpha") && !text.includes("redact-probe-beta") && !text.includes("at "));
    const t = await capResult(new TypeError("redact-probe-alpha"), recordingStore());
    assert.deepEqual(t, r, "every Error subclass maps to the same fixed result");
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - JSON round trip silently loses Map/Set/undefined/NaN/Date detail", async () => {
    const store = recordingStore();
    assert.deepEqual((await capResult(new Map([[1, 2]]), store)).value, {});
    assert.deepEqual((await capResult(new Set([1]), store)).value, {});
    assert.deepEqual((await capResult({ a: Number.NaN, b: undefined, c: Number.POSITIVE_INFINITY }, store)).value, { a: null, c: null });
    assert.equal(typeof (await capResult(new Date(0), store)).value, "string");
    const undef = await capResult(undefined, store);
    assert.equal(undef.isError, false); assert.ok(!("value" in undef), "undefined vanishes from the envelope");
    assert.equal(store.puts.length, 0);
  });
});

describe("capResult: tool-reported errors ({isError:true})", () => {
  it("only the nine ToolErrorCode values are passed through", async () => {
    for (const code of CODES) {
      const r = await capResult({ isError: true, error: { code, hint: "h" } }, recordingStore());
      assert.deepEqual(r, { isError: true, error: { code, hint: "h" }, truncated: false });
    }
  });

  it("unknown, missing and non-string codes collapse to tool-failed", async () => {
    for (const code of ["E_SECRET", "TOOL-FAILED", "tool-failed ", "", undefined, null, 7, {}, ["tool-denied"], "__proto__", "constructor"]) {
      const r = await capResult({ isError: true, error: { code, hint: "h" } }, recordingStore());
      assert.equal(r.error?.code, "tool-failed", `code ${JSON.stringify(code)}`);
    }
  });

  it("a missing or malformed error object gives tool-failed with the default hint", async () => {
    for (const value of [{ isError: true }, { isError: true, error: null }, { isError: true, error: "boom" }, { isError: true, error: [] }, { isError: true, error: 5 }]) {
      const r = await capResult(value, recordingStore());
      assert.deepEqual(r, { isError: true, error: { code: "tool-failed", hint: "Tool reported an error." }, truncated: false }, JSON.stringify(value));
    }
  });

  it("the hint is cut to 80 characters with line breaks collapsed to one space", async () => {
    const long = await capResult({ isError: true, error: { code: "tool-denied", hint: "x".repeat(200) } }, recordingStore());
    assert.equal(long.error?.hint.length, 80);
    const lines = await capResult({ isError: true, error: { code: "tool-denied", hint: "a\r\n\r\nb\nc\rd" } }, recordingStore());
    assert.equal(lines.error?.hint, "a b c d");
    const exact = await capResult({ isError: true, error: { code: "tool-denied", hint: "y".repeat(80) } }, recordingStore());
    assert.equal(exact.error?.hint, "y".repeat(80));
    const empty = await capResult({ isError: true, error: { code: "tool-denied", hint: "" } }, recordingStore());
    assert.equal(empty.error?.hint, "");
  });

  it("non-string hints fall back to the default", async () => {
    for (const hint of [undefined, null, 5, {}, ["x"]]) {
      const r = await capResult({ isError: true, error: { code: "tool-timeout", hint } }, recordingStore());
      assert.equal(r.error?.hint, "Tool reported an error.");
    }
  });

  it("extra fields (message, stack, details, secrets) are dropped from the model-facing result", async () => {
    const r = await capResult({ isError: true, message: "redact-probe-alpha", error: { code: "tool-failed", hint: "ok", message: "redact-probe-beta", stack: "at x", details: { k: 1 } }, extra: 1 }, recordingStore());
    assert.deepEqual(r, { isError: true, error: { code: "tool-failed", hint: "ok" }, truncated: false });
  });

  it("only a literal isError === true counts: truthy strings, 1 and nested flags are ordinary data", async () => {
    for (const value of [{ isError: "true" }, { isError: 1 }, { isError: false }, { data: { isError: true } }, [{ isError: true }]]) {
      const r = await capResult(value, recordingStore());
      assert.equal(r.isError, false, JSON.stringify(value)); assert.deepEqual(r.value, value);
    }
  });

  it("an error whose compact form exceeds the budget is stored and referenced (isError and truncated flags kept)", async () => {
    // 80 UTF-16 units of a 4-byte emoji = 40 emoji = 160 bytes of hint: the compact error cannot fit in 128 bytes.
    const original = { isError: true, error: { code: "tool-result-too-large", hint: "😀".repeat(40) } };
    const store = recordingStore();
    const r = await capResult(original, store, 128);
    assert.deepEqual(r, { isError: true, truncated: true, reference: "ref-1" });
    assert.equal(store.puts[0], original);
  });

  it("an error-shaped result with an over-long reference throws (not a half-built result)", async () => {
    const original = { isError: true, error: { code: "tool-result-too-large", hint: "😀".repeat(40) } };
    await assert.rejects(capResult(original, recordingStore(() => "r".repeat(300)), 128), /reference exceeds result budget/);
  });
});

describe("capResult: seeded generative invariants", () => {
  const SEED = 0x5eed01;
  it("300 random values and budgets: the result never exceeds the budget, inline iff it fits, reference only when stored", async () => {
    const rnd = mulberry32(SEED);
    for (let i = 0; i < 300; i++) {
      const value = randomJson(rnd);
      const max = 128 + Math.floor(rnd() * 1500);
      const store = recordingStore();
      const r = await capResult(value, store, max);
      const ctx = `seed=${SEED} case=${i} max=${max} value=${JSON.stringify(value).slice(0, 80)}`;
      assert.ok(bytes(r) <= max, `${ctx}: ${bytes(r)} > ${max}`);
      const wouldFit = bytes({ isError: false, value, truncated: false }) <= max;
      if (wouldFit) {
        assert.equal(r.truncated, false, ctx); assert.equal(store.puts.length, 0, ctx);
        assert.deepEqual(r.value, JSON.parse(JSON.stringify(value)), ctx);
      } else {
        assert.equal(r.truncated, true, ctx); assert.equal(r.reference, "ref-1", ctx);
        assert.equal(store.puts.length, 1, ctx); assert.equal(store.puts[0], value, ctx);
      }
    }
  });
});

describe("idempotencyKey", () => {
  it("is a 64-character lower-case hex digest", () => {
    assert.match(idempotencyKey("s", "n", { a: 1 }), /^[0-9a-f]{64}$/);
  });

  it("object key order does not matter at any depth; array order does", () => {
    assert.equal(idempotencyKey("s", "n", { a: 1, b: { c: 2, d: [1, { x: 1, y: 2 }] } }), idempotencyKey("s", "n", { b: { d: [1, { y: 2, x: 1 }], c: 2 }, a: 1 }));
    assert.notEqual(idempotencyKey("s", "n", [1, 2]), idempotencyKey("s", "n", [2, 1]));
  });

  it("scope, tool name and arguments each change the key", () => {
    const base = idempotencyKey("s", "n", { a: 1 });
    assert.notEqual(base, idempotencyKey("s2", "n", { a: 1 }));
    assert.notEqual(base, idempotencyKey("s", "n2", { a: 1 }));
    assert.notEqual(base, idempotencyKey("s", "n", { a: 2 }));
    assert.notEqual(idempotencyKey("a", "b:c", {}), idempotencyKey("a:b", "c", {}), "scope/name boundary is unambiguous");
  });

  it("JSON types that look alike stay distinct", () => {
    const keys = [1, "1", true, "true", null, "null", [], {}, [[]], [{}], "", 0, "0", false, [null], { a: null }, { a: "null" }, "[]", "{}"].map(v => idempotencyKey("s", "n", v));
    assert.equal(new Set(keys).size, keys.length);
  });

  it("rejects arguments that are not finite acyclic JSON", () => {
    const cyc: Record<string, unknown> = {}; cyc["me"] = cyc;
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, cyc, [undefined], { a: undefined }, () => 1, Symbol("x")]) {
      assert.throws(() => idempotencyKey("s", "n", bad), /finite acyclic JSON/, String(typeof bad));
    }
  });

  it("a shared (non-cyclic) sub-object used twice is fine", () => {
    const shared = { k: 1 };
    assert.doesNotThrow(() => idempotencyKey("s", "n", [shared, shared, { again: shared }]));
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - Date/Map/Set/class instances all canonicalise like {} and -0 like 0", () => {
    const empty = idempotencyKey("s", "n", {});
    assert.equal(idempotencyKey("s", "n", new Date(0)), empty);
    assert.equal(idempotencyKey("s", "n", new Map([[1, 2]])), empty);
    assert.equal(idempotencyKey("s", "n", new Set([1])), empty);
    assert.equal(idempotencyKey("s", "n", -0), idempotencyKey("s", "n", 0));
  });

  it("no collisions among 500 seeded distinct calls", () => {
    const rnd = mulberry32(0xc011);
    const seen = new Map<string, string>(); const identities = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const triple = JSON.stringify([`scope-${Math.floor(rnd() * 5)}`, `tool_${Math.floor(rnd() * 5)}`, randomJson(rnd), i]);
      const [scope, name, args] = JSON.parse(triple) as [string, string, unknown, number];
      // The index i is part of the identity of the case but not of the call: only dedupe by (scope, name, args).
      const identity = JSON.stringify([scope, name, args]);
      const key = idempotencyKey(scope, name, args); identities.add(identity);
      const prior = seen.get(key);
      assert.ok(prior === undefined || prior === identity, `seed=0xc011 case=${i}: key collision between ${prior} and ${identity}`);
      seen.set(key, identity);
    }
    assert.equal(seen.size, identities.size, "one key per distinct (scope, name, args)");
    assert.ok(identities.size > 300, "the generator produces mostly distinct calls");
  });
});

describe("MemoryIdempotency", () => {
  it("concurrent and repeated runs of one key execute once and share the promise", async () => {
    const port = new MemoryIdempotency(); let n = 0;
    const gate = deferred<string>();
    const exec = () => { n++; return gate.promise; };
    const a = port.run("k", exec); const b = port.run("k", exec);
    gate.resolve("v");
    assert.deepEqual(await Promise.all([a, b]), ["v", "v"]);
    assert.equal(await port.run("k", exec), "v");
    assert.equal(n, 1);
  });

  it("different keys execute independently", async () => {
    const port = new MemoryIdempotency(); let n = 0;
    await port.run("a", async () => ++n); await port.run("b", async () => ++n);
    assert.equal(n, 2);
  });

  it("clear() forgets everything: the next run executes again", async () => {
    const port = new MemoryIdempotency(); let n = 0;
    await port.run("k", async () => ++n); port.clear();
    assert.equal(await port.run("k", async () => ++n), 2);
  });

  it("execute is deferred to a microtask: run() itself never throws synchronously, a throwing execute becomes a rejection", async () => {
    const port = new MemoryIdempotency();
    let p!: Promise<unknown>;
    assert.doesNotThrow(() => { p = port.run("k", () => { throw new Error("sync boom"); }); });
    await assert.rejects(p, /sync boom/);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a rejection is cached forever and replayed to later callers until clear()", async () => {
    const port = new MemoryIdempotency(); let n = 0;
    const exec = async () => { n++; throw new Error("first failure"); };
    await assert.rejects(port.run("k", exec), /first failure/);
    await assert.rejects(port.run("k", async () => "would succeed"), /first failure/);
    assert.equal(n, 1);
    port.clear();
    assert.equal(await port.run("k", async () => "now"), "now");
  });
});

describe("executeBatch: ordering, barriers, errors", () => {
  const call = (name: string, over: Partial<BatchCall> = {}): BatchCall => ({ name, arguments: { n: name }, parallelSafe: true, ...over });

  it("an empty batch returns an empty list and runs nothing", async () => {
    let ran = 0;
    assert.deepEqual(await executeBatch("s", [], async () => { ran++; }), []);
    assert.equal(ran, 0);
  });

  it("results come back in request order even when completion order is reversed", async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const names = ["t0", "t1", "t2"];
    const done = executeBatch("s", names.map(n => call(n)), (c) => gates[names.indexOf(c.name)]!.promise);
    gates[2]!.resolve("third"); gates[0]!.resolve("first"); gates[1]!.resolve("second");
    assert.deepEqual(await done, ["first", "second", "third"]);
  });

  it("parallel-safe calls start together, before any of them has finished", async () => {
    const started: string[] = []; const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const done = executeBatch("s", [call("a"), call("b"), call("c")], (c) => { started.push(c.name); return gates[started.length - 1]!.promise; });
    await flushMicrotasks();
    assert.deepEqual(started, ["a", "b", "c"]);
    for (const g of gates) g.resolve("x");
    await done;
  });

  it("an unsafe call is a barrier: it waits for earlier calls and later calls wait for it", async () => {
    const log: string[] = []; const gates = new Map<string, ReturnType<typeof deferred<string>>>();
    const gate = (n: string) => { const g = deferred<string>(); gates.set(n, g); return g.promise; };
    const done = executeBatch("s", [call("r1"), call("r2"), call("w", { parallelSafe: false }), call("r3"), call("r4")], (c) => { log.push(`start:${c.name}`); return gate(c.name).then(v => { log.push(`end:${c.name}`); return v; }); });
    await flushMicrotasks();
    assert.deepEqual(log, ["start:r1", "start:r2"], "the unsafe call has not started while earlier calls run");
    gates.get("r1")!.resolve("1"); await flushMicrotasks();
    assert.ok(!log.includes("start:w"), "still waiting for r2");
    gates.get("r2")!.resolve("2"); await flushMicrotasks();
    assert.ok(log.includes("start:w") && !log.includes("start:r3"), "r3 waits for the barrier");
    gates.get("w")!.resolve("w"); await flushMicrotasks();
    assert.ok(log.includes("start:r3") && log.includes("start:r4"));
    assert.ok(log.indexOf("end:w") < log.indexOf("start:r3"));
    gates.get("r3")!.resolve("3"); gates.get("r4")!.resolve("4");
    assert.deepEqual(await done, ["1", "2", "w", "3", "4"]);
  });

  it("a batch of only unsafe calls runs strictly one after another", async () => {
    let active = 0, max = 0; const order: string[] = [];
    await executeBatch("s", ["a", "b", "c"].map(n => call(n, { parallelSafe: false })), async (c) => { active++; max = Math.max(max, active); order.push(c.name); await flushMicrotasks(3); active--; return c.name; });
    assert.equal(max, 1); assert.deepEqual(order, ["a", "b", "c"]);
  });

  it("the executor receives the idempotency key built from scope:operationId, name and arguments", async () => {
    const seen: string[] = [];
    await executeBatch("agent-1/sess-1", [call("n1", { operationId: "op-7", arguments: { b: 1, a: 2 } }), call("n2")], async (_c, key) => { seen.push(key); });
    assert.deepEqual(seen, [idempotencyKey("agent-1/sess-1:op-7", "n1", { a: 2, b: 1 }), idempotencyKey("agent-1/sess-1:", "n2", { n: "n2" })]);
  });

  it("identical calls with the same operationId execute once; a different operationId executes again", async () => {
    let n = 0;
    const exec = async () => ++n;
    assert.deepEqual(await executeBatch("s", [call("t", { operationId: "o" }), call("t", { operationId: "o" })], exec), [1, 1]);
    assert.deepEqual(await executeBatch("s", [call("t", { operationId: "o2" })], exec), [2], "a fresh port per batch by default");
  });

  it("a shared port coalesces across batches in the same scope but never across scopes", async () => {
    const port = new MemoryIdempotency(); const ran: string[] = [];
    const exec = async (_c: BatchCall, key: string) => { ran.push(key); return ran.length; };
    const args = { q: 1 };
    await executeBatch("scope-A", [call("t", { arguments: args })], exec, port);
    await executeBatch("scope-A", [call("t", { arguments: args })], exec, port);
    await executeBatch("scope-B", [call("t", { arguments: args })], exec, port);
    assert.equal(ran.length, 2);
    assert.notEqual(ran[0], ran[1]);
  });

  it("an executor exception becomes a generic tool-failed result without the message, and does not disturb the neighbours", async () => {
    const out = await executeBatch("s", [call("ok1"), call("bad"), call("ok2")], async (c) => { if (c.name === "bad") throw new Error("redact-probe-alpha"); return c.name; });
    assert.equal(out[0], "ok1"); assert.equal(out[2], "ok2");
    assert.deepEqual(out[1], { isError: true, error: { code: "tool-failed", hint: "Tool execution failed." } });
    assert.ok(!JSON.stringify(out).includes("redact-probe-alpha"));
  });

  it("non-Error throws (strings, undefined, objects) are handled the same way", async () => {
    for (const thrown of ["text", undefined, { code: "tool-denied" }, 42, null]) {
      const [r] = await executeBatch("s", [call("x")], async () => { throw thrown; });
      assert.deepEqual(r, { isError: true, error: { code: "tool-failed", hint: "Tool execution failed." } });
    }
  });

  it("an unsafe call that throws still releases the barrier", async () => {
    const out = await executeBatch("s", [call("w", { parallelSafe: false }), call("r")], async (c) => { if (c.name === "w") throw new Error("x"); return "after"; });
    assert.equal((out[0] as { isError: boolean }).isError, true); assert.equal(out[1], "after");
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a thrown executor error is cached as a generic failure; an identical retry in the same scope is not re-executed", async () => {
    const port = new MemoryIdempotency(); let n = 0;
    const exec = async () => { n++; if (n === 1) throw new Error("transient"); return "fine"; };
    const first = await executeBatch("s", [call("t", { operationId: "o" })], exec, port);
    const retry = await executeBatch("s", [call("t", { operationId: "o" })], exec, port);
    assert.deepEqual(first, retry); assert.equal(n, 1);
    assert.equal((retry[0] as { error: { code: string } }).error.code, "tool-failed");
    const withNewOp = await executeBatch("s", [call("t", { operationId: "o2" })], exec, port);
    assert.equal(withNewOp[0], "fine", "a new operationId is the documented way to retry");
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - arguments that cannot be canonicalised reject the whole batch (calls started before still run)", async () => {
    const ran: string[] = [];
    await assert.rejects(executeBatch("s", [call("good"), call("bad", { arguments: { n: Number.NaN } })], async (c) => { ran.push(c.name); }), /finite acyclic JSON/);
    await flushMicrotasks();
    assert.deepEqual(ran, ["good"]);
  });

  it("every call goes through the injected idempotency port exactly once, with the same key the executor sees", async () => {
    const ports: string[] = []; const execKeys: string[] = [];
    const port: IdempotencyPort = { run(key, execute) { ports.push(key); return execute(); } };
    await executeBatch("s", [call("a"), call("b", { parallelSafe: false }), call("c")], async (_c, key) => { execKeys.push(key); }, port);
    assert.deepEqual(ports, execKeys); assert.equal(ports.length, 3);
  });
});

describe("executeBatch and the approval policy (SICHERHEIT)", () => {
  const NOGRANTS = { list: () => [] as readonly Grant[], get: () => undefined };
  const askTool = (ran: string[]): ToolDef => ({
    name: "demo.net", description: "network submit", capability: "net.submit", effect: "external", risk: "medium", trust: "operator-vetted",
    inputSchema: { type: "object", additionalProperties: false, required: ["q"], properties: { q: { type: "string", maxLength: 20 } } },
    execute: async (a) => { ran.push((a as { q: string }).q); return { sent: (a as { q: string }).q }; },
  });
  const ctxFor = (agentId: string): DispatchContext => ({ agentId, principal: `user:v1:${agentId}`, sessionId: "s1", surface: 3, signal: new AbortController().signal });

  /** A real dispatcher whose approval port only approves the listed agents. The ports record every ask. */
  function rig(approveAgents: readonly string[]) {
    const ran: string[] = []; const asks: ApprovalAsk[] = [];
    const registry = new ToolRegistry(); registry.register(askTool(ran));
    let clock = 1000;
    const dispatcher = new ToolDispatcher({
      registry, grants: NOGRANTS, clock: { now: () => (clock += 1) }, timers: { set: () => () => {} },
      approvals: { async request(a) { asks.push(a); return approveAgents.includes(a.agentId) ? { approved: true } : { approved: false, reason: "not on the list" }; } },
    });
    const executorFor = (agentId: string) => (c: BatchCall) => dispatcher.call({ id: c.operationId ?? "call", name: c.name, args: c.arguments }, ctxFor(agentId));
    return { ran, asks, executorFor };
  }
  const net = (q: string, operationId?: string): BatchCall => ({ name: "demo.net", arguments: { q }, parallelSafe: false, ...(operationId ? { operationId } : {}) });

  it("a call needing approval is not executed when approval is refused", async () => {
    const { ran, asks, executorFor } = rig([]);
    const [r] = await executeBatch("alice/s1", [net("a")], executorFor("alice")) as [{ isError: boolean; error: { code: string } }];
    assert.equal(r.isError, true); assert.equal(r.error.code, "tool-not-approved");
    assert.deepEqual(ran, []); assert.equal(asks.length, 1);
  });

  it("parallel-safe flagging does not skip the approval: a refused call in a group stays unexecuted while an approved neighbour runs", async () => {
    const { ran, asks, executorFor } = rig(["alice"]);
    const calls: BatchCall[] = [{ ...net("yes", "o1"), parallelSafe: true }, { ...net("also", "o2"), parallelSafe: true }];
    const out = await executeBatch("alice/s1", calls, executorFor("alice")) as { isError: boolean }[];
    assert.deepEqual(out.map(r => r.isError), [false, false]); assert.deepEqual(ran.sort(), ["also", "yes"]); assert.equal(asks.length, 2);
    const denied = rig([]);
    const refused = await executeBatch("mallory/s1", calls, denied.executorFor("mallory")) as { isError: boolean }[];
    assert.deepEqual(refused.map(r => r.isError), [true, true]); assert.deepEqual(denied.ran, []);
  });

  it("different scopes never share a cached approval: the same arguments ask again for another agent", async () => {
    const { ran, asks, executorFor } = rig(["alice"]);
    const port = new MemoryIdempotency();
    const a = await executeBatch("alice/s1", [net("same")], executorFor("alice"), port) as { isError: boolean }[];
    const m = await executeBatch("mallory/s1", [net("same")], executorFor("mallory"), port) as { isError: boolean; error?: { code: string } }[];
    assert.equal(a[0]!.isError, false); assert.equal(m[0]!.isError, true); assert.equal(m[0]!.error?.code, "tool-not-approved");
    assert.deepEqual(ran, ["same"]); assert.deepEqual(asks.map(x => x.agentId), ["alice", "mallory"]);
  });

  it("different arguments in the same scope are separate approval decisions", async () => {
    const { asks, executorFor } = rig(["alice"]);
    const port = new MemoryIdempotency();
    await executeBatch("alice/s1", [net("one"), net("two")], executorFor("alice"), port);
    assert.equal(asks.length, 2);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - an identical repeat in the same scope is answered from the cache without a new approval, and a refusal is cached too", async () => {
    const approved = rig(["alice"]); const port = new MemoryIdempotency();
    await executeBatch("alice/s1", [net("x")], approved.executorFor("alice"), port);
    await executeBatch("alice/s1", [net("x")], approved.executorFor("alice"), port);
    assert.equal(approved.asks.length, 1); assert.deepEqual(approved.ran, ["x"]);
    const refused = rig([]); const port2 = new MemoryIdempotency();
    const r1 = await executeBatch("bob/s1", [net("y")], refused.executorFor("bob"), port2);
    const r2 = await executeBatch("bob/s1", [net("y")], refused.executorFor("bob"), port2);
    assert.deepEqual(r1, r2); assert.equal(refused.asks.length, 1, "the owner is not asked again after a refusal unless the operationId changes");
  });

  it(gap("executeBatch (idempotency key)", "distinct (scope, operationId) pairs get distinct keys", "scope 'a:b' + operationId 'c' and scope 'a' + operationId 'b:c' share one key"), async () => {
    const keys: string[] = [];
    const record = async (_c: BatchCall, key: string) => { keys.push(key); };
    await executeBatch("a:b", [{ name: "n", arguments: {}, parallelSafe: true, operationId: "c" }], record, new MemoryIdempotency());
    await executeBatch("a", [{ name: "n", arguments: {}, parallelSafe: true, operationId: "b:c" }], record, new MemoryIdempotency());
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
  });

  it(gap("executeBatch (cross-scope cache)", "a call in another scope is decided by its own policy and approval", "a cached, approved result of scope 'alice:s1'+op 'x' is served to scope 'alice'+op 's1:x' without any approval"), async () => {
    const { ran, asks, executorFor } = rig(["alice"]);
    const shared = new MemoryIdempotency();
    // First scope: approved and executed.
    await executeBatch("alice:s1", [{ ...net("payload", "x") }], executorFor("alice"), shared);
    // Second, different scope (different agent, which the owner has NOT approved) only differs in where the colon sits.
    const [r] = await executeBatch("alice", [{ ...net("payload", "s1:x") }], executorFor("mallory"), shared) as [{ isError: boolean; error?: { code: string } }];
    // Expected: mallory is evaluated on her own (refused). Observed: nothing in her scope is evaluated if the keys collide.
    assert.equal(r.isError, true);
    assert.equal(r.error?.code, "tool-not-approved");
    assert.deepEqual(ran, ["payload"], "mallory's call was never executed");
    assert.deepEqual(asks.map(x => x.agentId), ["alice", "mallory"], "mallory was asked on her own");
  });

  it("the same scope and operationId (both containing ':' or a backslash) still hit the cache without a new approval", async () => {
    const { ran, asks, executorFor } = rig(["alice"]);
    const shared = new MemoryIdempotency();
    await executeBatch("alice:s1", [net("payload", "x:y")], executorFor("alice"), shared);
    const [r] = await executeBatch("alice:s1", [net("payload", "x:y")], executorFor("alice"), shared) as [{ isError: boolean }];
    assert.equal(r.isError, false); assert.deepEqual(ran, ["payload"]); assert.equal(asks.length, 1);
    await executeBatch("a\\", [net("p", "b")], executorFor("alice"), shared);
    await executeBatch("a\\", [net("p", "b")], executorFor("alice"), shared);
    assert.equal(asks.length, 2, "backslash scopes cache normally too");
  });
});
