// Parity vectors (mode V) for the inbox (P4-K K3b, plan P4-22): the store (publish with its dedupe key, the rolling cooldown,
// retention before and after a publish, paging by cursor, counts, read, dismiss, settle), the service that fans a notice out to
// people and tells listeners, and the producers that turn what the other modules announce into notices (with the `param`
// masking of token-shaped words). The real `InboxStore`, `createInboxService` and the producers run over a temporary
// `inbox.sqlite` with a scripted clock and scripted ids; `crates/plur1bus-core/src/inbox/vectors.rs` replays every case and
// must give the same answers, the same rows, the same schema text, the same events and the same log lines. Recorded, never
// edited by hand.
//
// A scenario is `{ name, world, ops }`; the answer to each op is `{ ok }` or `{ err: { name, code?, message } }`. In a `list`
// query, the cursor `"$last"` stands for the `nextCursor` of the last page that had one.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-inbox.ts [--check]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";
import { dumpTables, schemaOf } from "./k3b-support.ts";
import { InboxStore } from "../../packages/core/src/inbox/store.ts";
import { createInboxService } from "../../packages/core/src/inbox/service.ts";
import { breakglassDraft, migrateBreakglassNotices } from "../../packages/core/src/inbox/migrate.ts";
import * as P from "../../packages/core/src/inbox/producers.ts";

const TABLES = { inbox_entries: ["params", "ref"], inbox_cooldowns: [] as string[] };
const errOf = (e: any) => ({ name: String(e?.name ?? "Error"), ...(e?.code !== undefined ? { code: e.code } : {}), message: String(e?.message) });
const draft = (over: Record<string, unknown> = {}) => ({ userId: "u1", kind: "system", severity: "info", titleKey: "inbox.test", dedupeKey: "system:a", ...over });
const pub = (over: Record<string, unknown> = {}) => ({ op: "publish", draft: draft(over) });
const list = (q: Record<string, unknown> = {}, user = "u1") => ({ op: "list", user, q });
const KINDS = ["breakglass", "approval", "job-failed", "update", "media-index", "pairing", "channel", "system"];

function storeOf(path: string, w: any, clock: () => number, idGen: () => string) {
  return new InboxStore({ path, clock, idGen, ...(w.maxAgeMs !== undefined ? { maxAgeMs: w.maxAgeMs } : {}), ...(w.maxEntries !== undefined ? { maxEntries: w.maxEntries } : {}) });
}

function runStore(name: string, w0: any, ops: any[]) {
  const dir = mkdtempSync(join(tmpdir(), "p4k-inbox-"));
  const path = join(dir, "state", "inbox.sqlite");
  let now = w0.now ?? 1_000_000, n = 0, last: string | undefined;
  const ids: string[] = [];
  const idGen = () => { const id = `e${++n}`; ids.push(id); return id; };
  let s = storeOf(path, w0, () => now, idGen);
  const steps: unknown[] = [];
  try {
    for (const op of ops) {
      let out: unknown;
      try {
        const q = op.q ? { ...op.q, ...(op.q.cursor === "$last" ? { cursor: last } : {}) } : undefined;
        switch (op.op) {
          case "publish": out = { ok: s.publish(op.draft) }; break;
          case "publishRL": out = { ok: s.publishRateLimited(op.draft, op.cooldownMs) }; break;
          case "list": { const r = s.list(op.user, q); if (r.nextCursor !== undefined) last = r.nextCursor; out = { ok: r }; break; }
          case "count": out = { ok: s.count(op.user) }; break;
          case "kindsOf": out = { ok: s.kindsOf(op.user, op.ids, op.what) }; break;
          case "markRead": out = { ok: s.markRead(op.user, op.ids) }; break;
          case "dismiss": out = { ok: s.dismiss(op.user, op.ids) }; break;
          case "settle": out = { ok: s.settle(op.user, op.key) }; break;
          case "settleEverywhere": out = { ok: s.settleEverywhere(op.key) }; break;
          case "advance": now += op.ms; out = { ok: now }; break;
          case "reopen": s.close(); s = storeOf(path, w0, () => now, idGen); out = { ok: null }; break;
          case "construct": { const t = new InboxStore({ path: join(dir, "other", "inbox.sqlite"), clock: () => now, ...op.options }); out = { ok: t.retention }; t.close(); break; }
          case "migrate": out = { ok: migrateBreakglassNotices(s, op.notices) }; break;
          default: throw new Error(`unknown op ${op.op}`);
        }
      } catch (e) { out = { err: errOf(e) }; }
      steps.push({ op, out });
    }
    s.close();
    return { name, world: w0, ops: steps, final: { tables: dumpTables(path, TABLES), schema: schemaOf(path), ids } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const many = (count: number, f: (i: number) => Record<string, unknown>) => Array.from({ length: count }, (_, i) => pub(f(i)));

function storeScenarios() {
  const out: unknown[] = [];
  const bad = (over: Record<string, unknown>) => pub(over);
  out.push(runStore("validation", {}, [
    pub(), bad({ userId: "" }), bad({ userId: "u".repeat(128) }), bad({ userId: "u".repeat(129), dedupeKey: "k1" }), bad({ userId: "\u{1F600}".repeat(64), dedupeKey: "k2" }), bad({ userId: "\u{1F600}".repeat(65), dedupeKey: "k3" }),
    bad({ kind: "nope" }), bad({ kind: "" }), bad({ severity: "nope" }), bad({ severity: "Info" }),
    ...["", "A", "1a", "a".repeat(96), "a".repeat(97), "a b", "a$", "a\n", "a.b-c_D9", "éa", "aé"].map((t, i) => bad({ titleKey: t, dedupeKey: `tk${i}` })),
    bad({ dedupeKey: "" }), bad({ dedupeKey: "d".repeat(200) }), bad({ dedupeKey: "d".repeat(201) }), bad({ dedupeKey: "\u{1F600}".repeat(100) }), bad({ dedupeKey: "\u{1F600}".repeat(101) }),
    bad({ params: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, i])), dedupeKey: "p16" }), bad({ params: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])), dedupeKey: "p17" }),
    ...["1a", "a-b", " a", "a b", "a".repeat(32), "a".repeat(33), "A_9", "é"].map((k, i) => bad({ params: { [k]: 1 }, dedupeKey: `pk${i}` })),
    ...[1, -1, 0, 1.5, 1e21, 1e-7, 123456789012345680000, true, false, "", "s".repeat(200), "s".repeat(201), "\u{1F600}".repeat(100), "\u{1F600}".repeat(101), null, [1], { a: 1 }].map((v, i) => bad({ params: { v }, dedupeKey: `pv${i}` })),
    bad({ params: { a: 1, b: "two", c: true, d: 1.25 }, dedupeKey: "order" }), bad({ params: { z: 1, a: 2 }, dedupeKey: "order2" }),
    ...["x", "/", "/a", "/" + "r".repeat(199), "/" + "r".repeat(200), ""].map((r, i) => bad({ ref: { route: r }, dedupeKey: `rr${i}` })),
    ...["", "o", "o".repeat(128), "o".repeat(129)].map((o, i) => bad({ ref: { objectId: o }, dedupeKey: `ro${i}` })),
    bad({ ref: {}, dedupeKey: "ref-empty" }), bad({ ref: { objectId: "x", route: "/y" }, dedupeKey: "ref-order" }), bad({ ref: { route: "/y", objectId: "x" }, dedupeKey: "ref-order2" }),
    list({}), list({ includeDismissed: true }),
  ]));
  out.push(runStore("dedupe-and-people", {}, [
    pub(), pub(), pub({ userId: "u2" }), pub({ dedupeKey: "system:b" }), pub({ severity: "critical", titleKey: "inbox.other" }), list(), list({}, "u2"), list({}, "nobody"),
    { op: "markRead", user: "u1", ids: ["e1"] }, pub(), { op: "dismiss", user: "u1", ids: ["e1"] }, pub(), list({}), list({ includeDismissed: true }),
  ]));
  out.push(runStore("rate-limit-boundary", {}, [
    { op: "publishRL", draft: draft({ dedupeKey: "cause" }), cooldownMs: 1000 }, { op: "advance", ms: 999 }, { op: "publishRL", draft: draft({ dedupeKey: "cause" }), cooldownMs: 1000 },
    { op: "advance", ms: 1 }, { op: "publishRL", draft: draft({ dedupeKey: "cause" }), cooldownMs: 1000 }, { op: "publishRL", draft: draft({ dedupeKey: "other" }), cooldownMs: 1000 },
    { op: "publishRL", draft: draft({ userId: "u2", dedupeKey: "cause" }), cooldownMs: 1000 }, { op: "dismiss", user: "u1", ids: ["e3"] }, { op: "publishRL", draft: draft({ dedupeKey: "cause" }), cooldownMs: 1000 },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((c) => ({ op: "publishRL", draft: draft({ dedupeKey: "bad" }), cooldownMs: c })),
    { op: "publishRL", draft: draft({ userId: "" }), cooldownMs: 1000 }, { op: "publishRL", draft: draft({ dedupeKey: "cause" }), cooldownMs: Number.MAX_SAFE_INTEGER },
    { op: "advance", ms: 5000 }, { op: "publishRL", draft: draft({ dedupeKey: "cause" }), cooldownMs: 1 }, { op: "reopen" }, { op: "publishRL", draft: draft({ dedupeKey: "cause" }), cooldownMs: 100000 }, list({ includeDismissed: true }),
  ]));
  out.push(runStore("retention-by-age", { maxAgeMs: 1000 }, [
    pub(), { op: "advance", ms: 1000 }, pub({ dedupeKey: "system:b" }), list({}), { op: "advance", ms: 1 }, pub({ dedupeKey: "system:c" }), list({}),
    // An entry past its retention does not hide a repeat event behind its dedupe key.
    { op: "advance", ms: 1001 }, pub({ dedupeKey: "system:c" }), list({ includeDismissed: true }), { op: "count", user: "u1" },
  ]));
  out.push(runStore("retention-by-count", { maxEntries: 3 }, [
    ...many(5, (i) => ({ dedupeKey: `system:${i}` })), ...many(2, (i) => ({ userId: "u2", dedupeKey: `system:${i}` })), list({}), list({}, "u2"), { op: "dismiss", user: "u1", ids: ["e4"] }, pub({ dedupeKey: "system:9" }), list({ includeDismissed: true }),
    { op: "publishRL", draft: draft({ dedupeKey: "c1" }), cooldownMs: 10 }, { op: "publishRL", draft: draft({ dedupeKey: "c2" }), cooldownMs: 10 }, list({ includeDismissed: true }),
  ]));
  out.push(runStore("limits-are-checked", {}, [
    ...[{ maxAgeMs: 0 }, { maxAgeMs: -1 }, { maxAgeMs: 1.5 }, { maxEntries: 0 }, { maxEntries: -5 }, { maxEntries: 2.5 }, { maxAgeMs: 1, maxEntries: 1 }, {}].map((options) => ({ op: "construct", options })),
    { op: "construct", options: { maxAgeMs: Number.MAX_SAFE_INTEGER, maxEntries: 1000000 } },
  ]));
  const kinds = KINDS.flatMap((k, i) => [pub({ kind: k, dedupeKey: `${k}:1`, userId: "u1" }), pub({ kind: k, dedupeKey: `${k}:2`, userId: "u1" })]);
  out.push(runStore("list-filters-and-paging", {}, [
    ...kinds,
    list({}), list({ kinds: ["approval"] }), list({ kinds: ["approval", "system"] }), list({ kinds: [] }), list({ kinds: ["nope"] }), list({ limit: 3 }), list({ limit: 3, cursor: "$last" }), list({ limit: 3, cursor: "$last" }), list({ limit: 200 }), list({ limit: 201 }), list({ limit: 0 }), list({ limit: -1 }),
    { op: "markRead", user: "u1", ids: ["e1", "e2", "e3"] }, list({ unreadOnly: true, limit: 4 }), list({ limit: 2, unreadOnly: true }), list({ limit: 2, cursor: "$last", unreadOnly: true }),
    { op: "dismiss", user: "u1", ids: ["e5", "e6"] }, list({ limit: 100 }), list({ limit: 100, includeDismissed: true }), list({ kinds: ["pairing"], includeDismissed: true }),
    // Entries arriving between pages do not move the pages.
    list({ limit: 4 }), pub({ dedupeKey: "system:late" }), list({ limit: 4, cursor: "$last" }), list({ limit: 4, cursor: "$last" }),
  ]));
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  out.push(runStore("cursor-decoding", {}, [
    ...many(6, (i) => ({ dedupeKey: `system:${i}` })),
    ...[b64("4"), b64("4") + "=", b64("12"), b64("12") + "=", "MTI", "MTJ", "MT Iz", "MTIz\n", "M\tTI", b64("4").replace("NA", "N-A"), b64("0"), b64("007"), b64("999999999999999"), b64("1000000000000000"), b64("-1"), b64("4.5"), b64("4 "), b64(" 4"), b64("4x"), b64("٤"), b64("\n4"), "", "!", "NA", "N", "====", "NA==", "NA=", "N A", "NA ", "Mw", "Mw==", "Mw==Mw==", "Mw=A", "+/", "-_", "NA.", "NA!", "é", "NAA", "NAAA"].map((cursor) => list({ cursor, limit: 2 })),
  ]));
  out.push(runStore("count-read-dismiss-settle", {}, [
    ...kinds, { op: "count", user: "u1" }, { op: "count", user: "nobody" },
    { op: "markRead", user: "u1", ids: ["e1", "e1", "e2"] }, { op: "advance", ms: 10 }, { op: "markRead", user: "u1", ids: ["e1"] }, { op: "markRead", user: "u2", ids: ["e3"] }, { op: "count", user: "u1" },
    { op: "kindsOf", user: "u1", ids: "all", what: "unread" }, { op: "kindsOf", user: "u1", ids: ["e1", "e3", "e4"], what: "unread" }, { op: "kindsOf", user: "u1", ids: ["e1", "e3", "e4"], what: "open" }, { op: "kindsOf", user: "u2", ids: "all", what: "open" },
    { op: "markRead", user: "u1", ids: "all" }, { op: "count", user: "u1" }, { op: "advance", ms: 5 }, { op: "dismiss", user: "u1", ids: ["e1", "e3", "nope"] }, { op: "dismiss", user: "u1", ids: ["e3"] }, { op: "dismiss", user: "u2", ids: ["e5"] },
    { op: "count", user: "u1" }, { op: "kindsOf", user: "u1", ids: "all", what: "open" },
    { op: "settle", user: "u1", key: "approval:1" }, { op: "settle", user: "u1", key: "approval:1" }, { op: "settle", user: "u2", key: "approval:2" }, { op: "settle", user: "u1", key: "none:1" },
    pub({ userId: "u2", kind: "approval", dedupeKey: "approval:2" }), pub({ userId: "u3", kind: "approval", dedupeKey: "approval:2" }), { op: "settleEverywhere", key: "approval:2" }, { op: "settleEverywhere", key: "approval:2" }, { op: "settleEverywhere", key: "x" },
    { op: "count", user: "u1" }, list({ includeDismissed: true }),
  ]));
  out.push(runStore("id-lists", {}, [
    pub(), pub({ dedupeKey: "system:b" }),
    ...[[], ["e1"], ["e1", "e1"], [""], ["x".repeat(64)], ["x".repeat(65)], Array.from({ length: 500 }, (_, i) => `n${i}`), Array.from({ length: 501 }, (_, i) => `n${i}`), ["\u{1F600}".repeat(32)], ["\u{1F600}".repeat(33)]].flatMap((ids) => [{ op: "markRead", user: "u1", ids }, { op: "dismiss", user: "u1", ids }, { op: "kindsOf", user: "u1", ids, what: "open" }]),
    { op: "markRead", user: "u1", ids: "all" }, { op: "dismiss", user: "u1", ids: "all" }, { op: "kindsOf", user: "u1", ids: "all", what: "unread" },
  ]));
  out.push(runStore("restart-and-migrate", {}, [
    pub(), pub({ userId: "u2", kind: "approval", dedupeKey: "approval:9" }), { op: "reopen" }, list({}), list({}, "u2"), { op: "count", user: "u2" }, pub({ dedupeKey: "system:c" }), { op: "dismiss", user: "u1", ids: ["e3"] }, { op: "reopen" }, list({ includeDismissed: true }),
    { op: "migrate", notices: [{ kind: "granted", userId: "u1", grantId: "g1", holderUserId: "h", reason: "secret reason", expiresAt: 5 }, { kind: "granted", userId: "u2", grantId: "g2", holderUserId: "h", reason: "x", expiresAt: 6 }] },
    { op: "migrate", notices: [{ kind: "granted", userId: "u1", grantId: "g1", holderUserId: "h", reason: "secret reason", expiresAt: 5 }] },
    { op: "migrate", notices: [{ kind: "granted", userId: "u1", grantId: "g3", holderUserId: "h".repeat(201), reason: "r", expiresAt: 7 }] },
    { op: "migrate", notices: [{ kind: "granted", userId: "", grantId: "g4", holderUserId: "h", reason: "r", expiresAt: 7 }] },
    list({ kinds: ["breakglass"] }), list({ kinds: ["breakglass"] }, "u2"),
  ]));
  return out;
}

// --- service ----------------------------------------------------------------------------------------------------------
function runService(name: string, w0: any, ops: any[]) {
  const dir = mkdtempSync(join(tmpdir(), "p4k-inbox-"));
  const path = join(dir, "state", "inbox.sqlite");
  let now = w0.now ?? 1_000_000, n = 0;
  let admins: string[] = w0.admins ?? [];
  let failListener = false, failMetric = false;
  const events: any[] = [], ticks: string[] = [], logs: any[] = [];
  const store = new InboxStore({ path, clock: () => now, idGen: () => `e${++n}` });
  const svc = createInboxService({
    store, admins: () => admins,
    onChange: (c) => { events.push(c); if (failListener) throw new Error("listener boom"); },
    onPublished: (k) => { ticks.push(k); if (failMetric) throw new Error("metric boom"); },
    log: (message, fields) => logs.push({ message, fields }),
  });
  const steps: unknown[] = [];
  try {
    for (const op of ops) {
      events.length = 0; ticks.length = 0; logs.length = 0;
      let out: unknown;
      try {
        switch (op.op) {
          case "publish": svc.publish(op.notice, op.options); out = { ok: null }; break;
          case "settle": svc.settle(op.target, op.key); out = { ok: null }; break;
          case "list": out = { ok: svc.list(op.user, op.q) }; break;
          case "count": out = { ok: svc.count(op.user) }; break;
          case "markRead": out = { ok: svc.markRead(op.user, op.ids) }; break;
          case "dismiss": out = { ok: svc.dismiss(op.user, op.ids) }; break;
          case "admins": admins = op.admins; out = { ok: null }; break;
          case "failListener": failListener = op.on; out = { ok: null }; break;
          case "failMetric": failMetric = op.on; out = { ok: null }; break;
          case "advance": now += op.ms; out = { ok: now }; break;
          default: throw new Error(`unknown op ${op.op}`);
        }
      } catch (e) { out = { err: errOf(e) }; }
      steps.push({ op, out, ...(events.length ? { events: [...events] } : {}), ...(ticks.length ? { ticks: [...ticks] } : {}), ...(logs.length ? { logs: logs.map((l) => ({ message: l.message, fields: l.fields })) } : {}) });
    }
    store.close();
    return { name, world: w0, ops: steps, final: { tables: dumpTables(path, TABLES) } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const notice = (over: Record<string, unknown> = {}) => ({ userId: "u1", kind: "system", severity: "info", titleKey: "inbox.test", dedupeKey: "system:a", ...over });
function serviceScenarios() {
  return [
    runService("publish-fan-out", { admins: ["a1", "a2", "a1", "a3"] }, [
      { op: "publish", notice: notice() }, { op: "publish", notice: notice() },
      { op: "publish", notice: { audience: "admins", kind: "channel", severity: "warning", titleKey: "inbox.channel.misconfigured", params: { channel: "x" }, dedupeKey: "channel:misconfigured:x" } },
      { op: "publish", notice: { audience: "admins", kind: "channel", severity: "warning", titleKey: "inbox.channel.misconfigured", dedupeKey: "channel:misconfigured:x" } },
      { op: "admins", admins: ["a1", "a4"] }, { op: "publish", notice: { audience: "admins", kind: "channel", severity: "warning", titleKey: "inbox.channel.misconfigured", dedupeKey: "channel:misconfigured:x" } },
      { op: "admins", admins: [] }, { op: "publish", notice: { audience: "admins", kind: "system", severity: "info", titleKey: "inbox.t", dedupeKey: "system:none" } },
      { op: "count", user: "a1" }, { op: "list", user: "a4", q: {} },
    ]),
    runService("rate-limited-publish", { admins: ["a1"] }, [
      { op: "publish", notice: notice({ dedupeKey: "cause" }), options: { cooldownMs: 1000 } }, { op: "publish", notice: notice({ dedupeKey: "cause" }), options: { cooldownMs: 1000 } },
      { op: "advance", ms: 1000 }, { op: "publish", notice: notice({ dedupeKey: "cause" }), options: { cooldownMs: 1000 } },
      { op: "publish", notice: notice({ dedupeKey: "c2" }), options: { cooldownMs: 0 } }, { op: "list", user: "u1", q: {} },
    ]),
    runService("a-store-or-listener-failure-never-reaches-the-source", { admins: ["a1"] }, [
      { op: "publish", notice: notice({ userId: "" }) }, { op: "publish", notice: notice({ kind: "nope" }) }, { op: "publish", notice: notice({ titleKey: "BAD" }) }, { op: "publish", notice: notice({ params: { a: [1] } }) },
      { op: "failListener", on: true }, { op: "publish", notice: notice() }, { op: "publish", notice: notice({ dedupeKey: "system:b" }) }, { op: "settle", target: { userId: "u1" }, key: "system:b" },
      { op: "markRead", user: "u1", ids: ["e1"] }, { op: "failListener", on: false }, { op: "failMetric", on: true }, { op: "publish", notice: notice({ dedupeKey: "system:c" }) }, { op: "failMetric", on: false },
      { op: "settle", target: { audience: "all" }, key: "system:c" }, { op: "settle", target: { audience: "admins" }, key: "system:c" }, { op: "settle", target: { userId: "u1" }, key: "nokind" },
    ]),
    runService("settle-and-state-changes", { admins: ["a1", "a2"] }, [
      { op: "publish", notice: { audience: "admins", kind: "job-failed", severity: "warning", titleKey: "inbox.jobFailed", dedupeKey: "job-failed:r1" } },
      { op: "publish", notice: notice({ kind: "approval", dedupeKey: "approval:1" }) }, { op: "publish", notice: notice({ userId: "u2", kind: "approval", dedupeKey: "approval:1" }) },
      { op: "settle", target: { userId: "u1" }, key: "approval:1" }, { op: "settle", target: { userId: "u1" }, key: "approval:1" }, { op: "settle", target: { audience: "all" }, key: "approval:1" }, { op: "settle", target: { audience: "all" }, key: "approval:1" },
      { op: "settle", target: { audience: "admins" }, key: "job-failed:r1" }, { op: "settle", target: { audience: "admins" }, key: "job-failed:r1" },
      { op: "publish", notice: notice({ kind: "pairing", dedupeKey: "pairing:p1" }) }, { op: "publish", notice: notice({ kind: "channel", dedupeKey: "channel:c1" }) },
      { op: "markRead", user: "u1", ids: ["e5"] }, { op: "markRead", user: "u1", ids: ["e5"] }, { op: "markRead", user: "u1", ids: "all" }, { op: "markRead", user: "u1", ids: "all" },
      { op: "dismiss", user: "u1", ids: ["e5", "e6", "zz"] }, { op: "dismiss", user: "u1", ids: ["e5"] }, { op: "dismiss", user: "u1", ids: [] }, { op: "markRead", user: "u1", ids: [""] },
      { op: "count", user: "u1" }, { op: "list", user: "u1", q: { includeDismissed: true } },
    ]),
  ];
}

// --- producers --------------------------------------------------------------------------------------------------------
function record(f: (port: any) => void) {
  const calls: unknown[] = [];
  const port = { publish: (n: unknown, options?: unknown) => calls.push({ publish: n, ...(options !== undefined ? { options } : {}) }), settle: (target: unknown, key: string) => calls.push({ settle: { target, key } }) };
  let err: unknown;
  try { f(port); } catch (e) { err = errOf(e); }
  return { calls, ...(err ? { err } : {}) };
}

const TOKENS = [
  "xoxb-1234567890-abcdef", "xapp-1-A0123", "sk-abcdef123456", "sk_live_abcdef", "pk_test_abcdef", "rk_live_x", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "gho_abc", "ghs_abc", "github_pat_11ABCDEFG", "glpat-abcdefghij", "AKIAABCDEFGH01234", "AKIAABCDEFG", "AKIAabcdefgh1", "AIzaSyA-abcdef", "ya29.a0AfH6", "ya29x", "eyJhbGciOiJIUzI1NiJ9", "syt_abcdef", "mfa.abcdef", "mfax",
  "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ-_01", "12345:ABCDEFGHIJKLMNOPQRSTUVWXYZ-_01", "123456:ABCDEFGHIJKLMNOPQRS", "123456:ABCDEFGHIJKLMNOPQRST", "123456:ABCDEFGHIJKLMNOPQRST!", "123456:ABCDEFGHIJKLMNOPQRST.",
  "AAAAAAAAAAAAAAAAAAAA.BBBB.CCCCCCCCCCCCCCCCCCCC", "AAAAAAAAAAAAAAAAAAA.BBBB.CCCCCCCCCCCCCCCCCCCC", "AAAAAAAAAAAAAAAAAAAA.BBB.CCCCCCCCCCCCCCCCCCCC", "AAAAAAAAAAAAAAAAAAAA.BBBB.CCCCCCCCCCCCCCCCCCC", "AAAAAAAAAAAAAAAAAAAA.BBBB.CCCCCCCCCCCCCCCCCCCC.D", "AAAAAAAAAAAAAAAAAAAA.BBBB.CCCCCCCCCCCCCCCCCCC!",
];
const WRAP = (t: string) => [t, `(${t})`, `"${t}"`, `'${t}'`, `\`${t}\``, `${t},`, `${t}.`, `${t};`, `${t}:`, `((${t}))`, `"(${t})",`, `url=${t}`, `https://example.test/${t}/x?k=${t}&z=1#${t}`, `a@${t}`, `bot${t}/getMe`, `see ${t} and ${t}`, `x${t}`, `${t}x`];
const PARAM_TEXTS = [
  "", " ", "   ", "plain words", "a\tb\nc\r\nd  e", " nbsp ", "﻿text﻿", " em　space", "\u0085nel", "tail ", " lead",
  ...TOKENS.flatMap(WRAP),
  "(((", ")))", "\"\"", ".", "...", "(.)", ".\"", "\".\"", "()", "x)(", "a/b=c&d?e#f@g", "/=&?#@", "key=sk-abcdef123456&other=1", "path/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ-_01/sendMessage", "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ-_01/x", "x123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ-_01",
  "1234567:ABCDEFGHIJKLMNOPQRST1234567:ABCDEFGHIJKLMNOPQRST", "123456::ABCDEFGHIJKLMNOPQRST", "12345678901234567890:AAAAAAAAAAAAAAAAAAAA", "123456:AAAAAAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBB",
  "a".repeat(199), "a".repeat(200), "a".repeat(201), "a".repeat(400), "a".repeat(198) + "\u{1F600}", "a".repeat(199) + "\u{1F600}", "a".repeat(197) + "\u{1F600}x", "\u{1F600}".repeat(100), "\u{1F600}".repeat(101), "é".repeat(250),
  "ghp_" + "x".repeat(300), `${"w ".repeat(150)}end`, "sk-" + "a".repeat(10) + " " + "b".repeat(250),
];
const grants = (now: number) => [
  { id: "g1", person: "p1", agent: "main", capability: "fs.read", scope: "always", createdAt: now - 90 * 86_400_000 },
  { id: "g2", person: "p1", agent: "main", capability: "fs.write", scope: "always", createdAt: now - 90 * 86_400_000 + 1 },
  { id: "g3", person: "p2", agent: "main", capability: "net", scope: "session", createdAt: 0 },
  { id: "g4", person: "", agent: "main", capability: "net", scope: "always", createdAt: 0 },
  { id: "g5", person: "p3", agent: "a".repeat(250), capability: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", scope: "always", createdAt: 0 },
];

/** A string JSON cannot hold (a `slice` that cut an emoji in two) is recorded as `{ "$u16": [units] }`: the Rust replay drops a lone half (K3-D4). */
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
function encodeLone(v: unknown): unknown {
  if (typeof v === "string") return LONE.test(v) ? { $u16: Array.from({ length: v.length }, (_, i) => v.charCodeAt(i)) } : v;
  if (Array.isArray(v)) return v.map(encodeLone);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeLone(x)]));
  return v;
}

function producerCases() {
  const out: any[] = [];
  const add = (fn: string, args: unknown[], f: (port: any) => void) => out.push(encodeLone({ fn, args, ...record(f) }));
  for (const [name, payload] of [
    ["approval.requested", { approval: { id: "a1", principal: "p1", capability: "fs.read" } }], ["approval.requested", { approval: { id: "a1", principal: "p1" } }], ["approval.requested", { approval: { id: "a1", principal: "p1", capability: "" } }],
    ["approval.requested", { approval: { id: "a1", principal: "p1", capability: 5 } }], ["approval.requested", { approval: { id: "", principal: "p1" } }], ["approval.requested", { approval: { id: "a1", principal: "" } }], ["approval.requested", { approval: { id: 1, principal: "p1" } }],
    ["approval.requested", {}], ["approval.requested", null], ["approval.requested", "x"], ["approval.requested", []], ["approval.requested", { approval: [] }], ["approval.requested", { approval: "x" }], ["approval.requested", { approval: { id: "a1", principal: "p1", capability: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } }],
    ["approval.resolved", { approval: { id: "a1", principal: "p1" } }], ["approval.resolved", { approval: { id: "a1" } }], ["approval.resolved", {}], ["approval.granted", { approval: { id: "a1", principal: "p1" } }], ["", {}],
  ] as [string, unknown][]) add("approvalToInbox", [name, payload], (p) => P.approvalToInbox(p, name, payload));
  for (const run of [{ runId: "r1", job: "models.scan" }, { runId: "r1", job: "j", reason: "boom" }, { runId: "r1", job: "j", reason: "" }, { runId: "r2", job: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", reason: "sk-abcdef123456" }, { runId: "r3", job: "x".repeat(300), reason: "y".repeat(300) }, { runId: "", job: "j" }] as any[]) add("jobFailedToInbox", [run], (p) => P.jobFailedToInbox(p, run));
  for (const t of PARAM_TEXTS) add("jobFailedToInbox", [{ runId: "r", job: "j", reason: t }], (p) => P.jobFailedToInbox(p, { runId: "r", job: "j", reason: t }));
  for (const [name, payload] of [
    ["media.index.failed", { mediaId: "m1", stage: "ocr" }], ["media.index.failed", { mediaId: "m1" }], ["media.index.failed", { mediaId: "m1", stage: "" }], ["media.index.failed", { stage: "ocr" }], ["media.index.failed", { mediaId: "" }], ["media.index.failed", null],
    ["media.index.status", { backfill: { state: "done" }, fingerprint: "fp1" }], ["media.index.status", { backfill: { state: "done" } }], ["media.index.status", { backfill: { state: "running" }, fingerprint: "fp1" }], ["media.index.status", { backfill: "done" }], ["media.index.status", {}], ["media.index.status", { backfill: { state: "done" }, fingerprint: "" }], ["media.index.other", { mediaId: "m1" }],
  ] as [string, unknown][]) add("mediaToInbox", [name, payload], (p) => P.mediaToInbox(p, name, payload));
  for (const e of [
    { action: "identity.pair.claim", target: "t1", detail: { result: "awaiting-confirmation", humanId: "h1", channel: "telegram" } }, { action: "identity.pair.claim", target: "t1", detail: { result: "awaiting-confirmation", humanId: "h1" } },
    { action: "identity.pair.claim", target: "t1", detail: { result: "awaiting-confirmation" } }, { action: "identity.pair.claim", target: "t1", detail: { result: "done", humanId: "h1" } }, { action: "identity.pair.claim", target: "t1" },
    { action: "identity.pair.confirm", target: "t1" }, { action: "identity.pair.revoke", target: "t1", detail: {} }, { action: "identity.pair.decline", target: "t1" }, { action: "other", target: "t1" },
    { action: "identity.pair.claim", target: "t1", detail: { result: "awaiting-confirmation", humanId: "h1", channel: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } },
  ] as any[]) add("pairingToInbox", [e], (p) => P.pairingToInbox(p, e));
  for (const [message, fields] of [["channel.misconfigured", { channel: "telegram" }], ["channel.misconfigured", { channel: "" }], ["channel.misconfigured", {}], ["channel.misconfigured", null], ["channel.other", { channel: "telegram" }], ["channel.misconfigured", { channel: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ-_01" }], ["channel.misconfigured", { channel: 5 }]] as [string, unknown][]) add("channelToInbox", [message, fields], (p) => P.channelToInbox(p, message, fields));
  for (const n of [
    { kind: "granted", userId: "u1", grantId: "g1", holderUserId: "h1", reason: "never copied", expiresAt: 1234 }, { kind: "granted", userId: "u1", grantId: "g1", holderUserId: "h".repeat(300), reason: "r", expiresAt: 0 },
  ] as any[]) { add("breakglassToInbox", [n], (p) => P.breakglassToInbox(p, n)); out.push({ fn: "breakglassDraft", args: [n], draft: breakglassDraft(n) }); }
  const now = 1_000_000_000_000;
  add("alwaysGrantsToInbox", [grants(now), now], (p) => P.alwaysGrantsToInbox(p, grants(now), now));
  add("alwaysGrantsToInbox", [grants(now), now - 1], (p) => P.alwaysGrantsToInbox(p, grants(now), now - 1));
  add("alwaysGrantsToInbox", [[], now], (p) => P.alwaysGrantsToInbox(p, [], now));
  return out;
}

export async function buildInboxVectors() {
  return { store: storeScenarios(), service: serviceScenarios(), producers: producerCases() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "inbox", build: buildInboxVectors });
}
