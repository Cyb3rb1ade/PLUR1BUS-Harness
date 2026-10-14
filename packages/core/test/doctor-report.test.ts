import { it } from "node:test";
import assert from "node:assert/strict";
import { buildDoctorMethods } from "../src/doctor-report.ts";
import { guardMethods } from "../src/rbac/guard.ts";
import type { Principal } from "../src/rbac/types.ts";
it("projects authoritative checks, removes private paths, shares refresh and rate limits", async () => {
  let now = 1000; let runs = 0;
  const methods = buildDoctorMethods({ home: "/private/home/example", clock: () => now, check: async () => { runs++; return { schema: "1staid.check/1", checks: [{ id: "models.cache", status: "ok", summary: "models in /private/home/example/models", detail: "must not escape", hint: "plur1bus setup" }] }; } });
  let principal: Principal = { kind: "person", role: "viewer", userId: "person-alice" };
  const guarded = guardMethods(methods, { resolve: () => principal, now: () => now });
  const ctx = { requestId: "request", connectionId: "connection", signal: new AbortController().signal };
  const first = await guarded["doctor.report"]!({}, ctx);
  assert.equal(runs, 1);
  assert.equal(JSON.stringify(first).includes("/private/home/example"), false);
  assert.equal(JSON.stringify(first).includes("must not escape"), false);
  await assert.rejects(guarded["doctor.report"]!({ refresh: true }, ctx), (e:any) => e.error === "E_DENIED");
  principal = { ...principal, role: "operator" };
  await assert.rejects(guarded["doctor.report"]!({ refresh: true }, ctx), (e:any) => e.error === "E_CONFLICT");
  now += 30000;
  await guarded["doctor.report"]!({ refresh: true }, ctx);
  assert.equal(runs, 2);
});

it("can defer the internal snapshot until the Core is ready", async () => {
  let runs = 0; let initial: (() => Promise<unknown>) | undefined;
  buildDoctorMethods({ home: "/fixture", clock: () => 1000, check: async () => { runs++; return { schema: "1staid.check/1", checks: [] }; }, scheduleInitial: start => { initial = start; } });
  assert.equal(runs, 0);
  assert.ok(initial);
  await initial();
  assert.equal(runs, 1);
});

it("redacts complete diagnostic text before clipping the display", async () => {
  const family = ["s", "k", "-"].join("");
  const text = " ".repeat(4088) + family + "fixture".repeat(20);
  const methods = guardMethods(buildDoctorMethods({ home: "/private/home/example", clock: () => 1000, check: async () => ({ schema: "1staid.check/1", checks: [{ id: "models.cache", status: "warn", summary: text }] }) }), { resolve: () => ({ kind: "person", role: "viewer", userId: "person-alice" }), now: () => 1000 });
  const report = await methods["doctor.report"]!({}, { requestId: "request", connectionId: "connection", signal: new AbortController().signal });
  assert.equal(JSON.stringify(report).includes(family), false);
});

it("a read-only scoped operator token cannot request a fresh check", async () => {
  let now = 1000;
  const methods = guardMethods(buildDoctorMethods({ home: "/fixture", clock: () => now, check: async () => ({ schema: "1staid.check/1", checks: [] }) }), { resolve: () => ({ kind: "person", role: "operator", userId: "person-alice", tokenScopes: ["agent.list"] }), now: () => now });
  const ctx = { requestId: "request", connectionId: "connection", signal: new AbortController().signal };
  await methods["doctor.report"]!({}, ctx);
  now += 30000;
  await assert.rejects(methods["doctor.report"]!({ refresh: true }, ctx), (e:any) => e.error === "E_DENIED");
});

const ctxOf = () => ({ requestId: "request", connectionId: "connection", signal: new AbortController().signal });
const viewer = (now: () => number) => ({ resolve: () => ({ kind: "person", role: "viewer", userId: "person-alice" }) as Principal, now });
const reportOf = (home: string, summary: string, hint?: string) => guardMethods(buildDoctorMethods({ home, clock: () => 1000, check: async () => ({ schema: "1staid.check/1", checks: [{ id: "models.cache", status: "warn", summary, ...(hint ? { hint } : {}) }] }) }), viewer(() => 1000))["doctor.report"]!({}, ctxOf());

it("an empty or root home does not shred the summary", async () => {
  for (const home of ["", "/"]) {
    const report = await reportOf(home, "cache /var/lib/x is stale") as any;
    assert.equal(report.groups[0].checks[0].summary, "cache /var/lib/x is stale", `home ${JSON.stringify(home)}`);
  }
});

it("masks other persons' home directories and e-mail addresses, in summaries and hints", async () => {
  const report = JSON.stringify(await reportOf("/srv/plur1bus", "cannot open /home/bob/notes.txt and C:\\Users\\Carol\\x.db and /Users/anna/Library/foo", "mail anna@example.org about /home/dave/.cache"));
  for (const leak of ["bob", "Carol", "anna", "dave"]) assert.equal(report.includes(leak), false, leak);
});

it("a check that throws a non-RpcError surfaces as E_NOT_AVAILABLE without its message", async () => {
  const methods = guardMethods(buildDoctorMethods({ home: "/fixture", clock: () => 1000, check: async () => { throw new Error("spawn /home/bob/bin/plur1bus failed"); }, scheduleInitial: () => {} }), viewer(() => 1000));
  await assert.rejects(methods["doctor.report"]!({}, ctxOf()), (e: any) => e.error === "E_NOT_AVAILABLE" && !JSON.stringify(e).includes("bob"));
});

it("a failed startup snapshot is retried by a later read once the rate-limit window has passed", async () => {
  let now = 1000; let runs = 0;
  let initial: (() => Promise<unknown>) | undefined;
  const methods = guardMethods(buildDoctorMethods({ home: "/fixture", clock: () => now, scheduleInitial: s => { initial = s; }, check: async () => { runs++; if (runs === 1) throw new Error("not yet"); return { schema: "1staid.check/1", checks: [] }; } }), viewer(() => now));
  await initial!().catch(() => {});
  await assert.rejects(methods["doctor.report"]!({}, ctxOf()), (e: any) => e.error === "E_NOT_AVAILABLE");
  assert.equal(runs, 1, "no retry inside the rate-limit window");
  now += 30000;
  const report = await methods["doctor.report"]!({}, ctxOf()) as any;
  assert.equal(runs, 2);
  assert.equal(report.groups[0].id, "provisioning");
});
