// `permission-eval-e2e` (D109 §11.5, stateful half): every scenario is an attack plus, where it makes sense, its harmless twin, run
// against the REAL grant/approval stores (SQLite in a temp dir), the real ApprovalService, the real ToolDispatcher and the real
// path canonicaliser, on a fake clock with fake timers. The attack must not achieve its goal (zero escapes, named on failure);
// the twin must (no over-blocking). The pure evaluator half lives in permission-eval.test.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GROUPS, makeWorld, type E2ERow, type Verdict } from "./permission-eval-e2e.fixtures.ts";
import { LIFECYCLE_ROWS, ROOT_ROWS } from "./permission-eval-e2e.rows-roots.ts";

export const ROWS: E2ERow[] = [...ROOT_ROWS, ...LIFECYCLE_ROWS];

/** The bar for the finished suite is 40 (task D10); each commit raises the floor to what it delivers. */
const MIN_SCENARIOS = 20;
const TIMEOUT = 20_000;
const attacks = new Map<string, Verdict>();
const benigns = new Map<string, Verdict>();

async function run(row: E2ERow, which: "attack" | "benign"): Promise<Verdict> {
  const w = await makeWorld(row.world);
  try { return await row[which]!(w); } finally { w.close(); }
}
const matches = (code: string, expect: string | RegExp): boolean => (typeof expect === "string" ? code === expect : expect.test(code));

describe("permission-eval-e2e", () => {
  it("has the minimum number of scenarios with unique ids, each in a known group", { timeout: TIMEOUT }, () => {
    assert.ok(ROWS.length >= MIN_SCENARIOS, `only ${ROWS.length} scenarios`);
    assert.equal(new Set(ROWS.map((r) => r.id)).size, ROWS.length, "duplicate scenario id");
    for (const r of ROWS) assert.ok((GROUPS as readonly string[]).includes(r.group), `${r.id}: unknown group ${r.group}`);
  });

  for (const group of GROUPS) {
    const rows = ROWS.filter((r) => r.group === group);
    if (rows.length === 0) continue;
    describe(`${group} (${rows.length})`, () => {
      for (const row of rows) {
        const skip = row.skip ?? false;
        it(`attack: ${row.id} — ${row.what}`, { timeout: TIMEOUT, skip }, async () => {
          const v = await run(row, "attack");
          attacks.set(row.id, v);
          assert.equal(v.done, false, `ESCAPE ${row.id}: the attack succeeded (${v.code})`);
          assert.ok(matches(v.code, row.expect), `${row.id}: expected ${String(row.expect)}, got ${v.code}`);
        });
        if (row.benign) {
          it(`benign: ${row.id}`, { timeout: TIMEOUT, skip }, async () => {
            const v = await run(row, "benign");
            benigns.set(row.id, v);
            assert.equal(v.done, true, `${row.id}: the harmless twin was blocked (${v.code})`);
          });
        }
      }
    });
  }

  it("zero escapes: no attack row achieved its goal", { timeout: TIMEOUT }, () => {
    const escapes = [...attacks].filter(([, v]) => v.done).map(([id]) => id);
    assert.deepEqual(escapes, []);
    const ran = ROWS.filter((r) => !r.skip).length;
    assert.equal(attacks.size, ran, `only ${attacks.size} of ${ran} attack rows reported a verdict`);
    assert.ok(ran >= MIN_SCENARIOS, `only ${ran} scenarios ran`);
  });

  it("at least 95 % of the harmless twins went through", { timeout: TIMEOUT }, () => {
    const blocked = [...benigns].filter(([, v]) => !v.done).map(([id]) => id);
    const rate = (benigns.size - blocked.length) / Math.max(1, benigns.size);
    assert.ok(rate >= 0.95, `over-blocked (${(rate * 100).toFixed(1)} %): ${blocked.join(", ")}`);
    assert.deepEqual(blocked, []);
  });
});
