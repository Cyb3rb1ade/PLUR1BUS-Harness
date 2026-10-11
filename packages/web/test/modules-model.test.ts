// Settings > Modules & Updates: the pure dependency helpers. A stop or restart names every module that depends on the target,
// directly or through others; "depends on" follows the edges as the graph draws them (from depends on to).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  affected, cycleMembers, dependencies, dependents, isRunning, messageOf, unresolved, type ModuleEntry,
} from "../src/pages/settings/modules/model.ts";
import type { ModuleGraph } from "../src/pages/settings/modules/rpc-types.ts";

const node = (name: string) => ({ name, version: "1.0.0", priority: 500, band: "x", scope: "installation", extensionPoints: {}, valid: true });
const edge = (from: string, to: string, kind: "needs" | "consumes" = "needs") => ({ from, to, kind });

// core <- fixture <- digest <- report ; search consumes memory (provided by digest)
const GRAPH: ModuleGraph = {
  nodes: [node("core"), node("fixture"), node("digest"), node("report"), node("search")],
  edges: [
    edge("fixture", "core"), edge("digest", "fixture"), edge("report", "digest"), edge("search", "digest", "consumes"),
  ],
  cycles: [],
  unresolved: [],
};

describe("modules: dependency helpers", () => {
  test("dependencies are the modules a module needs, as the graph draws them", () => {
    assert.deepEqual(dependencies(GRAPH, "report"), ["digest"]);
    assert.deepEqual(dependencies(GRAPH, "fixture"), ["core"]);
    assert.deepEqual(dependencies(GRAPH, "core"), []);
  });

  test("dependents are the modules that need a module directly", () => {
    assert.deepEqual(dependents(GRAPH, "digest"), ["report", "search"]);
    assert.deepEqual(dependents(GRAPH, "report"), []);
  });

  test("affected is the transitive closure of the dependents, sorted, without the module itself", () => {
    assert.deepEqual(affected(GRAPH, "fixture"), ["digest", "report", "search"]);
    assert.deepEqual(affected(GRAPH, "digest"), ["report", "search"]);
    assert.deepEqual(affected(GRAPH, "report"), []);
  });

  test("a cycle does not make affected loop forever and does not include the module itself", () => {
    const cyclic: ModuleGraph = {
      ...GRAPH,
      edges: [edge("a", "b"), edge("b", "a")],
      cycles: [["a", "b"]],
    };
    assert.deepEqual(affected(cyclic, "a"), ["b"]);
    assert.deepEqual(cycleMembers(cyclic, "a"), ["b"]);
    assert.deepEqual(cycleMembers(GRAPH, "fixture"), []);
  });

  test("unresolved lists missing needs and consumes capabilities of one module", () => {
    const broken: ModuleGraph = {
      ...GRAPH,
      unresolved: [
        { from: "report", kind: "needs", name: "gone" },
        { from: "report", kind: "consumes", capability: "search" },
        { from: "digest", kind: "needs", name: "other" },
      ],
    };
    assert.deepEqual(unresolved(broken, "report"), ["gone", "search"]);
    assert.deepEqual(unresolved(broken, "fixture"), []);
  });

  test("with no graph there are no dependencies, dependents or affected modules", () => {
    assert.deepEqual(dependencies(null, "fixture"), []);
    assert.deepEqual(dependents(null, "fixture"), []);
    assert.deepEqual(affected(null, "fixture"), []);
    assert.deepEqual(unresolved(null, "fixture"), []);
    assert.deepEqual(cycleMembers(null, "fixture"), []);
  });
});

describe("modules: state and messages", () => {
  const entry = (state: string | null): ModuleEntry => ({
    name: "fixture", version: "1.0.0", apiVersion: "1", priority: 500, band: "x", scope: "installation",
    provides: [], consumes: [], needs: [], enabled: true, errors: [], detail: null,
    child: state === null ? null : {
      role: "fixture", process: { state: state as "ready" }, pid: 1, instanceId: "i", adopted: false, restarts: 0,
      lastExit: null, nextRestartAt: null,
    },
  } as unknown as ModuleEntry);

  test("a ready, degraded or starting child counts as running; anything else can be started", () => {
    for (const s of ["ready", "degraded", "starting"]) assert.equal(isRunning(entry(s)), true, s);
    for (const s of ["stopped", "crashed", "orphaned", "stopping"]) assert.equal(isRunning(entry(s)), false, s);
    assert.equal(isRunning(entry(null)), false);
  });

  test("messageOf adds the machine reason when the server gave one", () => {
    assert.equal(messageOf({ message: "not allowed", reason: "disabled" }), "not allowed (disabled)");
    assert.equal(messageOf({ message: "plain" }), "plain");
    assert.equal(messageOf({ message: "", reason: "" }), "error");
    assert.equal(messageOf(undefined), "error");
  });
});
