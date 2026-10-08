import { test } from "node:test";
import assert from "node:assert/strict";
import { SECURITY_NOTICE_VERSION, compileAllowlist, confirmSecurityNotice, firstAidChecks, noticeNeeded, securityNoticeItems } from "../src/security.ts";
import type { FirstAidState } from "../src/security.ts";
import { DEFAULT_REMOTE_CONFIG } from "../src/exposure.ts";
import type { RemoteConfig } from "../src/exposure.ts";

const T0 = Date.parse("2026-10-08T10:00:00Z");
const DAY = 86_400_000;

function list(cidrs: string[]) {
  const r = compileAllowlist(cidrs);
  assert.ok(r.ok, JSON.stringify(r));
  return r.list;
}

test("allow-list: IPv4 and IPv6 rules, IPv4-mapped clients, zone ids", () => {
  const l = list(["192.168.10.0/24", "10.1.2.3", "fd12:3456::/32"]);
  assert.deepEqual(l.cidrs, ["192.168.10.0/24", "10.1.2.3/32", "fd12:3456::/32"]);
  assert.equal(l.isEmpty, false);
  assert.equal(l.allows("192.168.10.200"), true);
  assert.equal(l.allows("::ffff:192.168.10.200"), true, "a dual-stack socket reports IPv4 clients this way");
  assert.equal(l.allows("192.168.11.1"), false);
  assert.equal(l.allows("::ffff:192.168.11.1"), false);
  assert.equal(l.allows("10.1.2.3"), true);
  assert.equal(l.allows("10.1.2.4"), false);
  assert.equal(l.allows("fd12:3456:abcd::1"), true);
  assert.equal(l.allows("fd12:3457::1"), false);
  assert.equal(l.allows("fe80::1%en0"), false);
  assert.equal(list(["fe80::/10"]).allows("fe80::1%en0"), true);
  assert.equal(l.allows("8.8.8.8"), false);
});

test("allow-list: garbage addresses never match a non-empty list; an empty list admits everyone", () => {
  const l = list(["10.0.0.0/8"]);
  for (const bad of ["", "not an ip", "10.0.0", "10.0.0.256", "10.0.0.1/8", "localhost"]) assert.equal(l.allows(bad), false, bad);
  const open = list([]);
  assert.equal(open.isEmpty, true);
  assert.equal(open.allows("203.0.113.9"), true);
  assert.equal(open.allows("::1"), true);
});

test("allow-list: wide rules, an IPv6 any-rule covers mapped IPv4, duplicates collapse, bad rules are reported", () => {
  assert.equal(list(["0.0.0.0/0"]).allows("203.0.113.9"), true);
  assert.equal(list(["0.0.0.0/0"]).allows("2001:db8::1"), false);
  assert.equal(list(["::/0"]).allows("203.0.113.9"), true);
  assert.deepEqual(list(["10.0.0.0/8", "10.9.9.9/8", "::ffff:10.0.0.0/104"]).cidrs, ["10.0.0.0/8"]);
  const r = compileAllowlist(["10.0.0.0/8", "nope", "10.0.0.0/33"]);
  assert.ok(!r.ok);
  assert.deepEqual(r.issues.map((i) => i.path), ["[1]", "[2]"]);
});

test("security notice: explicit confirmation by a named person, recorded with time and version", () => {
  const ok = confirmSecurityNotice({ by: "christian", at: T0, confirmed: true });
  assert.deepEqual(ok, { ok: true, ack: { by: "christian", at: T0, version: SECURITY_NOTICE_VERSION } });
  for (const bad of [
    { by: "christian", at: T0, confirmed: false },
    { by: "christian", at: T0 },
    { by: "christian", at: T0, confirmed: "yes" },
    { by: "", at: T0, confirmed: true },
    { by: "  ", at: T0, confirmed: true },
    { by: "christian", at: Number.NaN, confirmed: true },
    { by: "christian", at: T0, confirmed: true, version: SECURITY_NOTICE_VERSION + 1 },
    null,
    "confirmed",
  ]) {
    const r = confirmSecurityNotice(bad as never);
    assert.ok(!r.ok, JSON.stringify(bad));
  }
  const net: RemoteConfig = { ...DEFAULT_REMOTE_CONFIG, publish: "network" };
  assert.equal(noticeNeeded(net, undefined), true);
  assert.equal(noticeNeeded(net, { by: "x", at: T0 }), true, "an acknowledgement without the current version counts as unconfirmed");
  assert.equal(noticeNeeded(net, { by: "x", at: T0, version: SECURITY_NOTICE_VERSION }), false);
  assert.equal(noticeNeeded(DEFAULT_REMOTE_CONFIG, undefined), false);
});

test("security notice content covers reach, pairing, TLS inspection, the allow-list and never-public", () => {
  const items = securityNoticeItems({ ...DEFAULT_REMOTE_CONFIG, publish: "network" });
  const codes = items.map((i) => i.code);
  for (const c of ["reachable-from-network", "pairing-required", "tls-inspection", "allow-list", "never-public"]) assert.ok(codes.includes(c), c);
  assert.ok(items.every((i) => i.text.length > 20));
  const selfSigned = items.find((i) => i.code === "tls-inspection")!;
  assert.match(selfSigned.text, /inspect/i);
  const withList = securityNoticeItems({ ...DEFAULT_REMOTE_CONFIG, publish: "network", allowSubnets: ["10.0.0.0/8"] });
  assert.ok(!withList.some((i) => i.code === "allow-list-empty"));
  assert.ok(items.some((i) => i.code === "allow-list-empty"));
});

// --- firstAidChecks ------------------------------------------------------------------------------------------------

const NET: RemoteConfig = { ...DEFAULT_REMOTE_CONFIG, publish: "network", allowSubnets: ["10.0.0.0/8"] };
const GOOD: FirstAidState = { now: T0, certNotAfter: T0 + 200 * DAY, noticeAck: { by: "o", at: T0, version: SECURITY_NOTICE_VERSION }, tlsReady: true };
const ids = (c: RemoteConfig, s: FirstAidState) => firstAidChecks(c, s).map((e) => e.id);

test("firstAidChecks: local and tailnet are quiet", () => {
  assert.deepEqual(firstAidChecks({ ...DEFAULT_REMOTE_CONFIG, publish: "local" }, { now: T0 }), []);
  assert.deepEqual(firstAidChecks(DEFAULT_REMOTE_CONFIG, { now: T0 }), []);
});

test("firstAidChecks: network is a warning for as long as it is on, and nothing else when everything is in order", () => {
  const out = firstAidChecks(NET, GOOD);
  assert.deepEqual(out.map((e) => e.id), ["remote.network-on"]);
  assert.equal(out[0]?.severity, "warn");
  assert.ok(out[0]!.message.length > 20);
});

test("firstAidChecks: empty allow-list, expiring and expired certificate, TLS not ready, notice missing or outdated", () => {
  assert.deepEqual(ids({ ...NET, allowSubnets: [] }, GOOD), ["remote.network-on", "remote.allowlist-empty"]);
  assert.deepEqual(ids(NET, { ...GOOD, certNotAfter: T0 + 29 * DAY }), ["remote.network-on", "remote.cert-expiring"]);
  assert.deepEqual(ids(NET, { ...GOOD, certNotAfter: T0 + 31 * DAY }), ["remote.network-on"]);
  assert.deepEqual(ids(NET, { ...GOOD, certNotAfter: T0 - 1 }), ["remote.network-on", "remote.cert-expired"]);
  assert.deepEqual(ids(NET, { ...GOOD, tlsReady: false }), ["remote.network-on", "remote.tls-not-ready"]);
  assert.deepEqual(ids(NET, { ...GOOD, noticeAck: undefined }), ["remote.network-on", "remote.notice-unconfirmed"]);
  assert.deepEqual(ids(NET, { ...GOOD, noticeAck: { by: "o", at: T0 } }), ["remote.network-on", "remote.notice-unconfirmed"]);
  assert.match(firstAidChecks(NET, { ...GOOD, certNotAfter: T0 + 12 * DAY + 3600_000 }).find((e) => e.id === "remote.cert-expiring")!.message, /12 days/);
});

test("firstAidChecks: a detected Funnel is reported at every exposure level", () => {
  for (const publish of ["local", "tailnet", "network"] as const) {
    const out = ids({ ...NET, publish }, { ...GOOD, funnelActive: true });
    assert.ok(out.includes("remote.funnel-active"), publish);
  }
  const f = firstAidChecks(DEFAULT_REMOTE_CONFIG, { now: T0, funnelActive: true })[0]!;
  assert.equal(f.id, "remote.funnel-active");
  assert.match(f.fix ?? "", /funnel/i);
  assert.equal(ids(DEFAULT_REMOTE_CONFIG, { now: T0, funnelActive: false }).length, 0);
});

test("firstAidChecks: everything at once is ordered, unique and all warnings", () => {
  const out = firstAidChecks({ ...NET, allowSubnets: [] }, { now: T0, certNotAfter: T0 + DAY, tlsReady: false, funnelActive: true });
  assert.deepEqual(out.map((e) => e.id), [
    "remote.funnel-active", "remote.network-on", "remote.notice-unconfirmed", "remote.tls-not-ready", "remote.cert-expiring", "remote.allowlist-empty",
  ]);
  assert.equal(new Set(out.map((e) => e.id)).size, out.length);
  assert.ok(out.every((e) => e.severity === "warn"));
});
