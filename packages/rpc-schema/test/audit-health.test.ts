import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateResult } from "../src/index.ts";

const health = {
  state: "refusing", reason: "anchor-invalid", lastSeq: 7, observedAt: 200, lastVerifiedAt: 100,
  pendingLines: 1, pendingDropped: 2,
  pending: [{ at: 42, actor: { user: "owner", host: "host" }, action: "audit_config_set", reason: "anchor-invalid" }],
  lastAnchorAdvanced: null, lastReanchor: { at: 90, actor: { user: "owner", host: "host" } },
};
for (const method of ["core.status", "daemon.status"]) {
  test(`${method}: additive audit health is closed and metadata-only without changing the public status`, () => {
    const base = JSON.parse(readFileSync(new URL(`../fixtures/methods/${method}.json`, import.meta.url), "utf8")).result;
    assert.equal(validateResult(method, base).ok, true);
    assert.equal(validateResult(method, { ...base, audit: health }).ok, true);
    assert.equal(validateResult(method, { ...base, audit: { ...health, detail: "private" } }).ok, false);
    assert.equal(validateResult(method, { ...base, audit: { ...health, pending: [{ ...health.pending[0], detail: {} }] } }).ok, false);
    assert.equal(validateResult(method, { ...base, audit: { ...health, lastSeq: -1 } }).ok, false);
    assert.equal(validateResult(method, { ...base, audit: { ...health, state: "healthy" } }).ok, false);
  });
}

for (const method of ["core.status", "daemon.status"]) {
  test(`${method}: audit health pending is a bounded sample of at most 50 rows while pendingLines is the total`, () => {
    const base = JSON.parse(readFileSync(new URL(`../fixtures/methods/${method}.json`, import.meta.url), "utf8")).result;
    const rows = (n: number) => Array.from({ length: n }, () => health.pending[0]);
    assert.equal(validateResult(method, { ...base, audit: { ...health, pendingLines: 10_000, pending: rows(50) } }).ok, true);
    assert.equal(validateResult(method, { ...base, audit: { ...health, pendingLines: 10_000, pending: rows(51) } }).ok, false);
  });
}
