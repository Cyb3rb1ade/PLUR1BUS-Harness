import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAddress, classifyAddress, inCidr, parseCidr } from "../../../src/tools/web/ip.ts";

const verdict = (s: string) => {
  const a = parseAddress(s);
  assert.ok(a, `parseable: ${s}`);
  return classifyAddress(a);
};

describe("ip: refused addresses", () => {
  const refused: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["0.0.0.0", "unspecified"],
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "link-local"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "shared-address-space"],
    ["100.100.100.200", "shared-address-space"],
    ["192.0.0.1", "reserved"],
    ["198.18.0.1", "reserved"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fd00::1", "private"],
    ["fd00:ec2::254", "private"],
    ["fc00::1", "private"],
    ["fe80::1", "link-local"],
    ["febf::1", "link-local"],
    ["ff02::1", "multicast"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:169.254.169.254", "link-local"],
    ["::ffff:10.1.2.3", "private"],
    ["0:0:0:0:0:ffff:192.168.0.1", "private"],
    ["::127.0.0.1", "reserved"],
    ["64:ff9b::7f00:1", "loopback"],
    ["64:ff9b::a9fe:a9fe", "link-local"],
    ["2002:7f00:1::1", "loopback"],
    ["2002:a9fe:a9fe::1", "link-local"],
    ["2001:db8::1", "reserved"],
    ["2001::1", "reserved"],
    ["100::1", "reserved"],
  ];
  for (const [addr, why] of refused) {
    it(`${addr} -> ${why}`, () => {
      const v = verdict(addr);
      assert.equal(v.public, false);
      assert.equal(v.reason, why);
    });
  }
});

describe("ip: public addresses", () => {
  for (const addr of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
    it(addr, () => assert.equal(verdict(addr).public, true));
  }
});

describe("ip: legacy IPv4 spellings", () => {
  const cases: Array<[string, string]> = [
    ["2130706433", "127.0.0.1"], // decimal
    ["017700000001", "127.0.0.1"], // octal
    ["0x7f000001", "127.0.0.1"], // hex
    ["0x7f.0.0.1", "127.0.0.1"], // mixed hex
    ["0177.0.0.1", "127.0.0.1"], // octal first octet
    ["127.1", "127.0.0.1"], // short form
    ["127.0.1", "127.0.0.1"],
    ["0", "0.0.0.0"],
    ["2852039166", "169.254.169.254"],
    ["0xa9fea9fe", "169.254.169.254"],
    ["0251.0376.0251.0376", "169.254.169.254"],
    ["3232235777", "192.168.1.1"],
  ];
  for (const [spelling, dotted] of cases) {
    it(`${spelling} is ${dotted}`, () => {
      const a = parseAddress(spelling);
      assert.ok(a);
      assert.equal(a.family, 4);
      assert.equal(Array.from(a.bytes).join("."), dotted);
    });
  }
  it("rejects out-of-range and malformed spellings", () => {
    for (const bad of ["256.1.1.1", "4294967296", "1.2.3.4.5", "08.0.0.1", "0x", "1..2", "", "example.com", "1.2.3.x", "-1"]) {
      assert.equal(parseAddress(bad), null, bad);
    }
  });
});

describe("ip: IPv6 parsing", () => {
  it("accepts brackets and compressed forms", () => {
    assert.equal(parseAddress("[::1]")?.family, 6);
    assert.equal(parseAddress("2001:db8:0:0:0:0:0:1")?.family, 6);
  });
  it("refuses zone ids rather than guessing", () => {
    assert.equal(parseAddress("fe80::1%eth0"), null);
  });
  it("rejects malformed", () => {
    for (const bad of [":::", "1::2::3", "12345::1", "g::1", "1:2:3:4:5:6:7:8:9", "::ffff:1.2.3"]) assert.equal(parseAddress(bad), null, bad);
  });
});

describe("ip: CIDR allowlist matching", () => {
  it("matches v4 and v6 and never crosses families", () => {
    const c4 = parseCidr("127.0.0.0/8");
    const c6 = parseCidr("fd00::/8");
    assert.ok(c4 && c6);
    assert.equal(inCidr(parseAddress("127.9.9.9")!, c4), true);
    assert.equal(inCidr(parseAddress("128.0.0.1")!, c4), false);
    assert.equal(inCidr(parseAddress("fd12::1")!, c6), true);
    assert.equal(inCidr(parseAddress("fe00::1")!, c6), false);
    assert.equal(inCidr(parseAddress("::1")!, c4), false);
  });
  it("a bare address is a /32 or /128; junk is refused", () => {
    assert.ok(parseCidr("100.64.1.2"));
    assert.equal(inCidr(parseAddress("100.64.1.3")!, parseCidr("100.64.1.2")!), false);
    for (const bad of ["10.0.0.0/33", "10.0.0.0/-1", "nope/8", "::/129", "10.0.0.0/8/8"]) assert.equal(parseCidr(bad), null, bad);
  });
});
