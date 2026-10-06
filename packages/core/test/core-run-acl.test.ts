import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { defaults } from "@plur1bus/config-schema";
import type { HarnessLogger } from "@plur1bus/module-api";
import { createCore, type CoreOptions } from "../src/core.ts";
import { layout } from "../src/paths.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";
import { tempDir } from "./helpers/temp-dir.ts";

type Line = { level: string; msg: string };
const recorder = (sink: Line[]): HarnessLogger => {
  const at = (level: string) => (msg: string) => { sink.push({ level, msg }); };
  const l: any = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), close: async () => {} };
  l.child = () => l;
  return l as HarnessLogger;
};

/** A home with the engine features that need models switched off (as in core.test.ts). */
function newHome(): string {
  const home = tempDir("p1b-core-acl-");
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false }, runtime: { recallTimeoutMs: 10_000 } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}

/** The Windows path of securePath on any host: every tool call (whoami, icacls) fails. */
const failingAcl = (calls: string[]): NonNullable<CoreOptions["securePathOptions"]> => ({
  platform: "win32",
  execFile: (exe: string) => { calls.push(exe); throw new Error("blocked by AppLocker"); },
});

describe("core run/ ACL (audit M3)", () => {
  it("without a supervisor: refuses to start and writes no core.token or core.pid when the ACL step fails", { timeout: 30_000 }, async () => {
    const home = newHome();
    const lines: Line[] = []; const calls: string[] = [];
    const core = createCore({ home, logger: recorder(lines), testInternals: flatTestInternals(), securePathOptions: failingAcl(calls) });
    try {
      await assert.rejects(core.start(), /refusing to start: the access control list of run\/ could not be restricted/);
      assert.ok(calls.length > 0, "the injected ACL tool was asked");
      const l = layout(home);
      assert.equal(existsSync(l.coreToken), false, "no token file");
      assert.equal(existsSync(l.corePid), false, "no pid file");
      assert.deepEqual(readdirSync(l.run).filter((f) => /token|pid|sock/.test(f)), [], "nothing was written into run/");
      assert.ok(lines.some((x) => x.level === "error" && /refusing to start/.test(x.msg)), "the refusal is logged");
    } finally {
      await core.stop({ budgetMs: 2000 }).catch(() => {}); // a regression that lets it start must not leave a listening core behind
    }
  });

  it("under a supervisor (lifeline): warns and starts; the supervisor owns run/", { timeout: 60_000 }, async () => {
    const home = newHome();
    const lines: Line[] = []; const calls: string[] = [];
    const lifeline = new PassThrough();
    const core = createCore({ home, logger: recorder(lines), testInternals: flatTestInternals(), securePathOptions: failingAcl(calls), lifeline });
    try {
      await core.start();
      assert.ok(calls.length > 0, "the injected ACL tool was asked");
      assert.equal(existsSync(layout(home).coreToken), true, "the supervised core writes its token");
      assert.ok(lines.some((x) => x.level === "warn" && /supervisor owns it/.test(x.msg)), "a warning, not a failure");
      assert.equal(lines.some((x) => /refusing to start/.test(x.msg)), false);
    } finally {
      lifeline.end();
      await core.stop({ budgetMs: 5000 }).catch(() => {});
    }
  });
});
