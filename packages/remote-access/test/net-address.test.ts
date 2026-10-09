import { test } from "node:test";
import assert from "node:assert/strict";
import { addressScope, cidrContains, formatCidr, parseCidr, parseIp } from "../src/net-address.ts";

test("parseIp: IPv4, IPv6 forms, zone ids and IPv4-mapped normalisation", () => {
  assert.deepEqual(parseIp("10.1.2.3"), { family: 4, bytes: Uint8Array.from([10, 1, 2, 3]) });
  assert.deepEqual(parseIp("::ffff:10.1.2.3"), { family: 4, bytes: Uint8Array.from([10, 1, 2, 3]) });
  assert.deepEqual(parseIp("::ffff:0a01:0203"), { family: 4, bytes: Uint8Array.from([10, 1, 2, 3]) });
  const v6 = parseIp("fe80::1%en0");
  assert.equal(v6?.family, 6);
  assert.equal(v6?.bytes.length, 16);
  assert.equal(v6?.bytes[0], 0xfe);
  assert.equal(v6?.bytes[15], 1);
  assert.equal(parseIp("2001:db8::")?.bytes[3], 0xb8);
  for (const bad of ["", "1.2.3", "1.2.3.256", "01.2.3.4", "::g", "1:2:3:4:5:6:7:8:9", "example.com", "10.0.0.1/8"]) {
    assert.equal(parseIp(bad), undefined, bad);
  }
});

test("parseCidr: masks host bits, validates prefixes, normalises IPv4-mapped ranges", () => {
  assert.equal(formatCidr(parseCidr("10.1.2.3/8")!), "10.0.0.0/8");
  assert.equal(formatCidr(parseCidr("192.168.1.0/24")!), "192.168.1.0/24");
  assert.equal(formatCidr(parseCidr("fd00::1/8")!), "fd00::/8");
  assert.equal(formatCidr(parseCidr("::ffff:10.0.0.0/104")!), "10.0.0.0/8");
  assert.equal(formatCidr(parseCidr("203.0.113.7")!), "203.0.113.7/32");
  assert.equal(formatCidr(parseCidr("fd00::1")!), "fd00::1/128");
  for (const bad of ["10.0.0.0/33", "10.0.0.0/-1", "10.0.0.0/x", "fd00::/129", "nope/8", "10.0.0.0/8/8", "/8"]) {
    assert.equal(parseCidr(bad), undefined, bad);
  }
});

test("cidrContains: IPv4, IPv6, IPv4-mapped clients, family mismatch", () => {
  const lan = parseCidr("192.168.10.0/24")!;
  assert.equal(cidrContains(lan, parseIp("192.168.10.77")!), true);
  assert.equal(cidrContains(lan, parseIp("192.168.11.1")!), false);
  assert.equal(cidrContains(lan, parseIp("::ffff:192.168.10.77")!), true, "dual-stack socket reports mapped addresses");
  const ula = parseCidr("fd12:3456::/32")!;
  assert.equal(cidrContains(ula, parseIp("fd12:3456:1::9")!), true);
  assert.equal(cidrContains(ula, parseIp("fd12:3457::1")!), false);
  assert.equal(cidrContains(ula, parseIp("192.168.10.77")!), false);
  assert.equal(cidrContains(parseCidr("0.0.0.0/0")!, parseIp("8.8.8.8")!), true);
  assert.equal(cidrContains(parseCidr("0.0.0.0/0")!, parseIp("2001:db8::1")!), false);
  assert.equal(cidrContains(parseCidr("10.0.0.5/32")!, parseIp("10.0.0.5")!), true);
  assert.equal(cidrContains(parseCidr("10.0.0.5/32")!, parseIp("10.0.0.6")!), false);
  // a mapped-range rule written the IPv6 way matches mapped clients
  assert.equal(cidrContains(parseCidr("::ffff:10.0.0.0/104")!, parseIp("::ffff:10.9.9.9")!), true);
});

test("addressScope classifies interface addresses", () => {
  const scope = (s: string) => addressScope(parseIp(s)!);
  assert.equal(scope("127.0.0.1"), "loopback");
  assert.equal(scope("::1"), "loopback");
  assert.equal(scope("10.4.5.6"), "private");
  assert.equal(scope("172.16.0.1"), "private");
  assert.equal(scope("172.31.255.1"), "private");
  assert.equal(scope("172.32.0.1"), "public");
  assert.equal(scope("192.168.0.9"), "private");
  assert.equal(scope("fd00::5"), "private");
  assert.equal(scope("169.254.1.1"), "link-local");
  assert.equal(scope("fe80::1"), "link-local");
  assert.equal(scope("100.64.0.1"), "cgnat");
  assert.equal(scope("100.127.255.255"), "cgnat");
  assert.equal(scope("100.128.0.1"), "public");
  assert.equal(scope("0.0.0.0"), "unspecified");
  assert.equal(scope("::"), "unspecified");
  assert.equal(scope("203.0.113.7"), "public");
  assert.equal(scope("2001:db8::1"), "public");
  assert.equal(scope("::ffff:10.0.0.1"), "private");
});
