import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveDeps } from "../src/deps.ts";
import { defaultSleep } from "../src/retry.ts";
import type { AdapterDeps } from "../src/types.ts";

const getSecret = async (name: string) => `value-of-${name}`;

describe("resolveDeps: required input", () => {
  const bad: Array<[string, unknown, RegExp]> = [
    ["no deps object at all (undefined)", undefined, /deps\.getSecret is required/],
    ["null deps", null, /deps\.getSecret is required/],
    ["empty object", {}, /deps\.getSecret is required/],
    ["getSecret is a string", { getSecret: "SECRET_NAME" }, /deps\.getSecret is required/],
    ["getSecret is undefined", { getSecret: undefined }, /deps\.getSecret is required/],
    ["getSecret is null", { getSecret: null }, /deps\.getSecret is required/],
  ];
  for (const [label, input, message] of bad) {
    it(`throws a TypeError for ${label}`, () => {
      assert.throws(() => resolveDeps(input as unknown as AdapterDeps), (e: unknown) => e instanceof TypeError && message.test(e.message));
    });
  }

  it("the error never mentions a value, only the requirement", () => {
    assert.throws(() => resolveDeps({ getSecret: "super-secret-value" } as unknown as AdapterDeps), (e: unknown) => e instanceof TypeError && !/super-secret-value/.test(e.message));
  });
});

describe("resolveDeps: injected values are used as given", () => {
  it("keeps every injected function by identity", () => {
    const fetchFn = (async () => new Response("")) as typeof fetch;
    const sleep = async () => {};
    const random = () => 0.25;
    const now = () => 42;
    const out = resolveDeps({ getSecret, fetch: fetchFn, sleep, random, now });
    assert.equal(out.getSecret, getSecret);
    assert.equal(out.fetch, fetchFn);
    assert.equal(out.sleep, sleep);
    assert.equal(out.random, random);
    assert.equal(out.now, now);
  });

  it("the secret lookup is the injected one: nothing is read from the environment", async () => {
    const out = resolveDeps({ getSecret });
    assert.equal(out.getSecret, getSecret);
    assert.equal(await out.getSecret("EXAMPLE_KEY"), "value-of-EXAMPLE_KEY");
  });
});

describe("resolveDeps: defaults when a dependency is omitted", () => {
  it("uses the built-in sleep, Math.random and Date.now", () => {
    const out = resolveDeps({ getSecret });
    assert.equal(out.sleep, defaultSleep);
    assert.equal(out.random, Math.random);
    assert.equal(out.now, Date.now);
  });

  it("falls back to the global fetch, bound to globalThis, when none is injected", async () => {
    const original = globalThis.fetch;
    const seen: unknown[] = [];
    globalThis.fetch = (async (input: unknown) => {
      seen.push(input);
      return new Response("ok");
    }) as typeof fetch;
    try {
      const out = resolveDeps({ getSecret });
      const res = await out.fetch("https://example.test/resource");
      assert.equal(await res.text(), "ok");
      assert.deepEqual(seen, ["https://example.test/resource"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("each default is taken independently: injecting one leaves the others at their defaults", () => {
    const sleep = async () => {};
    const out = resolveDeps({ getSecret, sleep });
    assert.equal(out.sleep, sleep);
    assert.equal(out.random, Math.random);
    assert.equal(out.now, Date.now);

    const random = () => 0.9;
    const out2 = resolveDeps({ getSecret, random });
    assert.equal(out2.random, random);
    assert.equal(out2.sleep, defaultSleep);
    assert.equal(out2.now, Date.now);

    const now = () => 7;
    const out3 = resolveDeps({ getSecret, now });
    assert.equal(out3.now, now);
    assert.equal(out3.random, Math.random);
  });
});
