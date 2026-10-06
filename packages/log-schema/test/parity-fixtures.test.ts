import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildVectors } from "../src/gen-fixtures.mjs";
import { REDACTION, validateLine } from "../src/index.ts";

const committed = JSON.parse(readFileSync(new URL("../fixtures/vectors.json", import.meta.url), "utf8"));

test("fixtures/vectors.json is what the generator produces now (the Rust parity test reads the committed file)", () => {
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildVectors())), "run `pnpm gen` and commit packages/log-schema/fixtures/vectors.json");
});

test("every vector gives its expected verdict in TypeScript", () => {
  assert.ok(committed.vectors.length > 100);
  for (const v of committed.vectors as Array<{ name: string; line: string; expect: string }>) {
    const r = validateLine(v.line);
    assert.equal(r.ok ? "ok" : r.code, v.expect, v.name);
  }
  const codes = new Set((committed.vectors as Array<{ expect: string }>).map((v) => v.expect));
  for (const code of ["ok", "not_object", "invalid_level", "unknown_event", "msg_too_long", "attrs_too_large", "schema", "key_order", "level_not_allowed", "source_kind_not_allowed", "stream_mismatch", "attrs_invalid"]) assert.ok(codes.has(code), `a vector exercises ${code}`);
});

// The redaction data is data only; this checks that each pattern compiles in ECMAScript and does what its entry says.
// (The Rust test runs the same canaries through the `regex` crate.)
const patterns = new Map<string, any>();
for (const rule of REDACTION.rules) for (const p of rule.patterns ?? []) patterns.set(p.id, p);

test("redaction patterns compile and match their canaries (joined at run time, never committed whole)", () => {
  for (const c of committed.redactionCanaries) {
    const p = patterns.get(c.pattern);
    assert.ok(p, `pattern ${c.pattern} exists`);
    const text = (c.parts as string[]).join("");
    const m = new RegExp(p.pattern, `${p.flags ?? ""}`).exec(text);
    assert.ok(m, `${c.pattern} matches its canary`);
    assert.equal(m[0], c.matches, c.pattern);
    if (p.leftBoundary && m.index > 0) assert.ok(!/[A-Za-z0-9]/.test(text[m.index - 1]!), `${c.pattern}: left boundary`);
  }
  for (const n of committed.redactionNonMatches) {
    const p = patterns.get(n.pattern);
    const m = new RegExp(p.pattern, p.flags ?? "").exec(n.text);
    const exempt = m && p.exemptWhenWholeMatchIs && new RegExp(p.exemptWhenWholeMatchIs).test(m[0]);
    const boundaryFails = m && p.leftBoundary && m.index > 0 && /[A-Za-z0-9]/.test(n.text[m.index - 1]!);
    assert.ok(!m || exempt || boundaryFails, `${n.pattern} must not count on ${JSON.stringify(n.note)}`);
  }
});
