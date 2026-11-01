/** D120 H1-1: the tools service has closed inputs and forward-compatible, Core-only results. */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA, buildCapabilities, validateParams, validateResult } from "../src/index.ts";

describe("tools service contract", () => {
  it("the committed hello fixture validates without credential hydration", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../fixtures/methods/tools.hello.json", import.meta.url),
        "utf8",
      ),
    );
    assert.deepEqual(validateParams("tools.hello", fixture.params), {
      ok: true,
    });
  });
  it("advertises tools methods only on the tools server", () => {
    const schema = SCHEMA as { $defs: { methods: Record<string, Record<string, unknown>> } };
    for (const name of ["tools.hello", "tools.health"]) {
      assert.equal(schema.$defs.methods[name]?.["x-server"], "tools");
      for (const role of ["core", "supervisor", "module", "engine"] as const) {
        assert.equal(buildCapabilities([], role).methods[name], undefined);
      }
    }
  });

  it("requires a Core credential and a per-start ticket key and refuses unknown hello fields", () => {
    const params = { token: randomBytes(32).toString("hex"), ticketKey: randomBytes(32).toString("hex") };
    assert.deepEqual(validateParams("tools.hello", params), { ok: true });
    for (const invalid of [{}, { token: params.token }, { ...params, principal: "core" },
      { ...params, ticketKey: "invalid" }]) {
      assert.equal(validateParams("tools.hello", invalid).ok, false);
    }
  });

  it("health exposes process readiness and identity without credentials", () => {
    assert.deepEqual(validateParams("tools.health", {}), { ok: true });
    assert.equal(validateParams("tools.health", { principal: "core" }).ok, false);
    assert.deepEqual(validateResult("tools.health", {
      process: { state: "ready", since: 1 }, rpc: "1.15.0", instanceId: "fixture", pid: 123, uptimeMs: 1,
    }), { ok: true });
  });

  it("keeps result readers compatible with additional fields from a newer 1.x service", () => {
    for (const method of ["tools.hello", "tools.health"]) {
      const fixture = JSON.parse(readFileSync(new URL(`../fixtures/methods/${method}.json`, import.meta.url), "utf8")) as { result: Record<string, unknown> };
      assert.equal(validateResult(method, fixture.result).ok, true);
      assert.equal(validateResult(method, { ...fixture.result, futureField: true }).ok, true);
    }
  });

  it("allows a newer cached tools status inside core.status", () => {
    const fixture = JSON.parse(readFileSync(new URL("../fixtures/methods/core.status.json", import.meta.url), "utf8")) as { result: Record<string, unknown> };
    assert.equal(validateResult("core.status", { ...fixture.result, tools: {
      ready: false, pid: null, checkedAt: null, futureField: true,
    } }).ok, true);
  });
});
