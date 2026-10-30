// A12 exercises real runModule processes: stable private data, manifest validation, and link refusal before start.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectModule, exitWithin, type ModuleProcess } from "./helpers/module-process.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const entry = fileURLToPath(new URL("./helpers/data-module.ts", import.meta.url));
const live = new Set<ChildProcessWithoutNullStreams>();

after(() => {
  for (const child of live) child.kill("SIGKILL");
});

function install(home: string, name = "fixture"): void {
  const dir = path.join(home, "modules", "fixture");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "module.json"), JSON.stringify({
    name, version: "0.1.0", apiVersion: "1", entry: "index.js", scope: "installation", priority: 500,
  }));
}

function start(home: string, env: NodeJS.ProcessEnv = {}): ModuleProcess {
  const instanceId = randomUUID();
  const child = spawn(process.execPath, [
    "--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", entry,
    "--home", home, "--module", "fixture", "--instance", instanceId,
  ], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  live.add(child);
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.stdout.resume();
  const exited = new Promise<number | null>(resolve => child.once("exit", code => {
    live.delete(child);
    resolve(code);
  }));
  return { child, instanceId, exited, stderr: () => stderr };
}

describe("module persistent data (A12)", () => {
  it("creates a private canonical data directory and preserves its files across restarts", async () => {
    const home = tempDir("p1b-data-");
    const ambient = tempDir("p1b-ambient-data-");
    install(home);
    const expected = path.join(home, "data", "ext", "fixture");
    for (const previous of [null, "persistent module data"]) {
      const child = start(home, { P1X_DATA: ambient });
      const client = await connectModule(home);
      try {
        const status = await client.call<{ detail: { dataDir: string; previous: string | null } }>("module.status", {});
        assert.deepEqual(status.detail, { dataDir: expected, previous });
        assert.equal(readFileSync(path.join(expected, "kept.txt"), "utf8"), "persistent module data");
        if (process.platform !== "win32") {
          for (const relative of ["data", "data/ext", "data/ext/fixture"]) {
            assert.equal(statSync(path.join(home, relative)).mode & 0o777, 0o700);
          }
        }
        assert.equal(existsSync(path.join(ambient, "kept.txt")), false);
      } finally {
        await client.call("module.shutdown", {});
        assert.equal(await exitWithin(child, 15_000), 0, child.stderr());
        await client.close();
      }
    }
  });

  for (const segment of ["data", "data/ext", "data/ext/fixture"]) {
    it(`refuses a linked ${segment} directory before a module can write outside its data tree`, async () => {
      const home = tempDir("p1b-data-link-");
      const target = tempDir("p1b-data-target-");
      install(home);
      const link = path.join(home, segment);
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      const child = start(home);
      assert.equal(await exitWithin(child, 15_000), 1, child.stderr());
      assert.match(child.stderr(), /data directory/);
      assert.equal(existsSync(path.join(target, "kept.txt")), false);
    });
  }

  it("refuses a linked home before creating extension data", async () => {
    const parent = tempDir("p1b-data-home-");
    const target = tempDir("p1b-data-target-");
    install(target);
    const home = path.join(parent, "linked-home");
    symlinkSync(target, home, process.platform === "win32" ? "junction" : "dir");
    const child = start(home);
    assert.equal(await exitWithin(child, 15_000), 1, child.stderr());
    assert.match(child.stderr(), /data directory/);
    assert.equal(existsSync(path.join(target, "data")), false);
  });

  it("validates the manifest name before creating extension data", async () => {
    const home = tempDir("p1b-data-name-");
    install(home, "other");
    const child = start(home);
    assert.equal(await exitWithin(child, 15_000), 2, child.stderr());
    assert.equal(existsSync(path.join(home, "data")), false);
  });
});
