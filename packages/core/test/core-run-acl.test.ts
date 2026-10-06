import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { createCore } from "../src/core.ts";
import { layout } from "../src/paths.ts";
import type { HarnessLogger } from "@plur1bus/module-api";
import { tempDir } from "./helpers/temp-dir.ts";

const quiet = (sink: string[] = []): HarnessLogger => {
  const l = (_m: string) => (m: string) => { sink.push(m); };
  return { debug: l("d"), info: l("i"), warn: l("w"), error: l("e"), child: () => quiet(sink), close: async () => {} } as unknown as HarnessLogger;
};

describe("core run/ ACL (audit M3)", () => {
  it("refuses to start, and writes no core.token, when the Windows ACL step fails", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-core-acl-");
    const errors: string[] = [];
    const calls: string[] = [];
    const core = createCore({
      home, logger: quiet(errors),
      // The Windows path of securePath on any host: every tool call (whoami, icacls) fails.
      securePathOptions: { platform: "win32", execFile: (exe: string) => { calls.push(exe); throw new Error("blocked by AppLocker"); } },
    });
    await assert.rejects(core.start(), /refusing to start: the access control list of run\/ could not be restricted/);
    assert.ok(calls.length > 0, "the injected ACL tool was asked");
    const l = layout(home);
    assert.equal(existsSync(l.coreToken), false, "no token file");
    assert.equal(existsSync(l.corePid), false, "no pid file");
    assert.deepEqual(readdirSync(l.run).filter((f) => /token|pid|sock/.test(f)), [], "nothing was written into run/");
    assert.ok(errors.some((m) => /refusing to start/.test(m)), "the refusal is logged");
  });
});
