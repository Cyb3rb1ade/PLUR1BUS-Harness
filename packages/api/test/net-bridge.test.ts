import test from "node:test";
import assert from "node:assert/strict";
import { formatIp, formatCidr, parseCidr as parseAllowCidr, parseIp } from "../../remote-access/src/index.ts";
import { cidrContainsPublic, formatRange, formatWitness, parseCidr } from "../src/net-bridge.ts";
import { allowlistPublic } from "../src/remote-runtime.ts";

// The notice text for an address (`formatWitness`, shared with the web UI) and the Doctor row's range (`formatCidr` of
// the allow-list) print IPv6 through two copies of the same compression; they must not drift.
const V6 = ["::", "::1", "2000::", "2000:0:0:0:0:0:0:0", "64:ff9b::100:0", "2001:DB8:0:0:1:0:0:1", "2001:db8:0:1:1:1:1:1", "1:0:2:3:4:5:6:7",
  "1:0:0:2:0:0:3:4", "1:0:0:0:2:0:0:3", "fd00::", "fe80::1", "2002:a00::", "ff02:0:0:0:0:0:0:1", "0:0:1:0:0:0:0:0", "1::"];

test("formatWitness prints IPv6 exactly as the allow-list's formatIp does", () => {
  for (const text of V6) {
    const ours = parseCidr(`${text}/128`)!; const theirs = parseIp(text)!;
    assert.equal(theirs.family, 6, text);
    assert.equal(formatWitness({ family: ours.family, bytes: ours.bytes }), formatIp(theirs), text);
  }
});

test("formatRange names a range as the allow-list's formatCidr does, so the Doctor row and the UI notice agree", () => {
  for (const text of [...V6.map(a => `${a}/128`), "2000::/3", "::/0", "fd00::/8", "2001:db8::1/32", "2001:db8:ffff::/47", "64:ff9b::/96", "::ffff:8.8.8.0/120", "::ffff:8.8.8.8/104",
    "::ffff:0:0/96", "::ffff:0:0/80", "8.8.8.8/24", "8.8.8.8", "0.0.0.0/0", "172.16.0.0/11", "10.200.3.4/9", "8.8.8.8/31"]) {
    assert.equal(formatRange(parseCidr(text)!), formatCidr(parseAllowCidr(text)!), text);
  }
});

test("allowlistPublic names a range in its normalised form whatever was configured", () => {
  assert.deepEqual(allowlistPublic(["8.8.8.8/24", "::ffff:9.9.9.0/120"]).map(r => r.cidr), ["8.8.8.0/24", "9.9.9.0/24"]);
  assert.ok(cidrContainsPublic(parseCidr("8.8.8.8/24")!));
});
