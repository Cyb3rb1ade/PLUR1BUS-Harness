import { it } from "node:test";
import assert from "node:assert/strict";
import { buildDoctorMethods } from "../src/doctor-report.ts";
import { guardMethods } from "../src/rbac/guard.ts";
import type { Principal } from "../src/rbac/types.ts";
import { createMetrics } from "../src/metrics/metrics.ts";
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

it("shows a live numeric tool-use summary and p50/p95 without refreshing provisioning", async () => {
  const metrics = createMetrics({ connections: () => 0 });
  let runs = 0;
  const methods = guardMethods(buildDoctorMethods({
    home: "/fixture", clock: () => 1000,
    check: async () => { runs++; return { schema: "1staid.check/1", checks: [] }; },
    turnTelemetry: () => metrics.turnTelemetrySummary(),
  }), viewer(() => 1000));
  await methods["doctor.report"]!({}, ctxOf());
  metrics.turnTelemetry({
    rounds: 2, toolCalls: 0, metaCalls: { search: 1, skillLoad: 1, skillRead: 0 },
    skills: { injected: 1, loaded: 1 }, toolChoice: { status: "unsupported", forced: false },
    toolNeed: { detected: true, reasons: ["path"] }, errorsReturned: 1,
    endReason: "completed", triageDurationMs: 40,
  });
  const report = await methods["doctor.report"]!({}, ctxOf()) as {
    groups: { checks: { id: string; status: string; summary: string }[] }[];
  };
  const check = report.groups.flatMap(group => group.checks).find(c => c.id === "tools.turn-usage")!;
  assert.equal(runs, 1);
  assert.equal(check.status, "warn");
  assert.match(check.summary, /1 turns.*2 rounds.*0 tool calls/);
  assert.match(check.summary, /1 loaded.*1 errors returned/);
  assert.match(check.summary, /p50 40 ms.*p95 40 ms/);
  assert.match(check.summary, /1 needed tools unused.*1 unsupported/);
  assert.match(check.summary, /1 need detected/);
  assert.match(check.summary, /ends completed=1/);
});

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
it("reports the absent skill-artifact queue without claiming that mining is enabled", async () => {
  const methods = guardMethods(buildDoctorMethods({ home: "/fixture", clock: () => 1000, check: async () => ({ schema: "1staid.check/1", checks: [] }), miningStatus: () => ({ available: false }) }), viewer(() => 1000));
  const report = await methods["doctor.report"]!({}, ctxOf()) as { groups: { checks: { id: string; status: string; summary: string }[] }[] };
  const check = report.groups[0]!.checks.find(c => c.id === "skills.mining"); assert.equal(check?.status, "skipped"); assert.match(check!.summary, /no skill-artifact proposal API/);
});

it("lists composition problems (a refused turn provider) as failing checks next to the provisioning checks", async () => {
  const methods = guardMethods(buildDoctorMethods({ home: "/fixture", clock: () => 1000, check: async () => ({ schema: "1staid.check/1", checks: [{ id: "models.cache", status: "ok", summary: "fine" }] }),
    compositionChecks: () => [{ id: "providers.broken", status: "fail", summary: "provider broken refused (E_CONFIG_INVALID): billing path \"enterprise\" is not one of plan" }] }), { resolve: () => ({ kind: "person", role: "viewer", userId: "person-alice" }), now: () => 1000 });
  const report = await methods["doctor.report"]!({}, ctxOf()) as { groups: { checks: { id: string; status: string; summary: string }[] }[] };
  const checks = report.groups.flatMap(g => g.checks);
  assert.deepEqual(checks.filter(c => c.id === "providers.broken").map(c => c.status), ["fail"]);
  assert.ok(checks.some(c => c.id === "models.cache"), "the provisioning checks stay");
});


it("privacy overlays the cached provisioning report immediately without another expensive check", async () => {
 let active=false,runs=0;
 const methods=guardMethods(buildDoctorMethods({home:"/fixture",clock:()=>1000,
  check:async()=>{runs++;return {schema:"1staid.check/1",checks:[{id:"privacy.local-only",status:"ok",summary:"cached off"}]};},
  coreChecks:()=>[{id:"privacy.local-only",status:active?"fail":"ok",summary:active?"active cloud refusal":"off"}]}),viewer(()=>1000));
 const first=await methods["doctor.report"]!({},ctxOf()) as any;
 assert.equal(first.groups[0].checks.find((c:any)=>c.id==="privacy.local-only").summary,"off");
 active=true;
 const second=await methods["doctor.report"]!({},ctxOf()) as any;
 const rows=second.groups[0].checks.filter((c:any)=>c.id==="privacy.local-only");
 assert.equal(runs,1);assert.equal(rows.length,1);assert.equal(rows[0].status,"fail");
});

const sandboxCases = [
  { name: 'unavailable sandbox skips the process cap', available: false, mechanism: 'none', n: 512, status: 'skipped',
    summary: 'Process cap not checked: the sandbox is unavailable.' },
  { name: 'Seatbelt reports fork denial even when the configured cap is off', available: true, mechanism: 'fork-denied', n: 0, status: 'ok',
    summary: 'Forks are denied in the tool sandbox (Seatbelt), whatever tools.sandbox.maxTasks says. The coding-gate verifier is not capped on macOS: process limits there count every process of the user.' },
  { name: 'namespace accounting reports the configured task cap', available: true, mechanism: 'namespace-limit', n: 7, status: 'ok',
    summary: "At most 7 tasks per sandboxed run (tool sandbox and Linux coding-gate verifier), counted in the run's own user namespace." },
  { name: 'a disabled Linux process cap warns', available: true, mechanism: 'namespace-limit', n: 0, status: 'warn',
    summary: 'Process cap off: the owner set tools.sandbox.maxTasks to 0.' },
  { name: 'an unenforceable process cap reports the reason and hint', available: true, mechanism: 'none', n: 512, status: 'warn',
    summary: 'No process cap: fixture reason', hint: 'Run PLUR1BUS as a normal user.' },
] as const;
for (const row of sandboxCases) it(row.name, async () => {
  const hint = 'hint' in row ? row.hint : undefined;
  const methods = guardMethods(buildDoctorMethods({ home: '/fixture', clock: () => 1000,
    check: async () => ({ schema: '1staid.check/1', checks: [] }), sandboxMaxTasks: () => row.n,
    detectSandbox: async () => ({ available: row.available, backend: 'bubblewrap', strength: 'partial', reason: 'fixture',
      tasks: { mechanism: row.mechanism, reason: 'fixture reason', ...(hint ? { hint } : {}) } }) }), viewer(() => 1000));
  const report = await methods['doctor.report']!({}, ctxOf()) as { groups: { checks: { id: string; status: string; summary: string; repair?: { label: string } }[] }[] };
  const checks = report.groups.flatMap(g => g.checks), index = checks.findIndex(c => c.id === 'tools.sandbox.tasks');
  const check = checks[index]; assert.ok(check);
  assert.equal(checks[index - 1]!.id, 'tools.sandbox');
  assert.equal(check.status, row.status); assert.equal(check.summary, row.summary);
  if (hint) assert.equal(check.repair?.label, hint);
});
