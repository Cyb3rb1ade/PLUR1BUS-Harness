/** M: the release supervisor owns the entire HTTP import and recovery lifecycle. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstatSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { BIN, cli, coreEnv, reapHome, startDaemon, waitFor } from "./helpers.ts";

const execute = promisify(execFile);
const MODES = {
  complete: ["imported", "coreRestarted", "offlineStatus", "disabledSkill", "memoryRecall"],
  device: ["imported", "coreRestarted", "offlineStatus", "disabledSkill", "memoryRecall", "deviceMfa"],
  abort: ["aborted", "restored", "baselineExact", "offlineAbort", "offlineStatus", "coreRestarted", "secondImportBusy"],
  rollback: ["imported", "rollback", "restored", "baselineExact", "importedSkillRemoved", "coreRestarted"],
  failure: ["failed", "restored", "baselineExact", "entityAppliedThenUndone", "offlineStatus", "coreRestarted"],
} as const;
const SSH_PROOFS = ["ssh", "bothFamiliesDiscovered", "sourceSelected", "snapshotSealed", "pluginsClassified",
  "mcpDisabled", "importedCards", "disabledSkill", "coreRestarted", "offlineStatus", "noLeaks"] as const;

for (const mode of Object.keys(MODES) as (keyof typeof MODES)[]) {
  it(`release supervisor HTTP import: ${mode}`, { timeout: 180_000 }, async () => {
    const base = mkdtempSync(join(tmpdir(), "p1b-M-"));
    const home = join(base, "Jürgen");
    mkdirSync(home);
    const config = defaults();
    config.engine = { neo: { enabled: false }, reranker: { enabled: false }, dreaming: { enabled: false } };
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
    const env = coreEnv(mode === "failure" ? { PLUR1BUS_TEST_IMPORT_FAIL_AFTER_ENTITY: "1" } : {});
    try {
      startDaemon(home, env);
      await waitFor("actual release Core ready", () => cli(home, ["daemon", "status"]).children
        ?.some((child: { role: string; process: { state: string } }) => child.role === "core"
          && child.process.state === "ready"), 40_000);
      const { stdout } = await execute(process.execPath,
        ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning",
          resolve("packages/api/test/fixtures/import-maintenance-native-stack.mjs"), home, join(base, "source"), mode],
        { env, timeout: 120_000, maxBuffer: 1024 * 1024 });
      const result = JSON.parse(stdout) as Record<string, unknown>;
      for (const proof of MODES[mode]) assert.equal(result[proof], true, `missing actual ${mode} proof: ${proof}`);
    } finally {
      try { cli(home, ["daemon", "stop"], { allowFail: true }); }
      finally { await reapHome(home); rmSync(base, { recursive: true, force: true }); }
    }
  });
}

for (const selector of ["source-a", "source-b"] as const) {
  it(`release supervisor HTTP SSH import: ${selector}`, { timeout: 180_000 }, async () => {
    const server = join(dirname(BIN), "examples", process.platform === "win32" ? "sftp_test_server.exe" : "sftp_test_server");
    const serverStat = lstatSync(server, { throwIfNoEntry: false });
    assert.ok(serverStat?.isFile() && !serverStat.isSymbolicLink(),
      "required prerequisite: build plur1bus-remote-fs --example sftp_test_server alongside the tested CLI binary");
    const base = mkdtempSync(join(tmpdir(), "p1b-M-SSH-"));
    const home = join(base, "Jürgen");
    mkdirSync(home);
    const config = defaults();
    config.engine = { neo: { enabled: false }, reranker: { enabled: false }, dreaming: { enabled: false } };
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
    const env = coreEnv({ PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_SECRETS_KEYRING: "memory" });
    try {
      startDaemon(home, env);
      await waitFor("actual release SSH Core ready", () => cli(home, ["daemon", "status"]).children
        ?.some((child: { role: string; process: { state: string } }) => child.role === "core"
          && child.process.state === "ready"), 40_000);
      const { stdout } = await execute(process.execPath,
        ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning",
          resolve("packages/api/test/fixtures/import-maintenance-ssh-stack.mjs"), home, join(base, "remote"), selector, server],
        { env, timeout: 120_000, maxBuffer: 1024 * 1024 });
      const result = JSON.parse(stdout) as Record<string, unknown>;
      for (const proof of SSH_PROOFS) assert.equal(result[proof], true, `missing actual ${selector} SSH proof: ${proof}`);
    } finally {
      try { cli(home, ["daemon", "stop"], { allowFail: true }); }
      finally { await reapHome(home); rmSync(base, { recursive: true, force: true }); }
    }
  });
}
