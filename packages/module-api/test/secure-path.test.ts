// securePath and the supervisor's `run/` ACL (HB5 c): on win32, with `PLUR1BUS_RUN_ACL=inherited`, `run/` and the files
// directly inside it already carry the protected, inheritable user-and-SYSTEM DACL the supervisor set, so no tool
// runs. Everything else takes the icacls path unchanged. The win32 branch is reached on any OS through an injected
// `platform` and a fake `execFile` that records its calls.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createSecurePath } from "../src/secure-path.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const OWNER_ONLY = `D:PAI(A;;FA;;;${SID})(A;;FA;;;SY)`;

/** A fake whoami + icacls (every `/save` reports user + SYSTEM only), plus a logger; both record what they got. */
function recorder() {
  const calls: Array<[string, readonly string[]]> = [];
  const debug: Array<[string, Record<string, unknown> | undefined]> = [];
  const execFile = (file: string, args: readonly string[]): string => {
    calls.push([file, args]);
    if (file.endsWith("whoami.exe")) return `"desktop-p1b\\bernd","${SID}"\r\n`;
    if (args[1] === "/save") writeFileSync(args[2]!, Buffer.from(`﻿t\r\n${OWNER_ONLY}\r\n`, "utf16le"));
    return "processed 1 file\r\n";
  };
  const logger = {
    warn: () => {},
    debug: (msg: string, fields?: Record<string, unknown>) => { debug.push([msg, fields]); },
  };
  return { calls, debug, execFile, logger };
}

/** A home with `run/`, a token inside it and a file outside it. */
function home() {
  const h = tempDir("p1b-secure-path-");
  const runDir = join(h, "run");
  mkdirSync(runDir);
  const token = join(runDir, "module-fixture.token");
  writeFileSync(token, "t");
  const outside = join(h, "config.json");
  writeFileSync(outside, "{}");
  return { h, runDir, token, outside };
}

const INHERITED = { PLUR1BUS_RUN_ACL: "inherited" };

describe("securePath with the supervisor's run/ ACL (HB5)", () => {
  it("with PLUR1BUS_RUN_ACL=inherited a file inside run/ calls no tool", () => {
    const { runDir, token } = home(); const r = recorder();
    const sp = createSecurePath({ platform: "win32", execFile: r.execFile, logger: r.logger, env: INHERITED, runDir });
    assert.deepEqual(sp(token), { applied: true, mechanism: "acl" });
    assert.deepEqual(r.calls, []);
    assert.equal(r.debug.length, 1, JSON.stringify(r.debug));
  });

  it("with it, run/ itself calls no tool", () => {
    const { runDir } = home(); const r = recorder();
    const sp = createSecurePath({ platform: "win32", execFile: r.execFile, logger: r.logger, env: INHERITED, runDir });
    assert.deepEqual(sp(runDir, { mode: 0o700 }), { applied: true, mechanism: "acl" });
    assert.deepEqual(r.calls, []);
  });

  it("run/ is compared case-insensitively after path.resolve", () => {
    const { runDir, token } = home(); const r = recorder();
    const sp = createSecurePath({ platform: "win32", execFile: r.execFile, logger: r.logger, env: INHERITED, runDir: join(runDir.toUpperCase(), "..", "RUN") });
    assert.deepEqual(sp(token), { applied: true, mechanism: "acl" });
    assert.deepEqual(r.calls, []);
  });

  it("a path outside run/ still runs icacls", () => {
    const { runDir, outside } = home(); const r = recorder();
    const sp = createSecurePath({ platform: "win32", execFile: r.execFile, logger: r.logger, env: INHERITED, runDir });
    assert.deepEqual(sp(outside), { applied: true, mechanism: "acl" });
    assert.ok(r.calls.some(([f, a]) => f.endsWith("icacls.exe") && a[0] === outside && a[1] === "/inheritance:r"), JSON.stringify(r.calls));
  });

  it("a file in a subdirectory of run/ still runs icacls (only run/ and its direct children)", () => {
    const { runDir } = home(); const r = recorder();
    const sub = join(runDir, "sub"); mkdirSync(sub); const nested = join(sub, "x"); writeFileSync(nested, "x");
    const sp = createSecurePath({ platform: "win32", execFile: r.execFile, logger: r.logger, env: INHERITED, runDir });
    sp(nested);
    assert.ok(r.calls.some(([f, a]) => f.endsWith("icacls.exe") && a[0] === nested), JSON.stringify(r.calls));
  });

  it("without the variable every path runs icacls as before", () => {
    const { runDir, token } = home();
    for (const env of [{}, { PLUR1BUS_RUN_ACL: "yes" }]) {
      const r = recorder();
      const sp = createSecurePath({ platform: "win32", execFile: r.execFile, logger: r.logger, env, runDir });
      assert.deepEqual(sp(runDir), { applied: true, mechanism: "acl" });
      assert.deepEqual(sp(token), { applied: true, mechanism: "acl" });
      const grants = r.calls.filter(([f, a]) => f.endsWith("icacls.exe") && a[1] === "/inheritance:r").map(([, a]) => a[0]);
      assert.deepEqual(grants, [runDir, token]);
    }
  });

  it("without a runDir the variable changes nothing", () => {
    const { token } = home(); const r = recorder();
    const sp = createSecurePath({ platform: "win32", execFile: r.execFile, logger: r.logger, env: INHERITED });
    sp(token);
    assert.ok(r.calls.some(([f, a]) => f.endsWith("icacls.exe") && a[0] === token), JSON.stringify(r.calls));
  });

  it("on linux the variable changes nothing", { skip: process.platform === "win32" }, () => {
    const { runDir, token } = home(); const r = recorder();
    chmodSync(token, 0o644);
    const sp = createSecurePath({ platform: "linux", execFile: r.execFile, logger: r.logger, env: INHERITED, runDir });
    assert.deepEqual(sp(token), { applied: true, mechanism: "chmod" });
    assert.equal(statSync(token).mode & 0o777, 0o600);
    assert.deepEqual(r.calls, []);
  });
});
