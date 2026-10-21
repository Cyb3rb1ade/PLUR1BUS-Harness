// The core start hook for a backup restore's marker (src/restore-reapply.ts): needs the real engine, like core.test.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { defaults } from "@plur1bus/config-schema";
import type { HarnessLogger } from "@plur1bus/module-api";
import { createCore } from "../src/core.ts";
import { layout } from "../src/paths.ts";
import { restoreReapplyMarker, type EngineTombstoneReapply } from "../src/restore-reapply.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";
import { tempDir } from "./helpers/temp-dir.ts";

type Line = { level: string; msg: string };
const recorder = (sink: Line[]): HarnessLogger => {
  const at = (level: string) => (msg: string) => { sink.push({ level, msg }); };
  const l: any = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), close: async () => {} };
  l.child = () => l;
  return l as HarnessLogger;
};

/** A home after a backup restore: engine features that need models off (as in backup-ops.test.ts), the marker in place. */
function restoredHome(): string {
  const home = tempDir("p1b-restore-core-");
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  const l = layout(home);
  writeFileSync(l.configPath, JSON.stringify(cfg));
  mkdirSync(l.state, { recursive: true });
  writeFileSync(restoreReapplyMarker(l), JSON.stringify({ schema: "plur1bus.restore-reapply-tombstones/1", restoredAtMs: 1 }));
  return home;
}

describe("core start after a backup restore", () => {
  it("re-applies the committed tombstones to the configured store before the socket listens, then removes the marker", { timeout: 60_000 }, async () => {
    const home = restoredHome(); const l = layout(home);
    const lines: Line[] = []; const calls: Array<{ baseDbPath: string; apply?: boolean; listening: boolean }> = [];
    const engine: EngineTombstoneReapply = {
      reapplyCommittedTombstones: async (o) => {
        // No client can have been served a recall yet: the core's socket does not exist.
        calls.push({ ...o, listening: existsSync(l.coreSocket) });
        return { applied: [], alreadyTombstoned: [], notFound: [], errors: [], registryErrors: [], activeAfterReapply: [] };
      },
      reapplyFailed: () => false,
    };
    const core = createCore({ home, logger: recorder(lines), testInternals: flatTestInternals(), tombstoneReapply: async () => engine });
    try {
      await core.start();
      assert.deepEqual(calls, [{ baseDbPath: l.lancedb, apply: true, listening: false }]);
      assert.equal(existsSync(restoreReapplyMarker(l)), false, "settled: the marker is gone");
    } finally { await core.stop({ budgetMs: 5000 }).catch(() => {}); }
  });

  it("starts anyway when the engine has no re-apply, keeps the marker and warns", { timeout: 60_000 }, async () => {
    const home = restoredHome(); const l = layout(home);
    const lines: Line[] = [];
    const core = createCore({ home, logger: recorder(lines), testInternals: flatTestInternals(), tombstoneReapply: async () => null });
    try {
      await core.start();
      assert.equal(existsSync(restoreReapplyMarker(l)), true, "still owed");
      assert.ok(lines.some((x) => x.level === "warn" && /may be recallable again/.test(x.msg)), JSON.stringify(lines.filter((x) => x.level === "warn")));
    } finally { await core.stop({ budgetMs: 5000 }).catch(() => {}); }
  });

  it("does not touch the engine's re-apply when no restore left a marker", { timeout: 60_000 }, async () => {
    const home = restoredHome(); const l = layout(home);
    rmSync(restoreReapplyMarker(l)); // the normal case: no restore happened
    let asked = 0;
    const core = createCore({ home, logger: recorder([]), testInternals: flatTestInternals(), tombstoneReapply: async () => { asked++; return null; } });
    try { await core.start(); assert.equal(asked, 0); } finally { await core.stop({ budgetMs: 5000 }).catch(() => {}); }
  });
});
