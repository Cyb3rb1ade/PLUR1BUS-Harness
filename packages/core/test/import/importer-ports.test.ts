/** Supervised importers delegate config authority and stop only between complete source entities. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { importOpenclaw } from "../../src/import/importers/openclaw.ts";
import type { Engine } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();
const RUN = "de2b951b-60a3-4288-abfe-37952770b5de";
const MARKER = "fixture-legacy-target-key-never-in-control-request";

function source() {
  const root = temp();
  const agents = ["alpha", "beta"].map(id => {
    const workspace = join(root, id);
    mkdirSync(workspace);
    writeFileSync(join(workspace, "SOUL.md"), `persona ${id}`);
    return { id, workspace };
  });
  writeFileSync(join(root, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
    agents: { list: agents } }));
  return root;
}

describe("supervised importer ports", () => {
  it("uses the injected target config reader and emits only changed agent keys through the writer", async () => {
    const home = temp();
    const original = JSON.stringify({ ...defaults(), ownerSecret: MARKER });
    writeFileSync(join(home, "config.json"), original);
    const calls: unknown[] = [];
    let reads = 0;
    const report = await importOpenclaw({ home, source: source(), apply: true, runId: RUN,
      configPort: { get: async () => { reads++; return { config: defaults(), revision: "revision-1" }; },
        set: async params => { calls.push(params); return { revision: "revision-2" }; } } });
    assert.equal(report.runId, RUN);
    assert.equal(reads, 1);
    assert.deepEqual((calls[0] as { changes: { key: string }[] }).changes.map(change => change.key),
      ["agents.alpha", "agents.beta"]);
    assert.equal((calls[0] as { dryRun: boolean }).dryRun, false);
    assert.equal(readFileSync(join(home, "config.json"), "utf8"), original);
    assert.ok(!JSON.stringify(calls).includes(MARKER));
    assert.equal(readFileSync(join(home, "agents", "alpha", "workspace", "SOUL.md"), "utf8"), "persona alpha");
  });

  it("validates planned config through the same Supervisor port during dry-run without creating target files", async () => {
    const home = temp();
    const calls: unknown[] = [];
    await assert.rejects(importOpenclaw({ home, source: source(), runId: RUN,
      configPort: { get: async () => ({ config: defaults(), revision: "rev" }), set: async params => {
        calls.push(params);
        throw new Error("schema refuses planned change");
      } } }));
    assert.equal(existsSync(join(home, "config.json")), false);
    assert.equal(calls.length, 1);
  });

  it("observes cancellation after the first agent checkpoint without starting the next entity", async () => {
    const home = temp();
    const controller = new AbortController();
    const progress: unknown[] = [];
    await assert.rejects(importOpenclaw({ home, source: source(), apply: true, runId: RUN,
      signal: controller.signal, onProgress: event => {
        progress.push(event);
        if (event.entity === "agent" && event.completed === 1) controller.abort(new Error(MARKER));
      } }));
    assert.equal(existsSync(join(home, "agents", "alpha", "workspace", "SOUL.md")), true);
    assert.equal(existsSync(join(home, "agents", "beta")), false);
    assert.ok(!JSON.stringify(progress).includes(MARKER));
  });

  it("applies only selected agents and the selected file decision rather than the global fallback", async () => {
    const home = temp();
    const target = join(home, "agents", "beta", "workspace");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SOUL.md"), "existing target persona");
    const config = defaults();
    config.agents.beta = {};
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
    const report = await importOpenclaw({ home, source: source(), apply: true, runId: RUN,
      sourceAgentIds: ["beta"], onConflict: "skip", fileConflict: (agent, path) =>
        agent === "beta" && path === "SOUL.md" ? "replace" : "skip" });
    assert.deepEqual(report.agents.map(agent => agent.sourceId), ["beta"]);
    assert.equal(existsSync(join(home, "agents", "alpha")), false);
    assert.equal(readFileSync(join(target, "SOUL.md"), "utf8"), "persona beta");
    assert.equal(report.agents[0]?.files.find(file => file.targetFile === "SOUL.md")?.action, "replace");
  });

  it("observes GUI cancellation between complete memory batches without starting another batch or agent", async () => {
    const home = temp();
    const root = source();
    writeFileSync(join(root, "alpha", "MEMORY.md"), Array.from({ length: 505 }, (_, n) => `Memory card ${n}`).join("\n§\n"));
    const batches: number[] = [];
    const engine = { memory: { import: async (request: { cards: { idempotencyKey: string }[] }) => {
      batches.push(request.cards.length);
      return { created: request.cards.length, matchedExisting: 0, rejected: 0,
        cards: request.cards.map(card => ({ idempotencyKey: card.idempotencyKey, outcome: "created" })) };
    } } } as unknown as Engine;
    const controller = new AbortController();
    await assert.rejects(importOpenclaw({ home, source: root, apply: true, runId: RUN, engine,
      signal: controller.signal, onProgress: event => {
        if (event.entity === "memory" && event.completed === 1) controller.abort();
      } }));
    assert.deepEqual(batches, [500]);
    assert.equal(existsSync(join(home, "agents", "beta")), false);
  });
});
