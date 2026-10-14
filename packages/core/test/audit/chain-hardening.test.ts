import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createAuditChain, ACTIVE_NAME } from "../../src/audit/chain.ts";
import type { AuditEvent } from "../../src/rbac/audit.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const ev = (i: number): AuditEvent => ({ at: 1000 + i, actor: { user: "u", host: "h" }, action: "test.event", target: `t${i}`, detail: { i } });

describe("audit chain hardening (c02)", () => {
  it("securePath runs again for the new active file after a rotation (a new inode needs its ACL)", () => {
    const dir = tempDir("audit-chain-hard-"); const seen: string[] = [];
    const c = createAuditChain({ dir, securePath: (p) => seen.push(path.basename(p)) });
    c.append(ev(0)); c.rotate(); c.append(ev(1));
    assert.equal(seen.filter((n) => n === ACTIVE_NAME).length, 2);
    assert.equal(c.verify().ok, true);
  });

  it("two torn tails set aside in the same millisecond are both kept as evidence", () => {
    const dir = tempDir("audit-chain-hard-"); const c = createAuditChain({ dir });
    const active = path.join(dir, ACTIVE_NAME);
    c.append(ev(0));
    mock.method(Date, "now", () => 1_700_000_000_000);
    try {
      writeFileSync(active, readFileSync(active, "utf8") + "first-fragment");
      c.append(ev(1));
      writeFileSync(active, readFileSync(active, "utf8") + "second-fragment");
      c.append(ev(2));
    } finally { mock.restoreAll(); }
    const torn = readdirSync(dir).filter((n) => n.includes(".torn-")).map((n) => readFileSync(path.join(dir, n), "utf8")).sort();
    assert.deepEqual(torn, ["first-fragment", "second-fragment"]);
  });

  it("refuses an event whose timestamp or shape cannot be recorded faithfully (no null `at`, no dropped keys)", () => {
    const dir = tempDir("audit-chain-hard-"); const c = createAuditChain({ dir });
    const bad: unknown[] = [
      { ...ev(0), at: Number.NaN }, { ...ev(0), at: Infinity }, { ...ev(0), at: "2026-10-14T10:00:00+02:00" },
      { ...ev(0), detail: undefined }, { ...ev(0), actor: { user: "u" } }, { ...ev(0), action: undefined },
    ];
    for (const e of bad) assert.throws(() => c.append(e as AuditEvent), /audit-chain: invalid event/);
    const v = c.verify();
    assert.deepEqual([v.ok, v.records], [true, 0]);
    c.append(ev(1)); assert.equal(c.verify().records, 1);
  });

  it("KNOWN GAP: secrets inside `detail` are written as given (redaction belongs to the event producers in rbac/identity)", { todo: true }, () => {
    assert.fail("the chain wraps the unchanged D111 record; no redactor runs in append()");
  });
});
