import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScanError } from "../../src/discovery/http.ts";
import { ID_RE, checkId, checkPositiveInt, checkString, finalizeEntries } from "../../src/discovery/validate.ts";
import type { RawEntry } from "../../src/discovery/types.ts";

const invalid = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof ScanError && e.result === "failed:invalid" && e.reason === "invalid_entry");
// the openai-shaped mapping each scanner uses: every entry is validated, one bad one fails the lot
const mapOpenAi = (data: { id: unknown; created?: unknown }[]): RawEntry[] => data.map((d) => ({ id: checkId(d.id), ...(d.created !== undefined ? { created: checkPositiveInt(d.created) * 1000 } : {}) }));

describe("entry validation", () => {
  it("accepts legal ids", () => {
    for (const id of ["llama3.2:latest", "vendor/model@v1+x", "A", "a".repeat(256)]) assert.equal(checkId(id), id);
    assert.ok(ID_RE.test("x"));
    const { entries } = finalizeEntries([{ id: "Model" }, { id: "model" }]);
    assert.deepEqual(entries.map((e) => e.id), ["Model", "model"]);
  });

  it("rejects illegal ids", () => {
    for (const id of ["", " x", "-x", "a b", "a\u{1F600}", "a".repeat(257), 5, null, undefined]) invalid(() => checkId(id));
  });

  it("one invalid entry fails the whole scan", () => {
    invalid(() => mapOpenAi([{ id: "ok-1" }, { id: "bad id" }, { id: "ok-2" }]));
    assert.equal(mapOpenAi([{ id: "ok-1" }, { id: "ok-2", created: 2 }]).length, 2);
  });

  it("caps strings by bytes and refuses control characters", () => {
    invalid(() => checkString("\u20AC".repeat(171)));          // 513 bytes
    assert.equal(checkString("\u20AC".repeat(170) + "xx").length, 172); // 512 bytes
    invalid(() => checkString("a\u0007b")); invalid(() => checkString("a\u0085b")); invalid(() => checkString("a\u007fb"));
    invalid(() => checkString(5));
  });

  it("numbers are finite positive integers", () => {
    for (const n of [0, -1, 1.5, Infinity, JSON.parse("1e400"), NaN, "3", null]) invalid(() => checkPositiveInt(n));
    assert.equal(checkPositiveInt(1), 1);
  });

  it("duplicates keep the first and are counted", () => {
    const r = finalizeEntries([{ id: "a", displayName: "First" }, { id: "b" }, { id: "a", displayName: "Second" }]);
    assert.deepEqual(r.entries.map((e) => e.id), ["a", "b"]);
    assert.equal(r.duplicates, 1);
    assert.equal(r.entries[0]!.displayName, "First");
  });

  it("5000 entries pass, 5001 fail", () => {
    const mk = (n: number): RawEntry[] => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }));
    assert.equal(finalizeEntries(mk(5000)).entries.length, 5000);
    assert.throws(() => finalizeEntries(mk(5001)), (e: unknown) => e instanceof ScanError && e.result === "failed:invalid" && e.reason === "too_many_entries");
  });
});
