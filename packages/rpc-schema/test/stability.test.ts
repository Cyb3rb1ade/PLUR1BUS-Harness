import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA } from "../src/index.ts";

const SEMVER = /^\d+\.\d+\.\d+$/;

describe("rpc-schema stability annotations", () => {
  const schema = SCHEMA as any;
  const methods = schema.$defs.methods as Record<string, { "x-stability"?: string; "x-since"?: string }>;
  const notifications = schema.$defs.notifications as Record<string, { "x-stability"?: string; "x-since"?: string }>;

  it("every method and notification declares x-stability and a semver x-since", () => {
    for (const [name, def] of Object.entries(methods)) {
      assert.ok(def["x-stability"] === "experimental" || def["x-stability"] === "stable", `${name} x-stability`);
      assert.match(def["x-since"] ?? "", SEMVER, `${name} x-since`);
    }
    for (const [name, def] of Object.entries(notifications)) {
      assert.ok(def["x-stability"] === "experimental" || def["x-stability"] === "stable", `${name} x-stability`);
      assert.match(def["x-since"] ?? "", SEMVER, `${name} x-since`);
    }
  });

  it("the stable subset is exactly G14", () => {
    const stableMethods = Object.entries(methods)
      .filter(([, def]) => def["x-stability"] === "stable")
      .map(([name]) => name)
      .sort();
    const stableNotifications = Object.entries(notifications)
      .filter(([, def]) => def["x-stability"] === "stable")
      .map(([name]) => name)
      .sort();
    assert.deepEqual(stableMethods, [
      "core.auth", "core.shutdown", "core.status", "events.subscribe", "events.unsubscribe",
      "memory.capture", "memory.recall",
    ]);
    assert.deepEqual(stableNotifications, ["core.state"]);
  });
});
