import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAddress, parseCidr, cidrContainsPublic } from "../../../src/tools/web/ip.ts";
import { formatAddress } from "../../../src/tools/web/ip-display.ts";

const show = (s: string) => formatAddress(parseAddress(s)!);

describe("ip-display: formatAddress", () => {
  it("prints IPv4 as a dotted quad", () => {
    assert.equal(show("8.8.8.0"), "8.8.8.0");
    assert.equal(show("0.0.0.0"), "0.0.0.0");
  });
  it("prints an IPv4-mapped address in its IPv4 form", () => {
    assert.equal(show("::ffff:100:0"), "1.0.0.0");
    assert.equal(show("::ffff:8.8.8.8"), "8.8.8.8");
  });
  it("prints other IPv6 addresses canonically: lower case, longest zero run (first on a tie) as ::", () => {
    assert.equal(show("2000:0:0:0:0:0:0:0"), "2000::");
    assert.equal(show("64:ff9b::100:0"), "64:ff9b::100:0");
    assert.equal(show("2001:DB8:0:0:1:0:0:1"), "2001:db8::1:0:0:1");
    assert.equal(show("2001:db8:0:1:1:1:1:1"), "2001:db8:0:1:1:1:1:1");
    assert.equal(show("1:0:2:3:4:5:6:7"), "1:0:2:3:4:5:6:7");
    assert.equal(show("::"), "::");
    assert.equal(show("::1"), "::1");
  });
  it("renders the witness of a range: the IPv4 form for ranges that reach IPv4 through ::ffff:0:0/96, canonical IPv6 otherwise", () => {
    const witness = (cidr: string) => formatAddress(cidrContainsPublic(parseCidr(cidr)!)!);
    assert.equal(witness("::/0"), "1.0.0.0");
    assert.equal(witness("0.0.0.0/0"), "1.0.0.0");
    assert.equal(witness("2000::/3"), "2000::");
    assert.equal(witness("64:ff9b::/96"), "64:ff9b::100:0");
  });
});
