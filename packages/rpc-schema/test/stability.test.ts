import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { METHODS, METHODS_BY_SERVER, NOTIFICATIONS, RPC_VERSION, SCHEMA, buildCapabilities, validateResult } from "../src/index.ts";

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

  it("every method declares x-server core or supervisor, and every notification x-server core", () => {
    for (const [name, def] of Object.entries(methods) as [string, { "x-server"?: string }][]) {
      assert.ok(def["x-server"] === "core" || def["x-server"] === "supervisor", `${name} x-server`);
    }
    for (const [name, def] of Object.entries(notifications) as [string, { "x-server"?: string }][]) {
      assert.equal(def["x-server"], "core", `${name} x-server`);
    }
  });

  it("buildCapabilities lists every core method and notification with stability and since", () => {
    const capabilities = buildCapabilities([]);
    assert.deepEqual(Object.keys(capabilities.methods).sort(), [...METHODS_BY_SERVER.core].sort());
    assert.deepEqual(Object.keys(capabilities.notifications).sort(), [...NOTIFICATIONS].sort());
    assert.equal(capabilities.methods["core.auth"]!.stability, "stable");
    assert.deepEqual(
      validateResult("core.auth", { contract: "1.6.0", rpc: "1.2.0", instanceId: "i", pid: 1, capabilities }),
      { ok: true },
    );
  });

  it("buildCapabilities(core) omits supervisor methods and vice versa", () => {
    const core = buildCapabilities([], "core");
    assert.ok(core.methods["memory.recall"]);
    assert.ok(core.methods["core.adopt"]);
    assert.equal(core.methods["daemon.status"], undefined);
    const supervisor = buildCapabilities(["lifelines", "adoption"], "supervisor");
    assert.deepEqual(Object.keys(supervisor.methods).sort(), ["daemon.start", "daemon.status", "daemon.stop", "supervisor.auth"]);
    assert.deepEqual(supervisor.notifications, {});
    assert.deepEqual(supervisor.features, ["adoption", "lifelines"]);
    assert.deepEqual([...METHODS_BY_SERVER.supervisor].sort(), ["daemon.start", "daemon.status", "daemon.stop", "supervisor.auth"]);
    assert.deepEqual([...METHODS_BY_SERVER.core, ...METHODS_BY_SERVER.supervisor].sort(), [...METHODS].sort());
    assert.deepEqual(validateResult("supervisor.auth", { rpc: "1.2.0", instanceId: "s", pid: 2, capabilities: supervisor }), { ok: true });
  });

  it("capability fixtures match buildCapabilities", () => {
    for (const server of ["core", "supervisor"] as const) {
      const fixture = JSON.parse(readFileSync(new URL(`../fixtures/capabilities/${server}.json`, import.meta.url), "utf8"));
      assert.deepEqual(fixture, buildCapabilities([], server), `fixtures/capabilities/${server}.json`);
    }
  });

  it("RPC_VERSION is 1.3.0 and matches the $id", () => {
    assert.equal(RPC_VERSION, "1.3.0");
    assert.equal(schema.$id, "https://plur1bus.dev/schema/rpc/1.3.0/rpc.schema.json");
  });

  it("core.status journalReplay (1.3.0) is optional, closed and experimental", () => {
    const d = (schema.$defs as any).JournalReplayStatus;
    assert.equal(d["x-stability"], "experimental"); assert.equal(d["x-since"], "1.3.0");
    assert.equal(d.additionalProperties, false);
    assert.ok(!(schema.$defs as any).CoreStatus.required.includes("journalReplay"));
    const base = { process: { state: "ready", since: 1 }, contract: "1.8.0", rpc: "1.3.0", instanceId: "i", pid: 1, uptimeMs: 1, engine: { ready: true, degraded: null }, agents: [] };
    const replaying = { state: "replaying", replayed: 3, pendingRemoval: 3, kept: 0, passes: 0, startedAt: 1, finishedAt: null };
    assert.deepEqual(validateResult("core.status", base), { ok: true });
    assert.deepEqual(validateResult("core.status", { ...base, journalReplay: replaying }), { ok: true });
    assert.equal(validateResult("core.status", { ...base, journalReplay: { ...replaying, extra: 1 } }).ok, false);
    assert.equal(validateResult("core.status", { ...base, journalReplay: { ...replaying, state: "paused" } }).ok, false);
  });

  it("everything new in 1.2.0 is experimental", () => {
    for (const name of ["supervisor.auth", "daemon.status", "daemon.start", "daemon.stop", "core.adopt"]) {
      assert.equal(methods[name]?.["x-stability"], "experimental", name);
      assert.equal(methods[name]?.["x-since"], "1.2.0", name);
    }
  });

  it("core.status and core.adopt share $defs/CoreStatus", () => {
    const m = methods as Record<string, any>;
    assert.deepEqual(m["core.status"].result, { $ref: "#/$defs/CoreStatus" });
    assert.deepEqual(m["core.adopt"].result.properties.status, { $ref: "#/$defs/CoreStatus" });
    assert.ok(schema.$defs.CoreStatus.properties.process);
  });
});
