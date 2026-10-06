import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../src/logger.ts";
import { tempDir } from "./helpers/temp-dir.ts";

describe("logger", () => {
  it("creates its log directory as private on POSIX", { skip: process.platform === "win32" ? "POSIX permissions are not available on Windows" : false, timeout: 5000 }, async () => {
    const dir = join(tempDir("p1b-log-"), "logs");
    const log = createLogger({ file: join(dir, "core.log"), level: "info", role: "core" });
    await log.close();
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  it("tightens an existing log directory on POSIX", { skip: process.platform === "win32" ? "POSIX permissions are not available on Windows" : false, timeout: 5000 }, async () => {
    const dir = join(tempDir("p1b-log-"), "logs");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const log = createLogger({ file: join(dir, "core.log"), level: "info", role: "core" });
    await log.close();
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  it("writes JSON lines with level, role, fields and honours the level", async () => {
    const file = join(tempDir("p1b-log-"), "core.log");
    const log = createLogger({ file, level: "info", role: "core" });
    log.debug("hidden"); log.info("hello", { agentId: "bernd" });
    log.child({ requestId: "r1" }).warn("child");
    await log.close();
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual({ level: lines[0].level, role: lines[0].role, msg: lines[0].msg, agentId: lines[0].agentId }, { level: "info", role: "core", msg: "hello", agentId: "bernd" });
    assert.equal(lines[1].requestId, "r1"); assert.match(lines[1].at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("rotates at maxBytes and keeps at most keep files", async () => {
    const dir = tempDir("p1b-log-"); const file = join(dir, "core.log");
    const log = createLogger({ file, level: "info", role: "core", maxBytes: 200, keep: 2 });
    for (let i = 0; i < 50; i++) log.info("line", { i });
    await log.close();
    assert.ok(existsSync(file) && existsSync(`${file}.1`) && existsSync(`${file}.2`), "core.log, .1 and .2 exist");
    assert.equal(existsSync(`${file}.3`), false, "no .3 with keep 2");
    for (const f of [file, `${file}.1`, `${file}.2`]) assert.ok(statSync(f).size <= 200, `${f} is at most maxBytes`);
    // Oldest first: .2, .1, core.log. What survives is a gap-free run of lines ending with the last one written.
    const seq = [`${file}.2`, `${file}.1`, file].flatMap((f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l).i as number));
    assert.equal(seq.at(-1), 49);
    seq.forEach((v, k) => { if (k > 0) assert.equal(v, seq[k - 1]! + 1, `line ${seq[k - 1]! + 1} is lost`); });
  });

  it("setRotation applies new limits from the next write", async () => {
    const dir = tempDir("p1b-log-"); const file = join(dir, "core.log");
    const log = createLogger({ file, level: "info", role: "core", maxBytes: 1_000_000, keep: 1 });
    for (let i = 0; i < 20; i++) log.info("line", { i });
    assert.equal(existsSync(`${file}.1`), false, "no rotation under the first limit");
    log.setRotation({ maxBytes: 200, keep: 3 });
    for (let i = 20; i < 60; i++) log.info("line", { i });
    await log.close();
    assert.ok(existsSync(`${file}.3`) && !existsSync(`${file}.4`), "keep 3 now");
    assert.ok(statSync(file).size <= 200, "maxBytes 200 now");
  });

  it("appends to an existing file and rotates it when it is already full", async () => {
    const dir = tempDir("p1b-log-"); const file = join(dir, "core.log");
    const first = createLogger({ file, level: "info", role: "core", maxBytes: 200, keep: 1 });
    first.info("a"); await first.close();
    const second = createLogger({ file, level: "info", role: "core", maxBytes: 200, keep: 1 });
    second.info("b"); second.info("c"); await second.close();
    const all = [`${file}.1`, file].flatMap((f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l).msg));
    assert.deepEqual(all.slice(-2), ["b", "c"]);
  });

  it("a rotation that cannot reopen the file never throws and the logger recovers on a later write", async () => {
    const dir = join(tempDir("p1b-log-"), "logs"); mkdirSync(dir); const file = join(dir, "core.log");
    const log = createLogger({ file, level: "info", role: "core", maxBytes: 200, keep: 2 });
    log.info("before");
    rmSync(dir, { recursive: true, force: true });
    assert.doesNotThrow(() => { for (let i = 0; i < 10; i++) log.info("lost", { i }); });
    mkdirSync(dir);
    log.info("after");
    await log.close();
    assert.match(readFileSync(file, "utf8"), /"msg":"after"/);
  });
});
