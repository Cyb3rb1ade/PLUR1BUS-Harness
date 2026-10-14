// Module audit (agents.ts, agents/**, agent-templates/**): identity of agent names, scaffold safety, export/import symmetry,
// lifecycle on registration failure, and raw errors at the module boundary.
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { defaults } from "@plur1bus/config-schema";
import { createAgentRegistry, scaffoldFiles } from "../src/agents.ts";
import { agentCreation } from "../src/agents/create.ts";
import { exportAgent } from "../src/agents/export.ts";
import { readAgentBundle } from "../src/agents/import.ts";
import { agentRequiredSecrets } from "../src/agents/secrets.ts";
import { registerAgentConfig } from "../src/agents/config.ts";
import { AgentLifecycle } from "../src/agents/lifecycle.ts";
import { lifecycleEngine } from "../src/agents/admission.ts";
import { memoryAuditSink } from "../src/rbac/audit.ts";
import type { Principal } from "../src/rbac/types.ts";
import { layout } from "../src/paths.ts";
import { RpcError } from "../src/rpc/errors.ts";
import type { HarnessLogger } from "../src/logger.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const nullLogger: HarnessLogger = { debug() {}, info() {}, warn() {}, error() {}, child: () => nullLogger, setLevel() {}, setRotation() {}, close: async () => {} };
const owner: Principal = { userId: "person-one", role: "owner", kind: "person" };
const keys = generateKeyPairSync("ed25519");
const signer = async (hash: string) => ({ publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), signature: sign(null, Buffer.from(hash, "hex"), keys.privateKey).toString("base64") });

describe("scaffoldFiles", () => {
  it("refuses ids that are not valid agent names (no path traversal out of agents/)", () => {
    const home = tempDir("p1b-aud-"), l = layout(home);
    for (const id of ["../evil", "a/b", "", "..", "A", "a b", "a\u0000b", "x".repeat(65)]) assert.throws(() => scaffoldFiles(l, id), (e: unknown) => e instanceof RpcError && e.error === "E_INVALID_PARAMS", JSON.stringify(id));
    assert.equal(existsSync(join(home, "evil")), false);
  });
  it("does not follow a dangling symlink planted at a template path", () => {
    const home = tempDir("p1b-aud-"), l = layout(home), outside = join(home, "outside.txt");
    mkdirSync(l.agentDir("bernd"), { recursive: true });
    symlinkSync(outside, join(l.agentDir("bernd"), "SOUL.md"));
    scaffoldFiles(l, "bernd");
    assert.equal(existsSync(outside), false, "the symlink target must not be created");
    assert.ok(existsSync(join(l.agentDir("bernd"), "USER.md")), "the other templates are still written");
  });
});

describe("registry", () => {
  it("path form retries a failed scaffold instead of marking the agent as done", () => {
    const home = tempDir("p1b-aud-"), l = layout(home);
    const cfg = defaults(); cfg.agents.bernd = {}; writeFileSync(l.configPath, JSON.stringify(cfg));
    writeFileSync(l.agents, "blocker"); // agents/ cannot be created while a file sits there
    const reg = createAgentRegistry({ path: l.configPath }, l, nullLogger);
    reg.list();
    assert.equal(existsSync(join(l.agentDir("bernd"), "SOUL.md")), false);
    rmSyncSafe(l.agents);
    reg.list();
    assert.ok(existsSync(join(l.agentDir("bernd"), "SOUL.md")), "second call scaffolds the agent after the cause is gone");
  });
});
import { rmSync } from "node:fs";
const rmSyncSafe = (p: string) => rmSync(p, { recursive: true, force: true });

test("agentRequiredSecrets tolerates prototype-named model profiles, channels and providers", () => {
  const cfg = defaults();
  assert.deepEqual(agentRequiredSecrets(cfg, { model: "toString", channels: ["constructor", "__proto__"] } as any), []);
});

describe("export/import symmetry", () => {
  const setupRoot = () => {
    const root = join(tempDir("p1b-aud-"), "agent");
    for (const d of ["memory", "workspace/memory", "workspace/skills/x"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "SOUL.md"), "soul"); writeFileSync(join(root, "memory/ok.md"), "m");
    return root;
  };
  it("exports only files the import accepts (root-only persona files, no reserved device names)", async () => {
    const root = setupRoot();
    writeFileSync(join(root, "workspace/USER.md"), "u"); writeFileSync(join(root, "workspace/skills/x/IDENTITY.md"), "i");
    writeFileSync(join(root, "memory/nul.md"), "n"); writeFileSync(join(root, "workspace/memory/ok.md"), "w");
    const out = await exportAgent({ root, agentId: "alpha", config: {}, memories: [], signer });
    assert.doesNotThrow(() => readAgentBundle(JSON.parse(JSON.stringify(out))));
    const paths = out.files.map(f => f.path);
    assert.ok(paths.includes("workspace/memory/ok.md") && paths.includes("memory/ok.md") && paths.includes("SOUL.md"));
    assert.ok(!paths.includes("workspace/USER.md") && !paths.includes("memory/nul.md"));
  });
  it("reports unreadable (non UTF-8) source files as a typed error, not a raw TypeError", async () => {
    const root = setupRoot();
    writeFileSync(join(root, "USER.md"), Buffer.from([0xff, 0xfe, 0xfd]));
    await assert.rejects(exportAgent({ root, agentId: "alpha", config: {}, memories: [], signer }), (e: unknown) => e instanceof RpcError && e.error === "E_STORAGE" && !/Unicode|UTF/i.test(e.message));
  });
});

function creationSetup(over: Partial<Parameters<typeof agentCreation>[0]> = {}) {
  const home = tempDir("p1b-aud-"), l = layout(home), config = defaults(), audit = memoryAuditSink(), paused: string[] = [];
  const svc = agentCreation({ config: () => config, layout: l, clock: () => 1000, audit,
    set: async (id, v) => { config.agents[id] = v; }, people: () => ["person-one", "person-two"], setRight: () => {}, secrets: async () => [],
    requiredSecrets: () => [], importMemory: async () => {}, pause: id => { paused.push(id); }, ...over });
  return { l, config, paused, svc };
}
describe("agent creation", () => {
  it("rejects an agent name that equals an existing person ID", () => {
    const s = creationSetup();
    const r = s.svc.validate({ name: "person-two" }, owner);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.field === "name"));
  });
  it("keeps the files and pauses when the config commit failed after the supervisor already applied it", async () => {
    const holder: { config?: ReturnType<typeof creationSetup>["config"] } = {};
    const s = creationSetup({ set: async (id, v) => { holder.config!.agents[id] = v; throw new Error("call timeout after commit"); } });
    holder.config = s.config;
    await assert.rejects(s.svc.create({ name: "alpha", persona: "p" }, owner), (e: unknown) => e instanceof RpcError && e.error === "E_STORAGE");
    assert.equal(existsSync(s.l.agentDir("alpha")), true, "a registered agent keeps its data directory");
    assert.deepEqual(s.paused, ["alpha"]);
    assert.equal(readFileSync(join(s.l.agentDir("alpha"), "SOUL.md"), "utf8"), "p");
  });
});

test("lifecycleEngine reports a deleted agent as deleted (E_NOT_FOUND), like RPC admission", async () => {
  const lc = new AgentLifecycle({ path: ":memory:" });
  lc.set("gone", { deleted: true });
  const engine = { jobs: { run: async () => "ran" } } as any;
  const wrapped = lifecycleEngine(engine, lc);
  await assert.rejects(wrapped.jobs.run("j" as any, "gone", undefined as any), (e: unknown) => e instanceof RpcError && e.error === "E_NOT_FOUND" && e.reason === "deleted");
  lc.close();
});

describe("registerAgentConfig", () => {
  it("does not leak local paths in raw errors", async () => {
    const home = tempDir("p1b-aud-");
    await assert.rejects(registerAgentConfig(layout(home), "alpha", {}), (e: unknown) => e instanceof RpcError && !e.message.includes(home));
  });
  it("refuses an id that would address a nested config key", async () => {
    const home = tempDir("p1b-aud-");
    await assert.rejects(registerAgentConfig(layout(home), "a.b", {}), (e: unknown) => e instanceof RpcError && e.error === "E_INVALID_PARAMS");
  });
});

test("KNOWN GAP: re-creating an agent under the name of a deleted agent leaves it unusable", { todo: "needs a lifecycle reset hook in AgentCreationDeps and its wiring in the composition root (outside this module)" }, () => {
  const lc = new AgentLifecycle({ path: ":memory:" });
  lc.set("alpha", { deleted: true });
  // After a successful agent.create("alpha") the lifecycle row must no longer say deleted.
  assert.equal(lc.usable("alpha"), true);
  lc.close();
});
