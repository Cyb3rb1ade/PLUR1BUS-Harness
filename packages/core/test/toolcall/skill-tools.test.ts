// N-C2/C3: skill resources are read-only, agent-scoped, and confined to safe bounded regular files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createSkillTools } from "../../src/toolcall/skill-tools.ts";
import type { IndexedSkill } from "../../src/toolcall/live-index.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ToolDispatcher } from "../../src/tools/dispatcher.ts";
import { createFsOps, FsFailure } from "../../src/tools/fs/index.ts";
import { denyEntriesFor } from "../../src/host-tools/denylist.ts";
import { useTempDirs } from "../composition/helpers.ts";

const dirs = useTempDirs("n-skill-tools-");
const ctx = { signal: new AbortController().signal, agentId: "agent", principal: "owner" };
const text = "---\r\nname: reports\r\ndescription: Quarterly reports\r\n---\r\n# Reports\r\nUse the reporting workflow.\r\n";

function admitted(name = "reports"): IndexedSkill {
  return {
    entry: { id: `skill:${name}`, name, description: "Quarterly reports", category: "docs.create", kind: "skill",
      effect: "read", risk: "low", source: "skills", version: "fixture" },
    text,
  };
}

async function setup(onLoad?: (name: string) => void) {
  const home = dirs.make();
  const root = join(home, "skills", "reports");
  await mkdir(join(root, "references"), { recursive: true });
  await writeFile(join(root, "SKILL.md"), text);
  await writeFile(join(root, "references", "zebra.txt"), "Zebra reference");
  await writeFile(join(root, "references", "alpha.txt"), "Alpha reference");
  const tools = createSkillTools({ home, skills: [admitted()], ...(onLoad ? { onLoad } : {}) });
  return { home, root, load: tools.find(t => t.name === "skill.load")!, read: tools.find(t => t.name === "skill.read")! };
}

test("skill.load returns the body without frontmatter and a sorted relative file list, then records use", async () => {
  const used: string[] = [];
  const { load } = await setup(name => used.push(name));
  assert.equal(load.trust, "first-party");
  assert.equal(load.effect, "read");
  assert.deepEqual(await load.execute({ name: "reports" }, ctx), {
    name: "reports", text: "# Reports\r\nUse the reporting workflow.\r\n",
    files: ["SKILL.md", "references/alpha.txt", "references/zebra.txt"],
  });
  assert.deepEqual(used, ["reports"]);
});

test("skill tools are absent without admitted skills and refuse names excluded from the agent view", async () => {
  assert.deepEqual(createSkillTools({ home: "/unused", skills: [] }), []);
  const used: string[] = [];
  const { load, read } = await setup(name => used.push(name));
  await assert.rejects(load.execute({ name: "private" }, ctx), { code: "skill-unavailable" });
  await assert.rejects(read.execute({ name: "private", path: "SKILL.md" }, ctx), { code: "skill-unavailable" });
  assert.deepEqual(used, []);
});

test("skill.read returns resource text without executing an executable script", async () => {
  const { root, read } = await setup();
  await writeFile(join(root, "workflow.sh"), "#!/bin/sh\nexit 42\n");
  await chmod(join(root, "workflow.sh"), 0o755);
  assert.deepEqual(await read.execute({ name: "reports", path: "workflow.sh" }, ctx),
    { name: "reports", path: "workflow.sh", text: "#!/bin/sh\nexit 42\n" });
});

test("skill.read rejects traversal, absolute and Windows paths before reading", async () => {
  const { read } = await setup();
  for (const path of ["../secret", "references/../../secret", "/etc/passwd", "C:/Users/private", "C:\\private",
    "references/./alpha.txt", "references//alpha.txt", "references\\..\\secret", "references/alpha.txt\u0000"]) {
    await assert.rejects(read.execute({ name: "reports", path }, ctx), { code: "unsafe-path" }, path);
  }
});

test("skill.read rejects symlink files and directories, even when their targets stay inside the skill", async () => {
  const { home, root, read, load } = await setup();
  await writeFile(join(home, "private.txt"), "PRIVATE");
  await symlink(join(home, "private.txt"), join(root, "escape.txt"), "file");
  await symlink(join(root, "references"), join(root, "alias"), "dir");
  await assert.rejects(read.execute({ name: "reports", path: "escape.txt" }, ctx), { code: "unsafe-path" });
  await assert.rejects(read.execute({ name: "reports", path: "alias/alpha.txt" }, ctx), { code: "unsafe-path" });
  const result = await load.execute({ name: "reports" }, ctx) as { files: string[] };
  assert(!result.files.includes("escape.txt"));
  assert(!result.files.some(path => path.startsWith("alias/")));
});

test("skill tools reject a symlinked skill root and a symlinked skill store", async () => {
  const home = dirs.make();
  const foreign = dirs.make();
  await mkdir(join(foreign, "reports"));
  await writeFile(join(foreign, "reports", "SKILL.md"), text);
  await symlink(foreign, join(home, "skills"), "dir");
  const tool = createSkillTools({ home, skills: [admitted()] })[0]!;
  await assert.rejects(tool.execute({ name: "reports" }, ctx), { code: "unsafe-path" });
  const other = dirs.make();
  await mkdir(join(other, "skills"));
  await symlink(join(foreign, "reports"), join(other, "skills", "reports"), "dir");
  const load = createSkillTools({ home: other, skills: [admitted()] })[0]!;
  await assert.rejects(load.execute({ name: "reports" }, ctx), { code: "unsafe-path" });
});

test("skill files enforce the 64KiB byte cap at the boundary", async () => {
  const { root, load, read } = await setup();
  await writeFile(join(root, "limit.txt"), "x".repeat(64 * 1024));
  const accepted = await read.execute({ name: "reports", path: "limit.txt" }, ctx) as { text: string };
  assert.equal(accepted.text.length, 64 * 1024);
  await writeFile(join(root, "large.txt"), "x".repeat(64 * 1024 + 1));
  await assert.rejects(read.execute({ name: "reports", path: "large.txt" }, ctx), { code: "too-large" });
  await writeFile(join(root, "SKILL.md"), "x".repeat(64 * 1024 + 1));
  await assert.rejects(load.execute({ name: "reports" }, ctx), { code: "too-large" });
});

test("skill reads honor cancellation before opening resources", async () => {
  const { read } = await setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(read.execute({ name: "reports", path: "SKILL.md" }, { ...ctx, signal: controller.signal }),
    { name: "AbortError" });
});

test("skill.load and skill.read register as first-party tools despite the reserved skill RPC prefix", async () => {
  const { home } = await setup();
  const registry = new ToolRegistry();
  for (const tool of createSkillTools({ home, skills: [admitted()] })) registry.register(tool);
  assert.deepEqual(registry.describe().map(tool => tool.name), ["skill.load", "skill.read"]);
});

test("nonregular skill resources are refused without blocking on a FIFO reader", async () => {
  const { home, root } = await setup();
  if (process.platform === "win32") await mkdir(join(root, "nonregular"));
  else execFileSync("mkfifo", [join(root, "nonregular")], { timeout: 5000 });
  const module = new URL("../../src/toolcall/skill-tools.ts", import.meta.url).href;
  const script = `import { createSkillTools } from ${JSON.stringify(module)};
    const tool = createSkillTools(${JSON.stringify({ home, skills: [admitted()] })})[1];
    try { await tool.execute({name:"reports",path:"nonregular"},
      {signal:new AbortController().signal,agentId:"agent",principal:"owner"}); process.exitCode=2; }
    catch(error) { process.stdout.write(error.code); }`;
  const result = execFileSync(process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script], { timeout: 1000, encoding: "utf8" });
  assert.equal(result, "unsafe-path");
});

test("an oversized skill file list fails without recording a successful load", async () => {
  const used: string[] = [];
  const { root, load } = await setup(name => used.push(name));
  for (let i = 0; i < 80; i++) await writeFile(join(root, `${String(i).padStart(2, "0")}-${"x".repeat(220)}`), "x");
  await assert.rejects(load.execute({ name: "reports" }, ctx), { code: "file-list-too-large" });
  assert.deepEqual(used, []);
});

const CREDENTIAL_FILES = [".env", "id_rsa", "credentials.json", ".ssh/config", "keys/server.pem", ".env.production", "auth.json"];

async function withCredentialFiles() {
  const fixture = await setup();
  for (const path of CREDENTIAL_FILES) {
    await mkdir(join(fixture.root, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(fixture.root, ...path.split("/")), `SECRET ${path}`);
  }
  return fixture;
}

test("N2/2: credential-style files in a skill folder are neither listed nor readable", async () => {
  const { load, read } = await withCredentialFiles();
  const listed = (await load.execute({ name: "reports" }, ctx) as { files: string[] }).files;
  assert.deepEqual(listed, ["SKILL.md", "references/alpha.txt", "references/zebra.txt"]);
  for (const path of CREDENTIAL_FILES) {
    await assert.rejects(read.execute({ name: "reports", path }, ctx), { code: "secret-file" }, path);
  }
  // The refusal is typed, path-free and names no content.
  await assert.rejects(read.execute({ name: "reports", path: ".env" }, ctx), (error: Error) => {
    assert.doesNotMatch(error.message, /\.env|SECRET/);
    return true;
  });
});

test("N2/2: skill.read classifies credential paths as deny-list hits so the dispatcher refuses before any read", async () => {
  const { home, read } = await withCredentialFiles();
  const flags = async (path: unknown) => (await read.classify!({ name: "reports", path })).flags.denyListHit;
  for (const path of CREDENTIAL_FILES) assert.equal(await flags(path), true, path);
  assert.equal(await flags("references/alpha.txt"), false);
  assert.equal(await flags("../escape"), false, "traversal is the path check's business, not the deny list's");
  // Through the real dispatcher: denied by policy, and the file is never opened.
  const registry = new ToolRegistry();
  for (const tool of createSkillTools({ home, skills: [admitted()] })) registry.register(tool);
  const dispatcher = new ToolDispatcher({
    registry, clock: { now: () => 1 }, grants: { list: () => [], get: () => undefined },
    approvals: { request: async () => ({ approved: true }) },
  });
  const result = await dispatcher.call({ id: "c", name: "skill.read", args: { name: "reports", path: ".env" } },
    { agentId: "agent", principal: "owner", surface: 3, signal: ctx.signal });
  assert.ok(result.isError);
  assert.equal(result.error.code, "tool-denied");
  assert.match(result.error.message, /deny-list/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test("N2/2: file.read refuses the same paths", async () => {
  const { home, root } = await withCredentialFiles();
  const ops = createFsOps({ roots: [{ id: "skill", path: root }], home, deny: denyEntriesFor(home, {}, "linux") });
  for (const path of CREDENTIAL_FILES.filter(p => !["keys/server.pem", ".env.production"].includes(p))) {
    await assert.rejects(ops.read({ path: join(root, ...path.split("/")) }), (error: unknown) => {
      assert.ok(error instanceof FsFailure);
      assert.equal(error.reason, "deny-listed", path);
      return true;
    }, path);
  }
});
