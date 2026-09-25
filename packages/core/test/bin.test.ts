import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { layout } from "../src/paths.ts";

const dist = new URL("../dist/core.js", import.meta.url).pathname;
if (!existsSync(dist)) execFileSync("pnpm", ["build"], { cwd: new URL("..", import.meta.url).pathname, stdio: "inherit" });

function startCore(home: string) {
  const child = spawn(process.execPath, [dist, "--home", home, "--test-internals", "flat-embedder"], { env: { ...process.env, PLUR1BUS_ALLOW_TEST_INTERNALS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise<{ address: string }>((res, rej) => { child.stdout.once("data", (d) => res(JSON.parse(String(d)))); child.once("exit", (c) => rej(new Error(`exited ${c}`))); });
  return { child, ready };
}

describe("dist/core.js", () => {
  it("starts, answers status, stops cleanly on SIGTERM; a second start exits 3", async () => {
    const home = mkdtempSync(join(tmpdir(), "p1b-bin-")); const l = layout(home);
    const cfg = defaults(); cfg.agents.bernd = {}; cfg.engine = { reranker: { enabled: false }, dreaming: { enabled: false }, neo: { enabled: false } };
    writeFileSync(l.configPath, JSON.stringify(cfg));
    const { child, ready } = startCore(home); const { address } = await ready;
    const token = readFileSync(l.coreToken, "utf8");
    const c = await connect({ address, token }); assert.equal((await c.call<any>("core.status")).process.state, "ready"); await c.close();
    const second = startCore(home); second.ready.catch(() => {}); // exit 3 is expected here; avoid an unhandled rejection from the unawaited `ready` promise
    const code = await new Promise<number | null>((r) => second.child.once("exit", r)); assert.equal(code, 3);
    child.kill("SIGTERM"); const exit = await new Promise<number | null>((r) => child.once("exit", r)); assert.equal(exit, 0);
    assert.equal(existsSync(l.coreSocket) && process.platform !== "win32", false, "socket removed");
  });
  it("refuses --test-internals without the env guard", async () => {
    const child = spawn(process.execPath, [dist, "--home", mkdtempSync(join(tmpdir(), "p1b-bin-")), "--test-internals", "flat-embedder"], { stdio: "ignore" });
    assert.equal(await new Promise((r) => child.once("exit", r)), 2);
  });
});
