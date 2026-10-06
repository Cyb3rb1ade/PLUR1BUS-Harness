import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveGuarded, makeAddressPolicy, type Resolver } from "../../../src/tools/web/guard.ts";
import { WebFailure } from "../../../src/tools/web/failure.ts";

const stub = (map: Record<string, string[]>): Resolver => async (host) => {
  const a = map[host];
  if (!a) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

const refusal = async (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof WebFailure && e.code === code, `expected ${code}`);

describe("guard: resolveGuarded", () => {
  const policy = makeAddressPolicy([]);

  it("pins a public answer", async () => {
    const r = await resolveGuarded("example.test", stub({ "example.test": ["93.184.216.34"] }), policy);
    assert.deepEqual(r, { address: "93.184.216.34", family: 4 });
  });

  it("refuses when ANY answer is private (mixed A records)", async () => {
    await refusal(resolveGuarded("mixed.test", stub({ "mixed.test": ["93.184.216.34", "10.0.0.5"] }), policy), "private-address");
  });

  it("refuses IPv6 loopback answer for a name", async () => {
    await refusal(resolveGuarded("v6.test", stub({ "v6.test": ["::1"] }), policy), "private-address");
  });

  it("classifies IP literals without consulting the resolver", async () => {
    const boom: Resolver = async () => assert.fail("resolver must not run for literals");
    await refusal(resolveGuarded("169.254.169.254", boom, policy), "private-address");
    await refusal(resolveGuarded("[::ffff:127.0.0.1]", boom, policy), "private-address");
    await refusal(resolveGuarded("2130706433", boom, policy), "private-address");
    await refusal(resolveGuarded("0x7f.1", boom, policy), "private-address");
  });

  it("refuses localhost names without resolving", async () => {
    const boom: Resolver = async () => assert.fail("resolver must not run");
    for (const h of ["localhost", "LOCALHOST", "foo.localhost", "localhost."]) await refusal(resolveGuarded(h, boom, policy), "private-address");
  });

  it("an empty or failing resolution is a typed failure, not a crash", async () => {
    await refusal(resolveGuarded("nx.test", stub({}), policy), "not-found");
    await refusal(resolveGuarded("empty.test", async () => [], policy), "not-found");
  });

  it("the allowlist admits only the listed ranges", async () => {
    const allow = makeAddressPolicy(["127.0.0.0/8", "100.64.0.0/10"]);
    assert.deepEqual(await resolveGuarded("127.0.0.1", stub({}), allow), { address: "127.0.0.1", family: 4 });
    assert.equal((await resolveGuarded("ts.test", stub({ "ts.test": ["100.101.102.103"] }), allow)).address, "100.101.102.103");
    await refusal(resolveGuarded("10.0.0.1", stub({}), allow), "private-address");
    await refusal(resolveGuarded("meta.test", stub({ "meta.test": ["169.254.169.254"] }), allow), "private-address");
  });

  it("an IPv4-mapped address is matched against IPv4 allowlist entries only for those entries", async () => {
    const allow = makeAddressPolicy(["127.0.0.0/8"]);
    assert.equal((await resolveGuarded("[::ffff:127.0.0.1]", stub({}), allow)).address, "::ffff:7f00:1");
  });

  it("an invalid allowlist entry is a construction error (fail closed)", () => {
    assert.throws(() => makeAddressPolicy(["10.0.0.0/33"]));
    assert.throws(() => makeAddressPolicy(["not-an-ip"]));
  });
});
