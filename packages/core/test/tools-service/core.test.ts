/** The optional tools process cannot stop Core sessions, including during a tools crash. */
import assert from "node:assert/strict";
import { readFile, writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaults } from "@plur1bus/config-schema";
import type { CoreClient } from "@plur1bus/module-api";
import { runFirstAid } from "../../src/doctor-report.ts";
import { createCore } from "../../src/core.ts";
import { FakeChatProvider } from "../../src/session/provider.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { connect } from "../helpers/connect.ts";

test("Core completes turns before and after tools crashes and reports service readiness", async () => {
  const home = await mkdtemp(join(tmpdir(), "p1b-tools-core-"));
  const previous = process.env.PLUR1BUS_TOOLS_BIN;
  process.env.PLUR1BUS_TOOLS_BIN = resolve(process.env.CARGO_TARGET_DIR ?? fileURLToPath(new URL("../../../../target", import.meta.url)), "debug",
    `plur1bus-tools${process.platform === "win32" ? ".exe" : ""}`);
  const config = defaults();
  config.agents.bernd = {};
  config.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
    reranker: { enabled: false }, duplicateThreshold: 1.01 };
  await writeFile(join(home, "config.json"), JSON.stringify(config));
  const core = createCore({ home, testInternals: flatTestInternals(), chatProvider: new FakeChatProvider(),
    discovery: { scheduler: false }, dreams: { scheduler: false } });
  let connection: CoreClient | undefined;
  try {
    await core.start();
    connection = await connect({ address: core.address, token: await readFile(join(home, "run/core.token"), "utf8") });
    const caller = { channel: "cli", accountId: "fixture", userId: "owner" };
    const created = await connection.call<{ session: { id: string } }>("session.create", { caller, agentId: "bernd" });
    const turn = () => connection!.call<{ state: string }>("session.submit", {
      caller, sessionId: created.session.id, text: "tools isolation", wait: true,
    });
    assert.equal((await turn()).state, "completed");
    const deadline = Date.now() + 10_000;
    while (!core.status().tools?.ready) {
      assert.ok(Date.now() < deadline, "Core did not connect to tools");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const cli = resolve(process.env.CARGO_TARGET_DIR ?? fileURLToPath(new URL("../../../../target", import.meta.url)),
      "debug", `plur1bus${process.platform === "win32" ? ".exe" : ""}`);
    const report = await runFirstAid(home, cli) as { checks: { id: string; status: string }[] };
    assert.equal(report.checks.find(check => check.id === "tools.service")?.status, "ok");
    const toolsPid = core.status().tools!.pid!;
    process.kill(toolsPid, "SIGKILL");
    assert.equal((await turn()).state, "completed");
    assert.equal(core.status().process.state, "ready");
    await assert.rejects(connection.call("tools.health", {}));
  } finally {
    await connection?.close();
    await core.stop();
    if (previous === undefined) delete process.env.PLUR1BUS_TOOLS_BIN;
    else process.env.PLUR1BUS_TOOLS_BIN = previous;
    await rm(home, { recursive: true, force: true });
  }
});
