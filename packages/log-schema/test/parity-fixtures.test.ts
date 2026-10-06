import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildVectors } from "../src/gen-fixtures.mjs";
import { execFileSync } from "node:child_process";
import { REDACTION, validateAuditLine, validateLine } from "../src/index.ts";

const committed = JSON.parse(readFileSync(new URL("../fixtures/vectors.json", import.meta.url), "utf8"));

test("fixtures/vectors.json is what the generator produces now (the Rust parity test reads the committed file)", () => {
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildVectors())), "run `pnpm gen` and commit packages/log-schema/fixtures/vectors.json");
});

// `pnpm test` regenerates the fixtures first (like every schema package), so the comparison above cannot go stale by
// itself. Under CI the regenerated file must also equal the committed one, which is what a forgotten commit looks like.
test("under CI the regenerated vectors file has no diff against the checkout", { skip: !process.env.CI }, () => {
  const file = new URL("../fixtures/vectors.json", import.meta.url).pathname;
  try { execFileSync("git", ["diff", "--exit-code", "--stat", "--", file], { stdio: "pipe" }); } catch (e) {
    assert.fail(`packages/log-schema/fixtures/vectors.json is stale: run \`pnpm gen\` and commit it\n${(e as { stdout?: Buffer }).stdout?.toString() ?? ""}`);
  }
});

test("every vector gives its expected verdict in TypeScript", () => {
  assert.ok(committed.vectors.length > 100);
  for (const v of committed.vectors as Array<{ name: string; validator: string; line: string; expect: string }>) {
    const r = (v.validator === "audit" ? validateAuditLine : validateLine)(v.line);
    assert.equal(r.ok ? "ok" : r.code, v.expect, v.name);
  }
  const codes = new Set((committed.vectors as Array<{ expect: string }>).map((v) => v.expect));
  for (const code of ["ok", "not_object", "invalid_level", "unknown_event", "wrong_stream", "msg_too_long", "attrs_too_large", "schema", "key_order", "level_not_allowed", "source_kind_not_allowed", "stream_mismatch", "attrs_invalid"]) assert.ok(codes.has(code), `a vector exercises ${code}`);
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
    assert.equal(m[0], (c.matches as string[]).join(""), c.pattern);
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

test("the key-name rule redacts credential names and leaves token counts alone", () => {
  const rule = REDACTION.rules.find((r: any) => r.id === "key");
  const snake = new RegExp(rule.pattern, rule.flags);
  const camel = new RegExp(rule.camelPattern);
  const hit = (name: string) => snake.test(name) || camel.test(name);
  for (const name of committed.keyNames.redact) assert.ok(hit(name), `${name} is redacted`);
  for (const name of committed.keyNames.keep) assert.ok(!hit(name), `${name} is not redacted`);
});
