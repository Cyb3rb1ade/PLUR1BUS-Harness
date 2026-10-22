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

  it("reapplies permissions when another writer rotated the active inode", () => {
    const dir = tempDir("audit-chain-external-rotation-"); const seen: string[] = [];
    const first = createAuditChain({ dir, securePath: p => seen.push(path.basename(p)) });
    first.append(ev(0));
    createAuditChain({ dir }).rotate();
    first.append(ev(1));
    assert.equal(seen.filter(n => n === ACTIVE_NAME).length, 2);
    assert.equal(first.verify().ok, true);
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

  it("secrets inside `detail` are redacted before the line is written (same D111 redactor as the logs); the rest is recorded as given", () => {
    const dir = tempDir("audit-chain-hard-"); const c = createAuditChain({ dir });
    const bot = ["AAHd", "qTcvCH1vGWJxfSeofSAs0K5PALDsaw"].join(""); const gho = ["gh", "o_", "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8"].join("");
    const pass = ["hunter", "2-but-longer"].join(""); const hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const pem = ["-----BEGIN ", "PRIVATE KEY-----\nMIIBVQIBADANBgkq\n-----END ", "PRIVATE KEY-----"].join("");
    c.append({ ...ev(0), detail: {
      password: pass, name: "svc-a", count: 3, ok: true, sha256: hex, none: null,
      note: `GET https://api.telegram.org/bot123456789:${bot}/getMe failed`, nested: { list: [`token ${gho}`, "plain", { apiKey: "k-1234567890" }] }, key: pem,
    } });
    const raw = readFileSync(path.join(dir, ACTIVE_NAME), "utf8");
    for (const secret of [pass, bot, gho, "MIIBVQIBADANBgkq", "k-1234567890"]) assert.ok(!raw.includes(secret), secret);
    const rec = JSON.parse(raw).rec;
    assert.deepEqual(Object.keys(rec), ["at", "actor", "action", "target", "detail"]);
    assert.equal(rec.detail.password, "[REDACTED:key]");
    assert.deepEqual([rec.detail.name, rec.detail.count, rec.detail.ok, rec.detail.sha256, rec.detail.none], ["svc-a", 3, true, hex, null]);
    assert.match(rec.detail.note, /^GET https:\/\/api\.telegram\.org\/bot123456789:\[REDACTED:url\]\/getMe failed$/);
    assert.deepEqual(rec.detail.nested.list.slice(1, 2), ["plain"]);
    assert.equal(rec.detail.nested.list[2].apiKey, "[REDACTED:key]");
    assert.equal(c.verify().ok, true, "the chain hashes what was written, so a redacted line verifies");
  });

  it("a `detail` value that only serialises to a secret (toJSON, Date) is redacted in its written form", () => {
    const dir = tempDir("audit-chain-hard-"); const c = createAuditChain({ dir });
    const gho = ["gh", "s_", "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8"].join("");
    c.append({ ...ev(0), detail: { viaToJson: { toJSON: () => `token ${gho}` }, when: new Date(Date.UTC(2026, 9, 20)) } });
    const raw = readFileSync(path.join(dir, ACTIVE_NAME), "utf8");
    assert.ok(!raw.includes(gho));
    assert.equal(JSON.parse(raw).rec.detail.when, "2026-10-20T00:00:00.000Z");
  });

  it("an event with nothing to redact is written byte for byte as before the redactor (key order and values)", () => {
    const dir = tempDir("audit-chain-hard-"); const c = createAuditChain({ dir });
    const e = { at: 5, actor: { user: "u", host: "h" }, action: "ext.install", target: "pkg", detail: { sha256: "a".repeat(64), version: "1.2.3", scopes: ["read", "write"], nested: { n: 1 } } };
    c.append(e);
    const line = readFileSync(path.join(dir, ACTIVE_NAME), "utf8").trim();
    assert.deepEqual(JSON.parse(line).rec, e);
    assert.ok(line.includes(JSON.stringify(e.detail)));
  });
});
