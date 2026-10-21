// D109 §3 / Q17 wiring: the tool classifiers set the call flags the evaluator reads. `systemTree` (home, drive root, system tree)
// and `sandboxed` (exec.run) were computed nowhere, so the T3 / `task` cap and the "not sandboxed" acknowledgement never applied.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { composeTools, type ToolCompositionOptions } from "../../src/composition/tools.ts";
import type { ToolRegistry } from "../../src/tools/registry.ts";
import type { ChatRequest } from "../../src/session/provider.ts";
import { useTempDirs } from "./helpers.ts";

const tmp = useTempDirs("p1b-systree-comp-");
const noAudit = { append() { /* discarded */ } } as never;
const noGrants = { get: () => undefined, list: () => [] };
const turn = (): ChatRequest => ({ sessionId: "s1", agentId: "a1", principal: "user-1", summaries: [], memory: "", messages: [], signal: new AbortController().signal });
const options = (over: Partial<ToolCompositionOptions> = {}): ToolCompositionOptions => ({ home: tmp.make(), roots: [], audit: noAudit, grants: noGrants, ...over });
const get = (r: ToolRegistry, name: string) => r.entries().find((t) => t.name === name)!;
const SYSTEM = process.platform === "win32" ? "C:\\Windows" : "/etc";

describe("file tool classification: systemTree", () => {
  it("a read of a system tree or of the home directory is flagged; a file in the workspace and an ordinary folder are not", async () => {
    const root = tmp.make();
    writeFileSync(join(root, "a.txt"), "x");
    const other = tmp.make();
    const read = get(await composeTools(options({ roots: [{ id: "r", path: root }] }), turn()), "file.stat");
    for (const p of [SYSTEM, homedir()]) {
      const c = await read.classify!({ path: p });
      assert.equal(c?.flags?.systemTree, true, p);
      assert.equal(c?.flags?.outsideRoots, true, p);
    }
    const inside = await read.classify!({ path: join(root, "a.txt") });
    assert.equal(inside?.flags?.systemTree, undefined);
    assert.equal(inside?.flags?.outsideRoots, false);
    const outside = await read.classify!({ path: other });
    assert.equal(outside?.flags?.systemTree, undefined, "an ordinary directory outside the roots is only `outsideRoots`");
    assert.equal(outside?.flags?.outsideRoots, true);
  });
});

describe("exec.run classification: systemTree and sandboxed", () => {
  it("the cwd in a system tree or the home directory is flagged systemTree; a workspace cwd is not", async () => {
    const root = tmp.make();
    mkdirSync(join(root, "build"));
    const exec = get(await composeTools(options({ roots: [{ id: "r", path: root }] }), turn()), "exec.run");
    for (const cwd of [SYSTEM, homedir()]) assert.equal((await exec.classify!({ cwd }))?.flags?.systemTree, true, cwd);
    const inside = await exec.classify!({ cwd: join(root, "build") });
    assert.equal(inside?.flags?.systemTree, undefined);
    assert.equal(inside?.flags?.outsideRoots, false);
  });
  it("sandboxed follows tools.sandbox.required: true by default, false when the owner turned it off", async () => {
    const root = tmp.make();
    const cwd = { cwd: root };
    const roots = [{ id: "r", path: root }];
    assert.equal((await get(await composeTools(options({ roots }), turn()), "exec.run").classify!(cwd))?.flags?.sandboxed, true);
    assert.equal((await get(await composeTools(options({ roots, sandbox: { required: true } }), turn()), "exec.run").classify!(cwd))?.flags?.sandboxed, true);
    assert.equal((await get(await composeTools(options({ roots, sandbox: { required: false } }), turn()), "exec.run").classify!(cwd))?.flags?.sandboxed, false);
  });
});
