import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentToolGroup,
  createDefaultToolRegistry,
  MAX_SKILL_FILE_BYTES,
  McpServerCore,
  McpToolRegistry,
  MemoryToolGroup,
  SkillSecurityError,
  SkillsToolGroup,
  type SkillDescriptor,
} from "../src/mcp/index.ts";

test("McpToolRegistry registers and builds tools selectively", () => {
  const registry = new McpToolRegistry();
  const memoryGroup = new MemoryToolGroup({ includeStore: true });
  const agentGroup = new AgentToolGroup();
  const skillsGroup = new SkillsToolGroup({
    skills: [{ name: "test-skill", description: "A test skill" }],
  });

  registry.registerGroup(memoryGroup);
  registry.registerGroup(agentGroup);
  registry.registerGroup(skillsGroup);

  assert.deepEqual(registry.getRegisteredGroupNames(), ["agent", "memory", "skills"]);
  assert.equal(registry.hasGroup("memory"), true);
  assert.equal(registry.hasGroup("unknown"), false);

  const ctx = { agentId: "agent-a" };

  // Select only memory group
  const memoryTools = registry.buildTools(["memory"], ctx);
  assert.equal(memoryTools.length, 2);
  assert.deepEqual(
    memoryTools.map((t) => t.name),
    ["memory_recall", "memory_store"],
  );

  // Select memory and agent groups
  const memAndAgentTools = registry.buildTools(["memory", "agent"], ctx);
  assert.deepEqual(
    memAndAgentTools.map((t) => t.name),
    ["agent_ask", "agent_status", "memory_recall", "memory_store"],
  );

  // Non-existent group ignored
  const withUnknown = registry.buildTools(["non-existent"], ctx);
  assert.equal(withUnknown.length, 0);
});

test("MemoryToolGroup provides memory_recall with secret redaction and optional memory_store", async () => {
  const calls: Array<{ method: string; params: any }> = [];
  const fakeCore = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "memory.recall") {
        return {
          blocks: [
            {
              id: "b1",
              text: "API secret token: hermes-agent-secret-key-1234567890abcdef",
              topic: "credentials",
            },
          ],
        };
      }
      if (method === "memory.capture") {
        return { ok: true, memoryId: "mem-999" };
      }
      throw new Error(`unknown method ${method}`);
    },
  };

  const defaultGroup = new MemoryToolGroup();
  const defaultTools = defaultGroup.buildTools({ agentId: "agent-x" });
  assert.equal(defaultTools.length, 2);
  assert.equal(defaultTools[0]!.name, "memory_recall");
  assert.equal(defaultTools[1]!.name, "memory_store");

  const fullGroup = new MemoryToolGroup({ includeStore: true });
  const fullTools = fullGroup.buildTools({ agentId: "agent-x", core: fakeCore as any });
  const recallTool = fullTools.find((t) => t.name === "memory_recall")!;
  const storeTool = fullTools.find((t) => t.name === "memory_store")!;

  // 1. memory_recall requires query
  await assert.rejects(async () => {
    await recallTool.handler({ query: "" }, { agentId: "agent-x", core: fakeCore as any });
  }, /query is required/);

  // 2. memory_recall passes parameters and redacts secrets
  const recallRes = await recallTool.handler(
    { query: "find secret", capChars: 5000 },
    { agentId: "agent-x", core: fakeCore as any, rbac: { userId: "user-bob" } as any },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "memory.recall");
  assert.deepEqual(calls[0]!.params, {
    caller: { channel: "mcp", accountId: "user-bob", userId: "user-bob" },
    agentId: "agent-x",
    query: "find secret",
    budget: { capChars: 5000 },
    joined: true,
  });

  // Verify secret token redaction in output
  assert.ok(recallRes && typeof recallRes === "object");
  const blockText = (recallRes as any).blocks[0].text;
  assert.ok(!blockText.includes("hermes-agent-secret-key-1234567890abcdef"));
  assert.ok(blockText.includes("[REDACTED"));

  // 3. memory_store requires text
  await assert.rejects(async () => {
    await storeTool.handler({ text: "" }, { agentId: "agent-x", core: fakeCore as any });
  }, /text is required/);

  // 4. memory_store captures fact
  const storeRes = await storeTool.handler(
    { text: "Remember to buy milk", scope: "workspace", session: "sess-1" },
    { agentId: "agent-x", core: fakeCore as any, rbac: { userId: "user-bob" } as any },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.method, "memory.capture");
  assert.deepEqual(calls[1]!.params, {
    caller: { channel: "mcp", accountId: "user-bob", userId: "user-bob" },
    agentId: "agent-x",
    messages: [{ role: "user", content: "Remember to buy milk" }],
    sessionKey: "sess-1",
    wait: true,
  });
  assert.deepEqual(storeRes, { ok: true, memoryId: "mem-999" });

  // 5. disclose: "never" returns empty memory immediately without RPC call
  const discloseRes = await recallTool.handler(
    { query: "secret stuff", disclose: "never" },
    { agentId: "agent-x", core: fakeCore as any, rbac: { userId: "user-bob" } as any },
  );
  assert.deepEqual(discloseRes, { blocks: [], query: "secret stuff", text: "", joined: "", degraded: { reason: "disclose-never", capability: "recall" } });
  assert.equal(calls.length, 2, "no new RPC call on disclose: never");

  // 6. binding.groups excluding memory returns empty tool list
  const boundNoMemory = fullGroup.buildTools({ agentId: "agent-x", core: fakeCore as any, rbac: { binding: { groups: ["agent"] } } as any });
  assert.equal(boundNoMemory.length, 0);

  // 7. binding.memory.capture: false omits memory_store tool
  const boundNoCapture = fullGroup.buildTools({ agentId: "agent-x", core: fakeCore as any, rbac: { binding: { groups: ["memory"], memory: { capture: false } } } as any });
  assert.equal(boundNoCapture.length, 1);
  assert.equal(boundNoCapture[0]!.name, "memory_recall");
});

test("AgentToolGroup runs agent turns and queries status", async () => {
  const calls: Array<{ method: string; params: any }> = [];
  const fakeCore = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "external.turn.start" || method === "chat.ask") {
        return { reply: "I completed the request." };
      }
      if (method === "agent.read") {
        return { agentId: params.agentId, state: "busy", model: "local-model" };
      }
      throw new Error(`unknown method ${method}`);
    },
  };

  const group = new AgentToolGroup();
  const tools = group.buildTools({ agentId: "agent-y", core: fakeCore as any });
  const askTool = tools.find((t) => t.name === "agent_ask")!;
  const statusTool = tools.find((t) => t.name === "agent_status")!;

  // 1. agent_ask requires message
  await assert.rejects(async () => {
    await askTool.handler({ message: "" }, { agentId: "agent-y", core: fakeCore as any });
  }, /message is required/);

  // 2. agent_ask executes turn
  const askRes = await askTool.handler(
    { message: "Process data" },
    { agentId: "agent-y", core: fakeCore as any, rbac: { userId: "user-alice" } as any, tokenId: "tok-test" },
  );
  assert.deepEqual(askRes, { reply: "I completed the request." });
  assert.equal(calls[0]!.method, "external.turn.start");
  assert.deepEqual(calls[0]!.params, {
    agentId: "agent-y",
    message: "Process data",
    audience: "mcp",
    tokenId: "tok-test",
    wait: true,
  });

  // 3. agent_status queries state
  const statusRes = await statusTool.handler({}, { agentId: "agent-y", core: fakeCore as any });
  assert.deepEqual(statusRes, { agentId: "agent-y", state: "busy", model: "local-model" });
});

test("SkillsToolGroup lists, retrieves metadata and reads resources safely", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "mcp-skills-test-"));
  try {
    const skillPath = join(tmpDir, "calculator");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(skillPath, { recursive: true });
    await writeFile(join(skillPath, "SKILL.md"), "# Calculator Skill\nPerforms arithmetic.", "utf8");
    await writeFile(join(skillPath, ".env"), "SECRET=classified", "utf8");
    await writeFile(join(skillPath, "large.txt"), Buffer.alloc(MAX_SKILL_FILE_BYTES + 1024, "A"));

    const sampleSkills: SkillDescriptor[] = [
      {
        name: "calculator",
        description: "Math utility skill",
        path: skillPath,
        files: ["SKILL.md", ".env", "large.txt"],
        instructions: "# Calculator Skill\nPerforms arithmetic.",
      },
    ];

    const group = new SkillsToolGroup({
      home: tmpDir,
      skills: sampleSkills,
    });

    const tools = group.buildTools({ agentId: "agent-calc" });
    const listTool = tools.find((t) => t.name === "skills/list")!;
    const getTool = tools.find((t) => t.name === "skills/get")!;
    const readTool = tools.find((t) => t.name === "resources/read")!;

    // 1. skills/list
    const listRes = (await listTool.handler({}, { agentId: "agent-calc" })) as any;
    assert.equal(listRes.skills.length, 1);
    assert.equal(listRes.skills[0].name, "calculator");
    assert.ok(listRes.skills[0].digest);

    // 2. skills/get existing
    const getRes = (await getTool.handler({ name: "calculator" }, { agentId: "agent-calc" })) as any;
    assert.equal(getRes.name, "calculator");
    assert.ok(getRes.instructions.includes("Performs arithmetic"));

    // 3. skills/get non-existent throws
    await assert.rejects(
      async () => {
        await getTool.handler({ name: "non-existent" }, { agentId: "agent-calc" });
      },
      (err: any) => err instanceof SkillSecurityError && err.code === "skill-unavailable",
    );

    // 4. resources/read valid file
    const readRes = (await readTool.handler(
      { uri: "skill://calculator/SKILL.md" },
      { agentId: "agent-calc" },
    )) as any;
    assert.equal(readRes.contents.length, 1);
    assert.ok(readRes.contents[0].text.includes("Calculator Skill"));

    // 5. resources/read path traversal forbidden
    await assert.rejects(
      async () => {
        await readTool.handler({ uri: "skill://calculator/../other.txt" }, { agentId: "agent-calc" });
      },
      (err: any) => err instanceof SkillSecurityError && err.code === "unsafe-path",
    );

    // 6. resources/read secret/credential files forbidden
    await assert.rejects(
      async () => {
        await readTool.handler({ uri: "skill://calculator/.env" }, { agentId: "agent-calc" });
      },
      (err: any) => err instanceof SkillSecurityError && err.code === "secret-file",
    );

    // 7. resources/read file exceeding 64 KiB rejected
    await assert.rejects(
      async () => {
        await readTool.handler({ uri: "skill://calculator/large.txt" }, { agentId: "agent-calc" });
      },
      (err: any) => err instanceof SkillSecurityError && err.code === "too-large",
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Default registry integrates seamlessly with McpServerCore", async () => {
  const registry = createDefaultToolRegistry({
    skills: {
      skills: [{ name: "greeter", description: "Greets people" }],
    },
  });

  const tools = registry.buildTools(["skills"], { agentId: "agent-1" });
  const server = new McpServerCore({
    tools,
    agentId: "agent-1",
  });

  // Verify tool definitions via list
  const listTools = server.getTools();
  assert.equal(listTools.length, 3);
  assert.deepEqual(
    listTools.map((t) => t.name),
    ["resources/read", "skills/get", "skills/list"],
  );

  // Call skills/list through server core
  const callRes = (await server.executeTool("skills/list", {})) as any;
  assert.equal(callRes.isError, undefined);
  const parsed = JSON.parse(callRes.content[0].text);
  assert.equal(parsed.skills.length, 1);
  assert.equal(parsed.skills[0].name, "greeter");
});
