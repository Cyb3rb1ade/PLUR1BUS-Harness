// The fan-out scheduler: generations, abort, per-source time limit, silent drops. Pure, no browser.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runFanout, type Source } from "../src/palette/fanout.ts";
import { parseAgentRows, parseSessionRows } from "../src/palette/fanout-sources.ts";

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
const later = (v: unknown, ms: number): Source["load"] => (_q, signal) => new Promise((res, rej) => {
  const t = setTimeout(() => { res(v); }, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true });
});

describe("runFanout", () => {
  test("delivers each source as it arrives, fastest first", async () => {
    const got: string[] = [];
    runFanout("x", [{ id: "slow", load: later(["s"], 30) }, { id: "fast", load: later(["f"], 1) }], new AbortController().signal, (id) => { got.push(id); }, 500);
    await tick(80);
    assert.deepEqual(got, ["fast", "slow"]);
  });
  test("a failing source is reported once as null and does not touch the others", async () => {
    const got: [string, unknown][] = [];
    const bad: Source = { id: "bad", load: () => Promise.reject(Object.assign(new Error("no"), { kind: "forbidden" })) };
    const thrower: Source = { id: "throws", load: () => { throw new Error("sync"); } };
    runFanout("x", [bad, thrower, { id: "ok", load: later([1], 1) }], new AbortController().signal, (id, v) => { got.push([id, v]); }, 500);
    await tick(40);
    assert.deepEqual(got.sort((a, b) => a[0].localeCompare(b[0])), [["bad", null], ["ok", [1]], ["throws", null]]);
  });
  test("a source slower than the limit is dropped and its request is aborted; a late answer is ignored", async () => {
    const got: [string, unknown][] = [];
    let aborted = false;
    const slow: Source = { id: "slow", load: (_q, signal) => new Promise((res) => { signal.addEventListener("abort", () => { aborted = true; }); setTimeout(() => { res(["late"]); }, 60); }) };
    runFanout("x", [slow], new AbortController().signal, (id, v) => { got.push([id, v]); }, 15);
    await tick(100);
    assert.deepEqual(got, [["slow", null]]);
    assert.equal(aborted, true);
  });
  test("aborting the generation silences everything and aborts the requests", async () => {
    const ctl = new AbortController();
    const got: string[] = [];
    let seen: AbortSignal | undefined;
    runFanout("x", [{ id: "a", load: (_q, s) => { seen = s; return later(["a"], 20)(_q, s); } }], ctl.signal, (id) => { got.push(id); }, 500);
    ctl.abort();
    await tick(60);
    assert.deepEqual(got, []);
    assert.equal(seen?.aborted, true);
  });
  test("an already aborted generation starts nothing", async () => {
    const ctl = new AbortController();
    ctl.abort();
    let started = 0;
    runFanout("x", [{ id: "a", load: () => { started++; return Promise.resolve([]); } }], ctl.signal, () => { started += 10; }, 50);
    await tick(20);
    assert.equal(started, 0);
  });
  test("an older generation never delivers after a newer one was started", async () => {
    const got: string[] = [];
    const old = new AbortController();
    runFanout("al", [{ id: "s", load: later(["old"], 30) }], old.signal, (_id, v) => { got.push(`old:${String(v)}`); }, 500);
    old.abort();
    runFanout("alp", [{ id: "s", load: later(["new"], 2) }], new AbortController().signal, (_id, v) => { got.push(`new:${String(v)}`); }, 500);
    await tick(80);
    assert.deepEqual(got, ["new:new"]);
  });
});

describe("source parsers", () => {
  test("agents: id and display name, id as fallback, sorted, junk skipped", () => {
    assert.deepEqual(parseAgentRows({ value: { zed: { displayName: "Zed" }, bernd: {}, x: 3, arr: [] } }), [{ id: "arr", name: "arr" }, { id: "bernd", name: "bernd" }, { id: "zed", name: "Zed" }].filter((r) => r.id !== "arr"));
    assert.deepEqual(parseAgentRows(null), []);
    assert.deepEqual(parseAgentRows({ value: "x" }), []);
  });
  test("sessions: id required, title and agent default to empty", () => {
    assert.deepEqual(parseSessionRows({ sessions: [{ id: "s1", title: "T", agentId: "a" }, { title: "no id" }, { id: "s2" }, 4] }), [{ id: "s1", title: "T", agentId: "a" }, { id: "s2", title: "", agentId: "" }]);
    assert.deepEqual(parseSessionRows({}), []);
  });
});
