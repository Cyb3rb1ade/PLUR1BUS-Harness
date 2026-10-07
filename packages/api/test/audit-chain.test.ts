import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createBufferedSink } from "../src/audit-queue.ts";
import { createAuditChain } from "../src/rbac-bridge.ts";
import { addUser, FIXTURE_PASSWORD, jsonHeaders, loginAs, raw, start, write } from "./helpers.ts";

const wide = { auth: { capacity: 1000, refillPerSec: 100 }, read: { capacity: 1000, refillPerSec: 100 }, write: { capacity: 1000, refillPerSec: 100 }, totp: { capacity: 1000, refillPerSec: 100 }, stream: { capacity: 1000, refillPerSec: 100 } };
const tmp = () => mkdtempSync(path.join(tmpdir(), "plur1bus-chain-"));
const errors: string[] = [];
const log = { error: (m: string) => { errors.push(m); } };

test("the API's auth events land in the core's hash chain and the chain verifies; no secret is in the file", async () => {
  const dir = tmp();
  const chain = createAuditChain({ dir, lockTimeoutMs: 250 }); const buffered = createBufferedSink(chain, { log });
  const h = await start({ rateClasses: wide, auditSink: buffered, breakGlassAudit: chain });
  try {
    await addUser(h, { id: "u-mia", username: "mia", role: "member" });
    await addUser(h, { id: "u-adam", username: "adam", role: "admin" });
    await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username: "mia", password: "wrong-fixture-pw" }) });
    const { cookie } = await loginAs(h, "mia");
    const made = await write(h, cookie, { path: "/api/v1/tokens", body: { name: "t", scopes: ["agent.*"] } });
    await write(h, cookie, { method: "DELETE", path: "/api/v1/session" });
    const adam = await loginAs(h, "adam");
    await write(h, adam.cookie, { path: "/api/v1/breakglass", body: { targetUserId: "u-mia", reason: "Ticket 1: support recovery for the user" } });
    await buffered.flush();
    const v = chain.verify();
    assert.equal(v.ok, true, JSON.stringify(v.findings)); assert.ok(v.records >= 6, `records ${v.records}`);
    const text = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
    for (const action of ["auth.login.failure", "auth.login.success", "auth.token.created", "auth.logout", "break-glass.granted"]) assert.ok(text.includes(`"action":"${action}"`), action);
    for (const secret of ["wrong-fixture-pw", FIXTURE_PASSWORD, made.json.token.slice(17)]) assert.ok(!text.includes(secret), "no secret in the chain");
    assert.deepEqual(errors, []);
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a tampered chain refuses new lines: auth events are dropped and logged, requests still answer, break-glass fails closed (503, no grant)", async () => {
  const dir = tmp(); errors.length = 0;
  const chain = createAuditChain({ dir, lockTimeoutMs: 250 }); const buffered = createBufferedSink(chain, { log, retryMs: 1, maxAttempts: 2 });
  const h = await start({ rateClasses: wide, auditSink: buffered, breakGlassAudit: chain });
  try {
    await addUser(h, { id: "u-mia", username: "mia", role: "member" }); await addUser(h, { id: "u-adam", username: "adam", role: "admin" });
    await loginAs(h, "mia"); await buffered.flush();
    assert.equal(chain.verify().ok, true);
    const active = path.join(dir, readdirSync(dir).find((f) => f === "audit-chain.jsonl")!);
    writeFileSync(active, readFileSync(active, "utf8").replace("auth.login.success", "auth.login.XXXXXXX"));
    const r = await loginAs(h, "mia");
    assert.equal(r.res.status, 200, "login does not depend on the audit being writable");
    await buffered.flush();
    assert.ok(buffered.dropped >= 1 && errors.some((e) => e.includes("audit event dropped")));
    assert.equal(chain.verify().ok, false);
    const adam = await loginAs(h, "adam");
    const g = await write(h, adam.cookie, { path: "/api/v1/breakglass", body: { targetUserId: "u-mia", reason: "Ticket 2: needs the chain to be intact" } });
    assert.deepEqual([g.status, g.json.reason], [503, "audit-unavailable"]);
    appendFileSync(active, "");
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); }
});
