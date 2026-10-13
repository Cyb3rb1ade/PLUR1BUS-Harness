// Step 9 of the server hardening sweep: exposure planning, network addresses, Tailscale detection, the security checks.
// Time is the injected `now`; generative cases use mulberry32 with a fixed seed that appears in every failure message; the
// "exec" port is a fake (no process is ever spawned and no network is touched).
// Already pinned elsewhere (not repeated): the refusal matrix by example, the default config, Funnel under every spelling at
// any depth (exposure.test.ts), the CLI search order and every documented backend state (tailscale*.test.ts), allow-list
// examples and the firstAid checks by example (security.test.ts), the scope of a few addresses (net-address.test.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_REMOTE_CONFIG, parseRemoteConfig, planListeners, type HostInterface, type PlanEnv, type RemoteConfig } from "../src/exposure.ts";
import { addressScope, cidrContains, formatIp, parseCidr, parseIp, type AddressScope } from "../src/net-address.ts";
import { CERT_WARN_DAYS, SECURITY_NOTICE_VERSION, admitSocket, compileAllowlist, confirmSecurityNotice, firstAidChecks, noticeNeeded, securityNoticeItems } from "../src/security.ts";
import { assertNoFunnel, detectServe, detectTailscale, parseServeStatus, planServe, runServePlan, type ExecPort, type ExecResult } from "../src/tailscale.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const DAY = 86_400_000;
const scopeOf = (text: string): AddressScope | undefined => { const ip = parseIp(text); return ip ? addressScope(ip) : undefined; };

// ---- address classification ----------------------------------------------------------------------------------------

test("every address class, at both of its edges: the last address outside, the first and last inside, the first outside again", () => {
  const table: Array<[string, AddressScope | undefined]> = [
    // IPv4
    ["10.0.0.0", "private"], ["10.255.255.255", "private"], ["9.255.255.255", "public"], ["11.0.0.0", "public"],
    ["172.15.255.255", "public"], ["172.16.0.0", "private"], ["172.31.255.255", "private"], ["172.32.0.0", "public"],
    ["192.167.255.255", "public"], ["192.168.0.0", "private"], ["192.168.255.255", "private"], ["192.169.0.0", "public"],
    ["169.253.255.255", "public"], ["169.254.0.0", "link-local"], ["169.254.255.255", "link-local"], ["169.255.0.0", "public"],
    ["100.63.255.255", "public"], ["100.64.0.0", "cgnat"], ["100.127.255.255", "cgnat"], ["100.128.0.0", "public"],
    ["126.255.255.255", "public"], ["127.0.0.0", "loopback"], ["127.0.0.1", "loopback"], ["127.255.255.255", "loopback"], ["128.0.0.0", "public"],
    ["0.0.0.0", "unspecified"], ["1.0.0.0", "public"], ["8.8.8.8", "public"], ["224.0.0.1", "public"], ["255.255.255.255", "public"],
    // IPv6
    ["::1", "loopback"], ["0:0:0:0:0:0:0:1", "loopback"], ["0000::0001", "loopback"], ["::", "unspecified"], ["::0", "unspecified"], ["0:0:0:0:0:0:0:0", "unspecified"],
    ["fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "public"], ["fc00::", "private"], ["fd12:3456::1", "private"], ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "private"], ["fe00::", "public"],
    ["fe7f:ffff::1", "public"], ["fe80::", "link-local"], ["fe80::1", "link-local"], ["febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "link-local"], ["fec0::1", "public"], ["ff02::1", "public"], ["2001:db8::1", "public"], ["2606:4700::1111", "public"],
    // IPv4-mapped IPv6 is the IPv4 address it carries, in every spelling
    ["::ffff:127.0.0.1", "loopback"], ["::ffff:7f00:1", "loopback"], ["0:0:0:0:0:ffff:7f00:0001", "loopback"], ["::ffff:10.1.2.3", "private"], ["::ffff:a01:203", "private"], ["::ffff:192.168.0.1", "private"], ["::ffff:169.254.1.1", "link-local"], ["::ffff:8.8.8.8", "public"], ["::ffff:0.0.0.0", "unspecified"],
    // close relatives that are NOT mapped: classified as what they are (IPv6, none of the special ranges)
    ["::127.0.0.1", "public"], ["::ffff:0:7f00:1", "public"], ["64:ff9b::7f00:1", "public"], ["::fffe:7f00:1", "public"], ["::1:0:0:0:1", "public"],
    // zone ids never change the class (and an empty or malformed one is not an address)
    ["fe80::1%eth0", "link-local"], ["fe80::1%1", "link-local"], ["::1%lo", "loopback"], ["fd00::1%en0", "private"], ["2001:db8::1%eth0", "public"],
    ["fe80::1%", undefined], ["127.0.0.1%lo", undefined],
    // not addresses at all
    ["", undefined], [" 127.0.0.1", undefined], ["127.0.0.1 ", undefined], ["127.1", undefined], ["2130706433", undefined], ["0x7f.0.0.1", undefined], ["0177.0.0.1", undefined], ["127.000.000.001", undefined], ["[::1]", undefined], ["::1::", undefined], ["localhost", undefined], ["1.2.3.4.5", undefined], ["256.1.1.1", undefined], ["::g", undefined], ["1:2:3:4:5:6:7:8:9", undefined],
  ];
  const wrong = table.filter(([text, want]) => scopeOf(text) !== want).map(([text, want]) => `${JSON.stringify(text)}: ${scopeOf(text)} (expected ${want})`);
  assert.deepEqual(wrong, [], wrong.join("\n"));
});

test("only the exact wildcard is 'unspecified': other 0.x.y.z addresses are not a wildcard bind, and the plan refuses to bind them", () => {
  assert.equal(scopeOf("0.0.0.0"), "unspecified"); assert.equal(scopeOf("::"), "unspecified");
  for (const a of ["0.0.0.1", "0.1.2.3", "0.255.255.255"]) assert.notEqual(scopeOf(a), "unspecified", a);
  const cfg: RemoteConfig = { ...DEFAULT_REMOTE_CONFIG, publish: "network", bind: { address: "0.0.0.1" } };
  const r = planListeners(cfg, { apiPort: 7000, tlsPort: 8443, hostInterfaces: [{ name: "eth0", address: "192.168.1.5" }], tlsReady: true, noticeAck: { by: "a", at: 1, version: 1 } });
  assert.equal(r.ok, false); assert.ok(!r.ok && r.refusals.some((n) => n.code === "network-bind-unknown-interface"), JSON.stringify(r));
});

test("CIDR parsing and containment: boundaries of /0, /8, /31, /32, /127, /128, mapped ranges, and nothing that is not a prefix", () => {
  const inside = (cidr: string, ip: string) => { const c = parseCidr(cidr); const a = parseIp(ip); return c !== undefined && a !== undefined && cidrContains(c, a); };
  for (const [cidr, ip, want] of [["10.0.0.0/8", "10.255.255.255", true], ["10.0.0.0/8", "11.0.0.0", false], ["10.0.0.0/8", "9.255.255.255", false], ["192.168.1.0/24", "192.168.1.255", true], ["192.168.1.0/24", "192.168.2.0", false], ["10.0.0.4/31", "10.0.0.5", true], ["10.0.0.4/31", "10.0.0.6", false], ["10.0.0.4/31", "10.0.0.3", false],
    ["10.0.0.1/32", "10.0.0.1", true], ["10.0.0.1/32", "10.0.0.2", false], ["10.0.0.1", "10.0.0.1", true], ["0.0.0.0/0", "255.255.255.255", true], ["fd00::/8", "fdff::1", true], ["fd00::/8", "fe00::1", false], ["fe80::/10", "febf::1", true], ["fe80::/10", "fec0::1", false], ["::1/128", "::1", true], ["::1/128", "::2", false],
    ["::/0", "10.0.0.1", true], ["::ffff:10.0.0.0/104", "10.1.2.3", true], ["::ffff:10.0.0.0/104", "11.1.2.3", false], ["10.0.0.0/8", "::ffff:10.1.2.3", true], ["10.0.0.0/8", "::ffff:11.1.2.3", false], ["10.0.0.0/8", "fd00::1", false], ["fd00::/8", "10.0.0.1", false]] as const) assert.equal(inside(cidr, ip), want, `${cidr} contains ${ip}`);
  for (const bad of ["10.0.0.0/33", "10.0.0.0/-1", "10.0.0.0/08x", "10.0.0.0/", "/8", "10.0.0.0/8/8", "::/129", "::1%lo/128", "10.0.0.0/ 8", "10.0.0.0//8", "localhost/8", "10.0.0/8", "10.0.0.0/1e1", "10.0.0.0/0x8", `10.0.0.0/${"9".repeat(400)}`]) assert.equal(parseCidr(bad), undefined, bad);
  assert.equal(formatIp(parseIp("::ffff:10.1.2.3")!), "10.1.2.3"); assert.equal(formatIp(parseIp("2001:0db8:0:0:0:0:0:1")!), "2001:db8::1"); assert.equal(formatIp(parseIp("0:0:0:0:0:0:0:0")!), "::");
});

// ---- exposure planning ---------------------------------------------------------------------------------------------

const ADDRESS_POOL = [undefined, "0.0.0.0", "::", "::0", "127.0.0.1", "::1", "::ffff:127.0.0.1", "0.0.0.1", "10.0.0.5", "192.168.1.20", "172.20.1.1", "169.254.3.3", "100.70.1.1", "203.0.113.9", "8.8.8.8", "fe80::1%eth0", "fd00::5", "2001:db8::5", "::ffff:10.0.0.5", "not an address", "localhost", "10.0.0.99"];
const IFACES: HostInterface[][] = [
  [{ name: "lo", address: "127.0.0.1", internal: true }, { name: "eth0", address: "192.168.1.20" }],
  [{ name: "lo", address: "127.0.0.1", internal: true }, { name: "eth0", address: "192.168.1.20" }, { name: "ppp0", address: "203.0.113.9" }],
  [{ name: "lo", address: "127.0.0.1", internal: true }, { name: "eth0", address: "10.0.0.5" }, { name: "eth1", address: "2001:db8::5" }, { name: "wg0", address: "fd00::5" }],
  [{ name: "lo", address: "127.0.0.1", internal: true }, { name: "eth0", address: "fe80::1" }, { name: "docker0", address: "8.8.8.8", internal: true }],
  [],
];

test("3000 seeded configurations: nothing is ever bound beyond loopback unless network mode, a usable certificate, a confirmed notice and (for a public interface) an explicit confirmation are all there", () => {
  const SEED = 0xE70053; const rand = mulberry32(SEED); const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!; let opened = 0; let refused = 0;
  for (let i = 0; i < 3000; i++) {
    const publish = pick(["local", "tailnet", "network", "network", "network"] as const); const tls = pick(["self-signed", "company-ca"] as const); const address = pick(ADDRESS_POOL); const allowPublic = pick([undefined, true, false]);
    const port = pick([undefined, 1024, 7000, 8443, 65535]);
    const cfg: RemoteConfig = { publish, tls, bind: { ...(address !== undefined ? { address } : {}), ...(port !== undefined ? { port } : {}), ...(allowPublic !== undefined ? { allowPublicInterface: allowPublic } : {}) }, allowSubnets: rand() < 0.5 ? [] : ["10.0.0.0/8"] };
    const hostInterfaces = pick(IFACES); const tlsReady = pick([true, true, true, false, undefined]); const noticeAck = pick([undefined, { by: "a", at: 1, version: 1 }, { by: "a", at: 1, version: 1 }, { by: "a", at: 1, version: 1 }]);
    const env: PlanEnv = { apiPort: 7000, ...(pick([true, false]) ? { tlsPort: 8443 } : {}), hostInterfaces, tailscale: pick([undefined, { loggedIn: true, dnsName: "box.ts.net" }, { loggedIn: false }]), tlsReady, noticeAck };
    const where = `seed ${SEED} case ${i}: ${JSON.stringify({ cfg, env: { ...env, hostInterfaces: hostInterfaces.map((h) => h.address) } })}`;
    const r = planListeners(cfg, env);
    if (!r.ok) { refused++; assert.ok(r.refusals.length > 0, where); assert.equal("listeners" in r, false, `${where}: a refused plan carries no listeners`); assert.equal(publish, "network", `${where}: only network mode can be refused`); continue; }
    const loop = r.listeners[0]!; assert.deepEqual([loop.id, loop.address, loop.protocol, loop.tlsOnly, loop.port], ["api-loopback", "127.0.0.1", "http", false, 7000], where);
    const extra = r.listeners.slice(1);
    if (publish !== "network") { assert.equal(extra.length, 0, `${where}: a non-network mode opened ${extra.length} more listener(s)`); continue; }
    assert.equal(extra.length, 1, where); const l = extra[0]!; opened++;
    assert.ok(tlsReady === true && noticeAck !== undefined, `${where}: opened without a certificate or without the confirmed notice`);
    assert.deepEqual([l.id, l.protocol, l.tlsOnly], ["api-tls", "https", true], where); assert.notEqual(l.port, 7000, `${where}: shares the API port`); assert.ok(l.port >= 1024, where);
    const ip = parseIp(l.address); assert.ok(ip, `${where}: bound to something that is not an address: ${l.address}`); const scope = addressScope(ip!);
    assert.ok(scope !== "loopback", `${where}: the TLS listener is on loopback`);
    const external = hostInterfaces.filter((h) => !h.internal).map((h) => parseIp(h.address)).filter((p): p is NonNullable<typeof p> => p !== undefined);
    if (scope === "unspecified") assert.ok(allowPublic === true || !external.some((p) => addressScope(p) === "public"), `${where}: a wildcard bind reaches a public interface without confirmation`);
    else { assert.ok(hostInterfaces.some((h) => { const p = parseIp(h.address); return p !== undefined && formatIp(p) === formatIp(ip!); }), `${where}: bound an address this machine does not have`); if (scope === "public") assert.equal(allowPublic, true, `${where}: a public address without confirmation`); }
    assert.equal(l.allowSubnets !== undefined, cfg.allowSubnets.length > 0, `${where}: the allow-list travels with the TLS listener`);
  }
  assert.ok(opened > 100 && refused > 300, `seed ${SEED}: ${opened} opened, ${refused} refused; both outcomes must be exercised`);
});

test("the scenarios people actually have: local only, a home LAN, a LAN with a public uplink, a public address, a VPN", () => {
  const ack = { by: "admin", at: 1, version: 1 }; const base = { apiPort: 7000, tlsPort: 8443, tlsReady: true, noticeAck: ack };
  const lan: HostInterface[] = [{ name: "lo", address: "127.0.0.1", internal: true }, { name: "eth0", address: "192.168.1.20" }];
  const uplink: HostInterface[] = [...lan, { name: "ppp0", address: "203.0.113.9" }];
  const codes = (r: ReturnType<typeof planListeners>) => (r.ok ? r.warnings.map((w) => w.code) : [...r.refusals, ...r.warnings].map((n) => n.code));
  const net = (bind: RemoteConfig["bind"]): RemoteConfig => ({ publish: "network", tls: "self-signed", bind, allowSubnets: [] });
  assert.equal(planListeners({ ...DEFAULT_REMOTE_CONFIG, publish: "local" }, { ...base, hostInterfaces: uplink }).ok, true);
  const homeAll = planListeners(net({}), { ...base, hostInterfaces: lan }); assert.ok(homeAll.ok && homeAll.listeners[1]!.address === "0.0.0.0", "all interfaces of a LAN-only host are acceptable once network mode is confirmed");
  const homeOne = planListeners(net({ address: "192.168.1.20" }), { ...base, hostInterfaces: lan }); assert.ok(homeOne.ok && homeOne.listeners[1]!.address === "192.168.1.20");
  assert.deepEqual(codes(planListeners(net({}), { ...base, hostInterfaces: uplink })), ["network-public-interface-unconfirmed"], "a public uplink behind the wildcard needs the explicit confirmation");
  assert.deepEqual(codes(planListeners(net({ allowPublicInterface: true }), { ...base, hostInterfaces: uplink })), ["network-public-interface-confirmed"]);
  assert.deepEqual(codes(planListeners(net({ address: "203.0.113.9" }), { ...base, hostInterfaces: uplink })), ["network-public-interface-unconfirmed"]);
  assert.deepEqual(codes(planListeners(net({ address: "192.168.1.20" }), { ...base, hostInterfaces: uplink })), [], "binding only the private address of a host that also has a public one is fine");
  assert.deepEqual(codes(planListeners(net({ address: "127.0.0.1" }), { ...base, hostInterfaces: lan })), ["network-bind-loopback"]);
  assert.deepEqual(codes(planListeners(net({ address: "::ffff:127.0.0.1" }), { ...base, hostInterfaces: lan })), ["network-bind-loopback"], "a mapped loopback is loopback");
  assert.deepEqual(codes(planListeners(net({ address: "10.9.9.9" }), { ...base, hostInterfaces: lan })), ["network-bind-unknown-interface"]);
  const vpn: HostInterface[] = [...lan, { name: "utun3", address: "100.101.102.103" }]; assert.equal(planListeners(net({}), { ...base, hostInterfaces: vpn }).ok, true, "a CGNAT/VPN address is not public");
  assert.deepEqual(codes(planListeners(net({}), { ...base, hostInterfaces: lan, tlsReady: false, noticeAck: undefined })).sort(), ["network-needs-notice-confirmation", "network-needs-tls"]);
  assert.deepEqual(codes(planListeners(net({ port: 7000 }), { ...base, hostInterfaces: lan })), ["network-port-clash"]);
});

test("parseRemoteConfig survives hostile configuration: extremely deep nesting is a finding, not a stack overflow; huge subnet lists are linear work; prototype keys are unknown keys", () => {
  let deep: unknown = "x"; for (let i = 0; i < 50_000; i++) deep = [deep];
  let r; try { r = parseRemoteConfig({ publish: "local", extra: deep }); } catch (e) { assert.fail(`threw ${(e as Error).constructor.name} on 50 000 levels: ${(e as Error).message}`); }
  assert.equal(r.ok, false);
  let deepObj: Record<string, unknown> = { leaf: true }; for (let i = 0; i < 50_000; i++) deepObj = { n: deepObj };
  assert.doesNotThrow(() => parseRemoteConfig({ bind: { address: "10.0.0.1" }, extra: deepObj }));
  const many = Array.from({ length: 30_000 }, (_, i) => `10.${(i >> 8) & 255}.${i & 255}.0/24`); const t0 = Date.now(); const big = parseRemoteConfig({ publish: "local", allowSubnets: many });
  assert.ok(Date.now() - t0 < 1000, `30 000 subnets took ${Date.now() - t0} ms (quadratic de-duplication)`); assert.ok(big.ok && big.config.allowSubnets.length === 30_000);
  const dup = parseRemoteConfig({ publish: "local", allowSubnets: [...many, ...many] }); assert.ok(dup.ok && dup.config.allowSubnets.length === 30_000, "duplicates collapse");
  for (const text of ['{"__proto__":{"publish":"network"}}', '{"constructor":{"prototype":{}}}', '{"bind":{"__proto__":{"address":"0.0.0.0"}}}']) { const p = parseRemoteConfig(JSON.parse(text)); assert.equal(p.ok, false, text); assert.equal(({} as Record<string, unknown>).publish, undefined); }
  for (const bad of [null, 5, "network", [], true, () => 1]) assert.equal(parseRemoteConfig(bad).ok, false);
  for (const port of [0, 1023, 65536, 8443.5, NaN, Infinity, -1, "8443", null, [], {}, 1e3]) assert.equal(parseRemoteConfig({ publish: "network", bind: { port } }).ok, false, String(port));
  for (const port of [1024, 8443, 65535]) assert.equal(parseRemoteConfig({ publish: "network", bind: { port } }).ok, true, String(port));
  for (const address of ["localhost", "example.com", "0.0.0.0/0", "[::1]", " 10.0.0.1", "10.0.0.1:8443", "", 5, null, {}]) assert.equal(parseRemoteConfig({ publish: "network", bind: { address } }).ok, false, JSON.stringify(address));
});

// ---- Tailscale -----------------------------------------------------------------------------------------------------

function fakeExec(answers: Record<string, ExecResult | Error | ((args: readonly string[]) => ExecResult | Error)>): ExecPort {
  return { async run(file, args) { const a = answers[`${file} ${args[0]}`] ?? answers[file] ?? Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); const v = typeof a === "function" ? a(args) : a; if (v instanceof Error) throw v; return v; } };
}
const ok = (stdout: string, code: number | null = 0): ExecResult => ({ code, stdout, stderr: "" });

test("1500 seeded broken answers from the Tailscale CLI: always one of the five documented states, consistent fields, no exception; a killed or silent CLI is 'daemon-down'", async () => {
  const SEED = 0x7A115CA1E; const rand = mulberry32(SEED); const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const junk = (): unknown => pick<() => unknown>([() => null, () => 0, () => -1, () => "", () => "x".repeat(1000), () => true, () => [], () => [1, 2], () => ({}), () => ({ a: { b: [] } }), () => ({ nested: { deep: Array.from({ length: 30 }, () => ({})) } }), () => 1e308, () => ({ length: 5 })])();
  const status = (): string => {
    const shape = Math.floor(rand() * 9);
    if (shape === 0) return Buffer.from(Array.from({ length: Math.floor(rand() * 200) }, () => Math.floor(rand() * 256))).toString("latin1");
    if (shape === 1) return JSON.stringify(junk()); if (shape === 2) return '{"BackendState":'; if (shape === 3) return "";
    const o: Record<string, unknown> = {}; if (rand() < 0.8) o.BackendState = pick(["Running", "NeedsLogin", "NeedsMachineAuth", "Stopped", "Starting", "", 7, null, [], {}, "running"]);
    if (rand() < 0.7) o.Self = pick([{ DNSName: pick(["box.tail1.ts.net.", "box.tail1.ts.net", ".", "", 5, null, {}, "x".repeat(300)]) }, junk(), null]);
    if (rand() < 0.7) o.CurrentTailnet = pick([{ Name: pick(["acme", "", 5, null]), MagicDNSSuffix: pick(["tail1.ts.net", "", 5, {}]) }, junk(), null]);
    if (rand() < 0.3) o.MagicDNSSuffix = junk(); return JSON.stringify(o);
  };
  const states = new Set(["not-installed", "daemon-down", "needs-login", "stopped", "running"]); const seen = new Map<string, number>();
  for (let i = 0; i < 1500; i++) {
    const code = pick<number | null>([0, 0, 0, 0, 1, 2, 127, null]); const stderr = pick(["", "boom", "x".repeat(2000)]);
    const exec = fakeExec({ tailscale: (args) => (args[0] === "version" ? ok(pick(["1.2.3\n", "", "\n\n", "x".repeat(5000)])) : { code, stdout: status(), stderr } as ExecResult) });
    let s; try { s = await detectTailscale(exec, ["tailscale"]); } catch (e) { assert.fail(`seed ${SEED} case ${i}: threw ${(e as Error).message}`); }
    const where = `seed ${SEED} case ${i}: ${JSON.stringify(s).slice(0, 200)}`; seen.set(s.state, (seen.get(s.state) ?? 0) + 1);
    assert.ok(states.has(s.state), where); assert.equal(s.loggedIn, s.state === "running", where);
    if (s.magicDnsName !== undefined) assert.ok(typeof s.magicDnsName === "string" && s.magicDnsName !== "" && !s.magicDnsName.endsWith("."), where);
    for (const k of ["tailnetName", "magicDnsSuffix", "version", "message"] as const) if (s[k] !== undefined) assert.ok(typeof s[k] === "string" && s[k] !== "", `${where}: ${k}`);
    if (s.state !== "running") for (const k of ["tailnetName", "magicDnsName", "magicDnsSuffix"] as const) assert.equal(s[k], undefined, `${where}: ${k} on a state that is not running`);
    if (code !== 0) assert.equal(s.state, "daemon-down", where);
  }
  for (const state of states) if (state !== "not-installed") assert.ok((seen.get(state) ?? 0) > 0, `seed ${SEED}: state ${state} was never produced; the generator is too narrow`);
  assert.equal((await detectTailscale(fakeExec({}), ["tailscale", "/opt/homebrew/bin/tailscale"])).state, "not-installed");
  assert.deepEqual(await detectTailscale(fakeExec({}), []), { state: "not-installed", loggedIn: false, message: "no Tailscale CLI found" });
});

test("serve status: any JSON shape is read without throwing; only a boolean true under AllowFunnel is a funnel; deep or huge documents are fine", () => {
  const SEED = 0x5E4E; const rand = mulberry32(SEED);
  for (let i = 0; i < 800; i++) {
    const t = Buffer.from(Array.from({ length: Math.floor(rand() * 120) }, () => Math.floor(rand() * 256))).toString("latin1");
    assert.doesNotThrow(() => parseServeStatus(t), `seed ${SEED} case ${i}`);
    for (const text of [JSON.stringify({ AllowFunnel: { a: rand() < 0.5 } }), JSON.stringify({ Web: { x: { Handlers: { "/": { Proxy: rand() < 0.5 ? "http://127.0.0.1:1" : 5 } } } } }), JSON.stringify({ AllowFunnel: [true] }), JSON.stringify({ AllowFunnel: "true" })]) { const r = parseServeStatus(text); assert.ok(r === undefined || typeof r.funnelActive === "boolean"); }
  }
  assert.equal(parseServeStatus(JSON.stringify({ AllowFunnel: { "h:443": true } }))?.funnelActive, true); assert.equal(parseServeStatus(JSON.stringify({ AllowFunnel: { "h:443": "true", "g:443": 1 } }))?.funnelActive, false);
  for (const n of [5_000, 200_000]) { const text = `${'{"AllowFunnel":{},"Web":{"k":'.repeat(n)}{}${"}}".repeat(n)}`; assert.doesNotThrow(() => parseServeStatus(text), `${n} levels`); }
});

test("a plan never carries a funnel in any argument, in any letter case, and the serve target is always the loopback port; a refused plan runs nothing", async () => {
  for (const port of [1, 80, 7000, 65535]) for (const httpsPort of [undefined, 443, 8443, 10000] as const) {
    const cmds = planServe({ cli: "tailscale", port, ...(httpsPort ? { httpsPort } : {}) }); assert.doesNotThrow(() => assertNoFunnel(cmds));
    assert.deepEqual(cmds[0]!.args, ["serve", "--bg", `--https=${httpsPort ?? 443}`, `http://127.0.0.1:${port}`]);
  }
  for (const port of [0, -1, 65536, 1.5, NaN, Infinity, "7000" as never]) assert.throws(() => planServe({ cli: "tailscale", port }), /port must be/);
  for (const hp of [80, 444, 8080, 0, "443" as never]) assert.throws(() => planServe({ cli: "tailscale", port: 7000, httpsPort: hp as never }), /httpsPort/);
  let ran = 0; const exec: ExecPort = { async run() { ran++; return ok(""); } };
  for (const bad of [{ file: "tailscale", args: ["funnel", "on"] }, { file: "tailscale", args: ["serve", "--FUNNEL=on"] }, { file: "/opt/Funnel/tailscale", args: ["status"] }, { file: "tailscale", args: ["status", "x", "Funnel"] }]) {
    await assert.rejects(runServePlan(exec, [{ file: "tailscale", args: ["serve", "status"] }, bad]), /refusing a funnel command/); assert.equal(ran, 0, "nothing ran before the check passed");
  }
  assert.deepEqual(await detectServe(fakeExec({ tailscale: ok('{"AllowFunnel":{"h:443":true}}') }), "tailscale"), { funnelActive: true, proxies: [] });
  assert.equal(await detectServe(fakeExec({ tailscale: ok("junk{") }), "tailscale"), undefined); assert.equal(await detectServe(fakeExec({ tailscale: ok("", 1) }), "tailscale"), undefined);
});

// ---- the security checks -------------------------------------------------------------------------------------------

test("firstAidChecks over the whole product of states (432 cases) against the documented rules: exactly these warnings, in this order", () => {
  const NOW = 1_800_000_000_000; const acks = [undefined, { by: "a", at: 1, version: SECURITY_NOTICE_VERSION }, { by: "a", at: 1, version: SECURITY_NOTICE_VERSION + 1 }, { by: "a", at: 1 }];
  const certs: Array<number | undefined> = [undefined, NOW - 1, NOW, NOW + 29 * DAY, NOW + CERT_WARN_DAYS * DAY, NOW + CERT_WARN_DAYS * DAY + 1];
  let cases = 0;
  for (const publish of ["local", "tailnet", "network"] as const) for (const subnets of [[], ["10.0.0.0/8"]]) for (const tlsReady of [true, false, undefined]) for (const noticeAck of acks) for (const certNotAfter of certs) for (const funnelActive of [true, false, undefined]) {
    cases++; const cfg: RemoteConfig = { ...DEFAULT_REMOTE_CONFIG, publish, allowSubnets: subnets }; const got = firstAidChecks(cfg, { now: NOW, certNotAfter, noticeAck, funnelActive, tlsReady }).map((e) => e.id);
    const want: string[] = []; if (funnelActive) want.push("remote.funnel-active");
    if (publish === "network") {
      want.push("remote.network-on"); if (noticeAck?.version !== SECURITY_NOTICE_VERSION) want.push("remote.notice-unconfirmed"); if (tlsReady === false) want.push("remote.tls-not-ready");
      if (certNotAfter !== undefined) { const left = certNotAfter - NOW; if (left < 0) want.push("remote.cert-expired"); else if (left <= CERT_WARN_DAYS * DAY) want.push("remote.cert-expiring"); }
      if (subnets.length === 0) want.push("remote.allowlist-empty");
    }
    assert.deepEqual(got, want, JSON.stringify({ publish, subnets, tlsReady, noticeAck, certNotAfter: certNotAfter === undefined ? undefined : certNotAfter - NOW, funnelActive }));
    for (const e of firstAidChecks(cfg, { now: NOW, certNotAfter, noticeAck, funnelActive, tlsReady })) { assert.equal(e.severity, "warn"); assert.ok(e.message.length > 20); }
  }
  assert.equal(cases, 3 * 2 * 3 * 4 * 6 * 3);
  assert.equal(firstAidChecks({ ...DEFAULT_REMOTE_CONFIG, publish: "network" }, { now: NOW, certNotAfter: NOW + 3 * DAY + 1, noticeAck: acks[1], tlsReady: true }).find((e) => e.id === "remote.cert-expiring")!.message, "The TLS certificate expires in 3 days.");
});

test("a certificate expiry that is not a number is never read as 'fine': the network checks report the certificate as unusable", () => {
  const NOW = 1_800_000_000_000; const cfg: RemoteConfig = { ...DEFAULT_REMOTE_CONFIG, publish: "network", allowSubnets: ["10.0.0.0/8"] };
  for (const bad of [NaN, Infinity, -Infinity]) { const ids = firstAidChecks(cfg, { now: NOW, certNotAfter: bad, noticeAck: { by: "a", at: 1, version: SECURITY_NOTICE_VERSION }, tlsReady: true }).map((e) => e.id); assert.ok(ids.includes("remote.tls-not-ready") || ids.includes("remote.cert-expired"), `${bad}: ${ids}`); }
});

test("the security notice: only an explicit true by a named person for this version; outdated confirmations never satisfy it; the notice is shown for network mode only", () => {
  const good = { confirmed: true, by: "  admin ", at: 1_800_000_000_000 }; const r = confirmSecurityNotice(good); assert.ok(r.ok && r.ack.by === "admin" && r.ack.version === SECURITY_NOTICE_VERSION);
  for (const confirmed of [false, "true", 1, "yes", undefined, null, {}, []]) assert.equal(confirmSecurityNotice({ ...good, confirmed }).ok, false, JSON.stringify(confirmed));
  for (const by of ["", "   ", undefined, null, 5, {}, [], "\u0000", "x".repeat(10_000)]) assert.equal(confirmSecurityNotice({ ...good, by }).ok, false, JSON.stringify(by)?.slice(0, 20));
  for (const at of [NaN, Infinity, -Infinity, "1", undefined, null, {}]) assert.equal(confirmSecurityNotice({ ...good, at }).ok, false, String(at));
  for (const version of [0, 2, "1", null, NaN]) assert.equal(confirmSecurityNotice({ ...good, version }).ok, false, String(version));
  for (const input of [null, undefined, 5, "x", [], true]) assert.equal(confirmSecurityNotice(input).ok, false);
  const cfg = (publish: RemoteConfig["publish"]): RemoteConfig => ({ ...DEFAULT_REMOTE_CONFIG, publish });
  assert.equal(noticeNeeded(cfg("network"), undefined), true); assert.equal(noticeNeeded(cfg("network"), { by: "a", at: 1 }), true); assert.equal(noticeNeeded(cfg("network"), { by: "a", at: 1, version: SECURITY_NOTICE_VERSION - 1 }), true);
  assert.equal(noticeNeeded(cfg("network"), { by: "a", at: 1, version: SECURITY_NOTICE_VERSION }), false); assert.equal(noticeNeeded(cfg("local"), undefined), false); assert.equal(noticeNeeded(cfg("tailnet"), undefined), false);
  assert.deepEqual(securityNoticeItems(cfg("local")), []); assert.deepEqual(securityNoticeItems(cfg("tailnet")), []);
  const codes = securityNoticeItems(cfg("network")).map((i) => i.code); assert.deepEqual(codes, ["reachable-from-network", "pairing-required", "tls-inspection", "allow-list", "allow-list-empty", "never-public"]);
  assert.ok(!securityNoticeItems({ ...cfg("network"), allowSubnets: ["10.0.0.0/8"] }).some((i) => i.code === "allow-list-empty"));
});

test("allow-list at the socket: every address spelling a dual-stack listener reports, scope ids, and every address that is not one", () => {
  const list = compileAllowlist(["192.168.0.0/16", "fd00::/8", "fe80::/10"]); assert.ok(list.ok); const l = list.list;
  const admits = (address: string | undefined) => admitSocket(l, { remoteAddress: address });
  for (const a of ["192.168.1.1", "::ffff:192.168.1.1", "::FFFF:C0A8:101", "fd00::1", "FD00::1", "fe80::1%eth0", "fe80::abcd%en0"]) assert.equal(admits(a), true, a);
  for (const a of ["192.169.0.1", "::ffff:8.8.8.8", "2001:db8::1", "10.0.0.1", "fec0::1", "", "unknown", "192.168.1", "192.168.1.1.1", "192.168.001.001", "::ffff:192.168.1", "192.168.1.1%eth0", undefined, "  192.168.1.1", "192.168.1.1\n"]) assert.equal(admits(a), false, JSON.stringify(a));
  const empty = compileAllowlist([]); assert.ok(empty.ok); assert.equal(admitSocket(empty.list, { remoteAddress: "anything" }), true, "an empty list admits everyone"); assert.equal(admitSocket(empty.list, {}), true);
  const SEED = 0xA110; const rand = mulberry32(SEED);
  for (let i = 0; i < 1500; i++) { const t = Buffer.from(Array.from({ length: Math.floor(rand() * 40) }, () => Math.floor(rand() * 256))).toString("latin1"); assert.doesNotThrow(() => l.allows(t), `seed ${SEED} case ${i}`); assert.equal(typeof l.allows(t), "boolean"); }
  for (const bad of [5, null, {}, [], undefined] as unknown[]) assert.doesNotThrow(() => l.allows(bad as string), `allows(${String(bad)}) must be false, never a TypeError`);
  for (const bad of [5, null, {}, [], undefined] as unknown[]) assert.equal(l.allows(bad as string), false);
});
