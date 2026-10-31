import { it } from "node:test";
import assert from "node:assert/strict";
import { createEgress } from "../../src/egress/service.ts";

it("A2A admits explicitly listed Tailnet pins while keeping ordinary egress and metadata closed", async () => {
  let addresses = ["100.64.0.9"];
  let hosts = ["node.example"];
  const e = createEgress({ config: () => ({ allowHosts: hosts, allowPorts: [443], allowLoopback: false }), resolver: async () => addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 })) });
  const url = "https://node.example/a2a";
  assert.equal((await e.decide(url)).allowed, false);
  assert.equal((await e.decide(url, { purpose: "a2a" })).allowed, true);
  addresses = ["fd7a:115c:a1e0::9"];
  assert.equal((await e.decide(url, { purpose: "a2a" })).allowed, true);
  for (const address of ["10.0.0.1", "169.254.169.254", "100.100.100.200", "127.0.0.1"]) {
    addresses = ["100.64.0.9", address];
    assert.equal((await e.decide(url, { purpose: "a2a" })).allowed, false, address);
  }
  addresses = ["100.64.0.9"]; hosts = ["*"];
  assert.equal((await e.decide(url, { purpose: "a2a" })).allowed, false);
});
