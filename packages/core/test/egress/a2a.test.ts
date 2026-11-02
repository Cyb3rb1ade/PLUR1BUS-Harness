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

it("A2A requires an exact name or IP before DNS for public and shared-address destinations", async () => {
  let lookups = 0;
  let hosts = ["*.example"];
  let address = "100.64.0.9";
  const e = createEgress({
    config: () => ({ allowHosts: hosts, allowPorts: [443], allowLoopback: false }),
    resolver: async () => { lookups++; return [{ address, family: 4 }]; },
  });
  for (const pin of ["100.64.0.9", "93.184.216.34"]) {
    address = pin;
    const before = lookups;
    assert.equal((await e.decide("https://node.example/a2a", { purpose: "a2a" })).allowed, false);
    assert.equal(lookups, before);
  }
  address = "93.184.216.34";
  assert.equal((await e.decide("https://node.example/a2a")).allowed, true, "ordinary egress keeps suffix rules");
  hosts = ["node.example"];
  address = "100.64.0.9";
  assert.equal((await e.decide("https://node.example/a2a", { purpose: "a2a" })).allowed, true);
  hosts = ["100.64.0.9"];
  assert.equal((await e.decide("https://100.64.0.9/a2a", { purpose: "a2a" })).allowed, true);
});
