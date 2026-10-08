import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRemoteConfig, planListeners, DEFAULT_REMOTE_CONFIG } from "../src/exposure.ts";
import type { PlanEnv, PlanResult, RemoteConfig } from "../src/exposure.ts";

const LAN = [
  { name: "lo0", address: "127.0.0.1", internal: true },
  { name: "en0", address: "192.168.1.20" },
  { name: "en0", address: "fe80::1c2:3%en0" },
];
const NOTICE = { by: "owner", at: 1_700_000_000_000 };
const env = (over: Partial<PlanEnv> = {}): PlanEnv => ({ apiPort: 18700, tlsPort: 18701, hostInterfaces: LAN, ...over });
const cfg = (over: Partial<RemoteConfig> = {}): RemoteConfig => ({ ...DEFAULT_REMOTE_CONFIG, ...over });
const codes = (r: PlanResult) => (r.ok ? [] : r.refusals.map((x) => x.code)).sort();

// --- configuration -------------------------------------------------------------------------------------------------

test("parseRemoteConfig: defaults to tailnet + self-signed, nothing public", () => {
  const r = parseRemoteConfig(undefined);
  assert.ok(r.ok);
  assert.deepEqual(r.config, { publish: "tailnet", tls: "self-signed", bind: {}, allowSubnets: [] });
  assert.deepEqual(parseRemoteConfig({}), r);
});

test("parseRemoteConfig: accepts every mode, normalises and de-duplicates subnets, accepts the spec's allowCidrs alias", () => {
  const r = parseRemoteConfig({
    publish: "network", tls: "company-ca", bind: { address: "192.168.1.20", port: 18701 },
    allowSubnets: ["10.1.2.3/8", "10.0.0.0/8", "fd00::1/8", "::ffff:172.16.0.0/108"],
  });
  assert.ok(r.ok);
  assert.equal(r.config.publish, "network");
  assert.equal(r.config.tls, "company-ca");
  assert.deepEqual(r.config.allowSubnets, ["10.0.0.0/8", "fd00::/8", "172.16.0.0/12"]);
  const alias = parseRemoteConfig({ publish: "network", allowCidrs: ["10.0.0.0/8"] });
  assert.ok(alias.ok);
  assert.deepEqual(alias.config.allowSubnets, ["10.0.0.0/8"]);
  const both = parseRemoteConfig({ allowSubnets: [], allowCidrs: [] });
  assert.ok(!both.ok);
  assert.equal(both.issues[0]?.code, "alias-conflict");
});

test("parseRemoteConfig: rejects bad values with a path and a code each", () => {
  const r = parseRemoteConfig({
    publish: "public", tls: "letsencrypt", bind: { address: "example.com", port: 80, allowPublicInterface: "yes" },
    allowSubnets: ["10.0.0.0/40", 5],
  });
  assert.ok(!r.ok);
  const byPath = Object.fromEntries(r.issues.map((i) => [i.path, i.code]));
  assert.equal(byPath["publish"], "invalid-publish");
  assert.equal(byPath["tls"], "invalid-tls");
  assert.equal(byPath["bind.address"], "invalid-bind");
  assert.equal(byPath["bind.port"], "invalid-bind");
  assert.equal(byPath["bind.allowPublicInterface"], "invalid-bind");
  assert.equal(byPath["allowSubnets[0]"], "invalid-cidr");
  assert.equal(byPath["allowSubnets[1]"], "invalid-cidr");
  assert.ok(!parseRemoteConfig("network").ok);
  assert.ok(!parseRemoteConfig(null).ok);
  assert.ok(!parseRemoteConfig({ bind: [] }).ok);
});

test("parseRemoteConfig: there is no Funnel, under any spelling, at any depth", () => {
  for (const input of [{ funnel: true }, { publish: "funnel" }, { allowFunnel: true }, { bind: { funnel: true } }, { tailscale: { funnel: "on" } }]) {
    const r = parseRemoteConfig(input);
    assert.ok(!r.ok, JSON.stringify(input));
    assert.ok(r.issues.some((i) => i.code === "funnel-forbidden"), JSON.stringify(input));
  }
  const unknown = parseRemoteConfig({ colour: "red" });
  assert.ok(!unknown.ok);
  assert.equal(unknown.issues[0]?.code, "unknown-key");
});

// --- planListeners matrix ------------------------------------------------------------------------------------------

test("planListeners local: loopback http only", () => {
  const r = planListeners(cfg({ publish: "local" }), env());
  assert.ok(r.ok);
  assert.deepEqual(r.listeners, [{ id: "api-loopback", protocol: "http", address: "127.0.0.1", port: 18700, tlsOnly: false }]);
  assert.equal(r.tailscaleServe, undefined);
});

test("planListeners tailnet: loopback plus a tailscale serve target, never Funnel; not joined means loopback only", () => {
  const joined = planListeners(cfg(), env({ tailscale: { loggedIn: true, dnsName: "box.tail1234.ts.net" } }));
  assert.ok(joined.ok);
  assert.equal(joined.listeners.length, 1);
  assert.equal(joined.listeners[0]?.address, "127.0.0.1");
  assert.deepEqual(joined.tailscaleServe, { httpsPort: 443, target: "http://127.0.0.1:18700" });
  assert.ok(!JSON.stringify(joined).toLowerCase().includes("funnel"));
  for (const tailscale of [undefined, { loggedIn: false }]) {
    const r = planListeners(cfg(), env(tailscale ? { tailscale } : {}));
    assert.ok(r.ok);
    assert.equal(r.tailscaleServe, undefined);
    assert.deepEqual(r.warnings.map((w) => w.code), ["tailnet-not-joined"]);
  }
});

test("planListeners network: TLS-only listener on the host interface, loopback http stays on 127.0.0.1", () => {
  const r = planListeners(
    cfg({ publish: "network", bind: { address: "192.168.1.20", port: 18705 }, allowSubnets: ["192.168.1.0/24"] }),
    env({ tlsReady: true, noticeAck: NOTICE }),
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.listeners, [
    { id: "api-loopback", protocol: "http", address: "127.0.0.1", port: 18700, tlsOnly: false },
    { id: "api-tls", protocol: "https", address: "192.168.1.20", port: 18705, tlsOnly: true, allowSubnets: ["192.168.1.0/24"] },
  ]);
  const wild = planListeners(cfg({ publish: "network" }), env({ tlsReady: true, noticeAck: NOTICE }));
  assert.ok(wild.ok);
  assert.deepEqual(wild.listeners[1], { id: "api-tls", protocol: "https", address: "0.0.0.0", port: 18701, tlsOnly: true });
  assert.ok(wild.listeners.every((l) => l.protocol === "https" || l.address === "127.0.0.1"));
});

test("planListeners network: unsafe combinations are refused, each with its own code", () => {
  const base = cfg({ publish: "network" });
  assert.deepEqual(codes(planListeners(base, env({ noticeAck: NOTICE }))), ["network-needs-tls"]);
  assert.deepEqual(codes(planListeners(base, env({ tlsReady: true }))), ["network-needs-notice-confirmation"]);
  assert.deepEqual(codes(planListeners(base, env())), ["network-needs-notice-confirmation", "network-needs-tls"]);
  const ok = { tlsReady: true, noticeAck: NOTICE };
  assert.deepEqual(codes(planListeners(base, env({ ...ok, tlsPort: undefined }))), ["network-no-port"]);
  assert.deepEqual(codes(planListeners(cfg({ publish: "network", bind: { port: 18700 } }), env(ok))), ["network-port-clash"]);
  assert.deepEqual(codes(planListeners(cfg({ publish: "network", bind: { address: "127.0.0.1" } }), env(ok))), ["network-bind-loopback"]);
  assert.deepEqual(codes(planListeners(cfg({ publish: "network", bind: { address: "::1" } }), env(ok))), ["network-bind-loopback"]);
  assert.deepEqual(codes(planListeners(cfg({ publish: "network", bind: { address: "10.9.9.9" } }), env(ok))), ["network-bind-unknown-interface"]);
});

test("planListeners network: a public interface needs an explicit confirmation, wildcard included", () => {
  const ok = { tlsReady: true, noticeAck: NOTICE };
  const withPublic = [...LAN, { name: "eth1", address: "203.0.113.7" }];
  const specific = cfg({ publish: "network", bind: { address: "203.0.113.7" } });
  assert.deepEqual(codes(planListeners(specific, env({ ...ok, hostInterfaces: withPublic }))), ["network-public-interface-unconfirmed"]);
  assert.deepEqual(codes(planListeners(cfg({ publish: "network" }), env({ ...ok, hostInterfaces: withPublic }))), ["network-public-interface-unconfirmed"]);
  const confirmed = planListeners(
    cfg({ publish: "network", bind: { allowPublicInterface: true } }),
    env({ ...ok, hostInterfaces: withPublic }),
  );
  assert.ok(confirmed.ok);
  assert.deepEqual(confirmed.warnings.map((w) => w.code), ["network-public-interface-confirmed"]);
  // a private-only host needs no such confirmation, a CGNAT/Tailscale address counts as non-public
  const cgnat = planListeners(cfg({ publish: "network" }), env({ ...ok, hostInterfaces: [...LAN, { name: "utun3", address: "100.101.102.103" }] }));
  assert.ok(cgnat.ok);
});

test("planListeners: subnet rules that cannot be enforced are called out instead of silently ignored", () => {
  const local = planListeners(cfg({ publish: "local", allowSubnets: ["10.0.0.0/8"] }), env());
  assert.ok(local.ok);
  assert.deepEqual(local.warnings.map((w) => w.code), ["allow-subnets-not-enforced"]);
  const tail = planListeners(cfg({ allowSubnets: ["10.0.0.0/8"] }), env({ tailscale: { loggedIn: true } }));
  assert.ok(tail.ok);
  assert.deepEqual(tail.warnings.map((w) => w.code), ["allow-subnets-not-enforced"]);
  const bind = planListeners(cfg({ publish: "local", bind: { port: 18705 } }), env());
  assert.ok(bind.ok);
  assert.deepEqual(bind.warnings.map((w) => w.code), ["bind-ignored"]);
});
