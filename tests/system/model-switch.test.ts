import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BIN, cli, coreEnv, home, startDaemon, reapHome } from "./helpers.ts";
test("L9 CLI: --model refuses without confirmation; --yes applies the preview revision before sending", { timeout: 120_000 }, async () => {
  const h = home(), env = coreEnv({ PLUR1BUS_CORE_JS: resolve("tests/system/fixtures/turn-core.mjs"), PLUR1BUS_TEST_TURN_WIRE: "chat_completions", PLUR1BUS_SECRETS_KEYRING: "memory" });
  try {
    cli(h, ["agent", "create", "bernd"]);
    writeFileSync(join(h, "agents", "bernd", "workspace", "fixture.txt"), "fixture bytes");
    startDaemon(h, env);
    execFileSync(BIN, ["--home", h, "--json", "secret", "set", "fixture.key"], { input: "redact-probe-provider-key", env, timeout: 30_000 });
    const refused = spawnSync(BIN, ["--home", h, "--json", "chat", "--agent", "bernd", "--model", "default", "read file fixture.txt"], { env, encoding: "utf8", timeout: 30_000 });
    assert.equal(refused.status, 2); assert.match(refused.stderr, /cache.*rebuild/i); assert.equal(JSON.parse(refused.stdout).applied, false);
    const db = new DatabaseSync(join(h, "state", "sessions.sqlite"), { readOnly: true });
    let id: string;
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM session_model_profiles").get() as { n: number }).n, 0);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n, 0);
      id = (db.prepare("SELECT id FROM sessions WHERE kind='direct'").get() as { id: string }).id;
    } finally { db.close(); }
    const applied = cli(h, ["chat", "--session", id, "--model", "default", "--yes", "read file fixture.txt"], { env });
    assert.equal(applied.state, "completed");
    const check = new DatabaseSync(join(h, "state", "sessions.sqlite"), { readOnly: true });
    try { const row = check.prepare("SELECT profile,revision FROM session_model_profiles WHERE session_id=?").get(id); assert.deepEqual({ ...row }, { profile: "default", revision: 1 }); } finally { check.close(); }
    assert.ok(!readFileSync(join(h, "logs", "core.log"), "utf8").includes("redact-probe-provider-key"));
  } finally { cli(h, ["daemon", "stop"], { env, allowFail: true }); await reapHome(h); rmSync(h, { recursive: true, force: true }); }
});
