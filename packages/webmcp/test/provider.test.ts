import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Ajv2020Import from "ajv/dist/2020.js";
import { SCHEMA, buildCapabilities, validateParams } from "@plur1bus/rpc-schema";
import { buildWebMcpTools, inputSchemaFor, isForbiddenMethod, selectMethods, toolNameFor, type RpcCall, type WebMcpTool } from "../src/index.ts";

const Ajv2020 = ((Ajv2020Import as any).default ?? Ajv2020Import) as typeof Ajv2020Import.default;
const caps = buildCapabilities([]);
const CALLER = { channel: "cli", accountId: "acct", userId: "u1" };

type Call = { method: string; params: Record<string, unknown> };
function fakeCall(result: unknown = { ok: true }): RpcCall & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return typeof result === "function" ? (result as (m: string) => unknown)(method) : result;
  }) as RpcCall & { calls: Call[] };
  fn.calls = calls;
  return fn;
}
const byName = (tools: WebMcpTool[], method: string): WebMcpTool | undefined => tools.find((t) => t.name === toolNameFor(method));
const textOf = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

describe("tool naming and selection", () => {
  it("names tools plur1bus_<method with dots as underscores>", () => {
    assert.equal(toolNameFor("memory.proposals.list"), "plur1bus_memory_proposals_list");
    assert.equal(toolNameFor("core.status"), "plur1bus_core_status");
  });

  it("default = stable methods + memory read ops, never auth/lifecycle/events", () => {
    const methods = selectMethods({ capabilities: caps, schema: SCHEMA });
    assert.deepEqual(methods, ["core.status", "memory.capture", "memory.list", "memory.proposals.list", "memory.recall", "memory.show", "memory.state"]);
  });

  it("experimental methods are opt-in via include", () => {
    const def = selectMethods({ capabilities: caps, schema: SCHEMA });
    assert.ok(!def.includes("memory.forget"));
    const inc = selectMethods({ capabilities: caps, schema: SCHEMA, include: ["memory.forget", "agent.status", "jobs.history"] });
    for (const m of ["memory.forget", "agent.status", "jobs.history"]) assert.ok(inc.includes(m), m);
  });

  it("forbidden methods are never exposed, even when included", () => {
    const forbidden = ["core.auth", "core.shutdown", "core.adopt", "events.subscribe", "events.unsubscribe", "memory.checkpoint", "agent.open", "agent.close", "supervisor.auth", "daemon.stop", "config.set", "config.get", "module.restart"];
    const fakeCaps = { methods: { ...caps.methods } as Record<string, any> };
    const fakeSchema = structuredClone(SCHEMA) as any;
    for (const m of forbidden) {
      assert.ok(isForbiddenMethod(m), m);
      fakeCaps.methods[m] ??= { stability: "stable", since: "1.0.0" };
      fakeSchema.$defs.methods[m] ??= { "x-stability": "stable", "x-since": "1.0.0", params: { type: "object", additionalProperties: false, properties: {} } };
    }
    const tools = buildWebMcpTools({ capabilities: fakeCaps, schema: fakeSchema, call: fakeCall(), include: forbidden });
    for (const m of forbidden) assert.equal(byName(tools, m), undefined, m);
  });

  it("admin methods are never offered as WebMCP tools", () => {
    const admin = (Object.keys(caps.methods)).filter((m) => m.startsWith("admin."));
    assert.equal(admin.length, 7, `the core advertises the admin.* methods: ${admin.join(", ")}`);
    // Even when the handshake calls them stable and core-served and the page names them in include (D55).
    const fakeCaps = { methods: { ...caps.methods } as Record<string, any> };
    const fakeSchema = structuredClone(SCHEMA) as any;
    for (const m of [...admin, "admin.future.op"]) {
      assert.ok(isForbiddenMethod(m), m);
      fakeCaps.methods[m] = { stability: "stable", since: "1.3.0", server: "core" };
      fakeSchema.$defs.methods[m] ??= { "x-stability": "stable", "x-since": "1.3.0", "x-server": "core", params: { type: "object", additionalProperties: false, properties: {} } };
      fakeSchema.$defs.methods[m]["x-stability"] = "stable";
    }
    const include = [...admin, "admin.future.op"];
    assert.deepEqual(selectMethods({ capabilities: fakeCaps, schema: fakeSchema, include }).filter((m) => m.startsWith("admin.")), []);
    const tools = buildWebMcpTools({ capabilities: fakeCaps, schema: fakeSchema, call: fakeCall(), include });
    for (const m of include) assert.equal(byName(tools, m), undefined, m);
  });

  it("secret methods are never offered as WebMCP tools, real or hypothetical (M2)", () => {
    const secret = (Object.keys(caps.methods)).filter((m) => m.startsWith("secret."));
    assert.equal(secret.length, 5, `the core advertises the secret.* methods: ${secret.join(", ")}`);
    const all = [...secret, "secret.future.op"];
    const fakeCaps = { methods: { ...caps.methods } as Record<string, any> };
    const fakeSchema = structuredClone(SCHEMA) as any;
    for (const m of all) {
      assert.ok(isForbiddenMethod(m), m);
      fakeCaps.methods[m] = { stability: "stable", since: "1.5.0", server: "core" };
      fakeSchema.$defs.methods[m] ??= { "x-stability": "stable", "x-since": "1.5.0", "x-server": "core", params: { type: "object", additionalProperties: false, properties: {} } };
      fakeSchema.$defs.methods[m]["x-stability"] = "stable";
    }
    const tools = buildWebMcpTools({ capabilities: fakeCaps, schema: fakeSchema, call: fakeCall(), include: all });
    for (const m of all) assert.equal(byName(tools, m), undefined, m);
  });

  it("ext mutations are refused even as a hypothetical core method", () => {
    const mutations = ["ext.install", "ext.uninstall", "ext.restore", "ext.enable", "ext.disable", "ext.update"];
    const fakeCaps = { methods: { ...caps.methods } as Record<string, any> };
    const fakeSchema = structuredClone(SCHEMA) as any;
    for (const m of mutations) {
      assert.ok(isForbiddenMethod(m), m);
      fakeCaps.methods[m] = { stability: "stable", since: "1.4.0", server: "core" };
      fakeSchema.$defs.methods[m] = { "x-stability": "stable", "x-since": "1.4.0", "x-server": "core", params: { type: "object", additionalProperties: false, properties: {} } };
    }
    assert.deepEqual(selectMethods({ capabilities: fakeCaps, schema: fakeSchema, include: mutations }).filter((m) => m.startsWith("ext.")), []);
    const tools = buildWebMcpTools({ capabilities: fakeCaps, schema: fakeSchema, call: fakeCall(), include: mutations });
    for (const m of mutations) assert.equal(byName(tools, m), undefined, m);
  });

  it("budget.set is refused (a limit is a person's decision); budget.status is not", () => {
    assert.ok(isForbiddenMethod("budget.set"));
    assert.equal(isForbiddenMethod("budget.status"), false);
  });

  it("models.scan, setOverride, removeManual, acknowledge are refused; models.list is opt-in", () => {
    const forbidden = ["models.scan", "models.setOverride", "models.removeManual", "models.acknowledge"];
    for (const m of forbidden) assert.ok(isForbiddenMethod(m), `${m} is forbidden`);
    assert.equal(isForbiddenMethod("models.list"), false, "models.list is not forbidden");

    const fakeCaps = { methods: { ...caps.methods } as Record<string, any> };
    const fakeSchema = structuredClone(SCHEMA) as any;
    for (const m of [...forbidden, "models.list"]) {
      fakeCaps.methods[m] = { stability: "experimental", since: "1.5.0", server: "core" };
      fakeSchema.$defs.methods[m] = { "x-stability": "experimental", "x-since": "1.5.0", "x-server": "core", params: { type: "object", additionalProperties: false, properties: {} } };
    }

    const def = selectMethods({ capabilities: fakeCaps, schema: fakeSchema });
    assert.ok(!def.includes("models.list"));

    const tools = buildWebMcpTools({ capabilities: fakeCaps, schema: fakeSchema, call: fakeCall(), include: forbidden });
    for (const m of forbidden) assert.equal(byName(tools, m), undefined, m);

    const toolsWithList = buildWebMcpTools({ capabilities: fakeCaps, schema: fakeSchema, call: fakeCall(), include: ["models.list"] });
    assert.ok(byName(toolsWithList, "models.list") !== undefined);
  });

  it("ext.list and ext.inspect are not refused by the deny list", () => {
    for (const m of ["ext.list", "ext.inspect", "ext.show"]) assert.equal(isForbiddenMethod(m), false, m);
  });

  it("filters by x-server when present (capability entry or schema def)", () => {
    const fakeCaps = { methods: { ...caps.methods, "memory.recall": { ...caps.methods["memory.recall"]!, server: "supervisor" } } as Record<string, any> };
    assert.ok(!selectMethods({ capabilities: fakeCaps, schema: SCHEMA }).includes("memory.recall"));
    const fakeSchema = structuredClone(SCHEMA) as any;
    fakeSchema.$defs.methods["memory.show"]["x-server"] = "supervisor";
    fakeSchema.$defs.methods["memory.list"]["x-server"] = "core";
    const sel = selectMethods({ capabilities: caps, schema: fakeSchema });
    assert.ok(!sel.includes("memory.show"));
    assert.ok(sel.includes("memory.list"));
  });

  it("only methods present in both capabilities and schema; exclude drops; x-stability key accepted", () => {
    const fakeCaps = { methods: { "memory.recall": { "x-stability": "stable" }, "nope.method": { stability: "stable" } } };
    assert.deepEqual(selectMethods({ capabilities: fakeCaps, schema: SCHEMA }), ["memory.recall"]);
    assert.ok(!selectMethods({ capabilities: caps, schema: SCHEMA, exclude: ["memory.recall"] }).includes("memory.recall"));
  });

  it("deprecated stable methods are not in the default set", () => {
    const fakeCaps = { methods: { "memory.capture": { stability: "stable", deprecated: { since: "1.2.0", removeAfter: "2.0.0", replacement: "x" } } } };
    assert.deepEqual(selectMethods({ capabilities: fakeCaps, schema: SCHEMA }), []);
  });
});

describe("inputSchema", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });

  it("strips caller, inlines $refs, and compiles as a standalone JSON Schema", () => {
    const tools = buildWebMcpTools({ capabilities: caps, schema: SCHEMA, call: fakeCall(), include: ["memory.forget", "memory.proposals.accept", "jobs.history"] });
    assert.ok(tools.length >= 9);
    for (const t of tools) {
      const s = t.inputSchema as any;
      assert.equal(s.type, "object");
      assert.ok(!("caller" in (s.properties ?? {})), `${t.name} has caller`);
      assert.ok(!(s.required ?? []).includes("caller"), `${t.name} requires caller`);
      assert.ok(!JSON.stringify(s).includes("$ref"), `${t.name} has $ref`);
      assert.ok(!JSON.stringify(s).includes('"x-'), `${t.name} has x-*`);
      ajv.compile(s); // throws when invalid
    }
  });

  it("a valid tool input plus the page's caller is valid RPC params", () => {
    const s = inputSchemaFor(SCHEMA, "memory.recall");
    const input = { agentId: "main", query: "coffee" };
    assert.ok(ajv.compile(s)(input));
    assert.deepEqual(validateParams("memory.recall", { ...input, caller: CALLER }), { ok: true });
    assert.equal(ajv.compile(s)({ ...input, caller: CALLER }), false, "caller is not accepted from the agent");
  });

  it("bound params are stripped from the schema and forced into the call", async () => {
    const call = fakeCall({ cards: [] });
    const tools = buildWebMcpTools({ capabilities: caps, schema: SCHEMA, call, bound: { agentId: "main", caller: CALLER } });
    const t = byName(tools, "memory.list")!;
    assert.ok(!("agentId" in (t.inputSchema as any).properties));
    assert.ok(!((t.inputSchema as any).required ?? []).includes("agentId"));
    await t.execute({ agentId: "other", caller: { channel: "cli", accountId: "x", userId: "evil" }, topic: "tea" });
    assert.deepEqual(call.calls[0], { method: "memory.list", params: { topic: "tea", agentId: "main", caller: CALLER } });
  });
});

describe("annotations and descriptions", () => {
  it("readOnlyHint true only for read methods", () => {
    const tools = buildWebMcpTools({ capabilities: caps, schema: SCHEMA, call: fakeCall(), include: ["memory.forget", "memory.correct", "agent.status", "jobs.run"] });
    const ro = Object.fromEntries(tools.map((t) => [t.name, t.annotations.readOnlyHint]));
    for (const m of ["core.status", "memory.recall", "memory.list", "memory.show", "memory.state", "memory.proposals.list", "agent.status"]) assert.equal(ro[toolNameFor(m)], true, m);
    for (const m of ["memory.capture", "memory.forget", "memory.correct", "jobs.run"]) assert.equal(ro[toolNameFor(m)], false, m);
    assert.equal(byName(tools, "memory.recall")!.annotations.untrustedContentHint, true);
    assert.equal(byName(tools, "memory.forget")!.annotations.consequentialHint, true);
  });

  it("uses the schema description when present, else a fallback", () => {
    const fakeSchema = structuredClone(SCHEMA) as any;
    fakeSchema.$defs.methods["memory.recall"].description = "Schema says recall.";
    const tools = buildWebMcpTools({ capabilities: caps, schema: fakeSchema, call: fakeCall() });
    assert.equal(byName(tools, "memory.recall")!.description, "Schema says recall.");
    assert.ok(byName(tools, "memory.show")!.description.length > 10);
  });
});

describe("execute", () => {
  it("read-only tools call without confirmation and wrap the result as JSON text", async () => {
    const call = fakeCall({ cards: [{ id: "m1", text: "likes tea", sessionKey: "s" }] });
    let asked = 0;
    const tools = buildWebMcpTools({ capabilities: caps, schema: SCHEMA, call, confirm: () => { asked++; return true; } });
    const r = await byName(tools, "memory.list")!.execute({ agentId: "main" });
    assert.equal(asked, 0);
    assert.equal(r.isError, undefined);
    assert.equal(r.content[0]!.type, "text");
    assert.deepEqual(textOf(r), { cards: [{ id: "m1", text: "likes tea", sessionKey: "s" }] });
    assert.deepEqual(call.calls, [{ method: "memory.list", params: { agentId: "main" } }]);
  });

  it("drops secret-looking keys from results", async () => {
    const call = fakeCall({ ok: true, token: "t".repeat(64), nested: { apiKey: "k", accessToken: "a", password: "p", tokensEstimate: 3 } });
    const tools = buildWebMcpTools({ capabilities: caps, schema: SCHEMA, call });
    const r = await byName(tools, "core.status")!.execute({});
    assert.deepEqual(textOf(r), { ok: true, nested: { tokensEstimate: 3 } });
  });

  it("maps RPC errors to isError with code/reason only", async () => {
    const secret = "s".repeat(64);
    const cases: [unknown, unknown][] = [
      [{ code: -32000, message: `bad token ${secret}`, data: { error: "E_DENIED", reason: "principal-invalid", detail: `token=${secret}`, ids: { a: "b" } }, token: secret }, { error: "E_DENIED", reason: "principal-invalid" }],
      [{ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "x", data: { error: "E_UNAUTHORIZED", reason: "auth-required" } } }, { error: "E_UNAUTHORIZED", reason: "auth-required" }],
      [Object.assign(new Error(`boom ${secret}`), { code: "E_NOT_FOUND", reason: "no such card" }), { error: "E_NOT_FOUND" }],
      [new TypeError(`fetch failed ${secret}`), { error: "E_INTERNAL" }],
      ["string error", { error: "E_INTERNAL" }],
    ];
    for (const [err, expected] of cases) {
      const tools = buildWebMcpTools({ capabilities: caps, schema: SCHEMA, call: async () => { throw err; } });
      const r = await byName(tools, "memory.recall")!.execute({ agentId: "main", query: "q" });
      assert.equal(r.isError, true);
      assert.deepEqual(textOf(r), expected);
      assert.ok(!r.content[0]!.text.includes(secret));
    }
  });

  it("non-read-only tools require confirmation; decline refuses without calling", async () => {
    const call = fakeCall({ forgotten: true });
    const asked: [string, unknown][] = [];
    let answer = false;
    const tools = buildWebMcpTools({ capabilities: caps, schema: SCHEMA, call, include: ["memory.forget"], confirm: (name, input) => { asked.push([name, input]); return answer; } });
    const t = byName(tools, "memory.forget")!;
    const declined = await t.execute({ agentId: "main", id: "m1", caller: CALLER });
    assert.equal(declined.isError, true);
    assert.deepEqual(textOf(declined), { error: "E_DENIED", reason: "user-declined" });
    assert.equal(call.calls.length, 0);
    assert.deepEqual(asked, [["plur1bus_memory_forget", { agentId: "main", id: "m1" }]]);
    answer = true;
    const ok = await t.execute({ agentId: "main", id: "m1" });
    assert.equal(ok.isError, undefined);
    assert.equal(call.calls.length, 1);
  });

  it("without any confirmation path, data-changing tools fail closed", async () => {
    const call = fakeCall();
    const tools = buildWebMcpTools({ capabilities: caps, schema: SCHEMA, call });
    const r = await byName(tools, "memory.capture")!.execute({ agentId: "main", messages: [{ role: "user", content: "hi" }] }, { requestUserInteraction: async <T,>(cb: () => Promise<T> | T) => cb() });
    assert.equal(r.isError, true);
    assert.equal(call.calls.length, 0);
  });

  it("routes confirmation through requestUserInteraction when the browser offers it", async () => {
    const call = fakeCall();
    const order: string[] = [];
    const tools = buildWebMcpTools({ capabilities: caps, schema: SCHEMA, call, include: ["memory.forget"], confirm: () => { order.push("confirm"); return true; } });
    await byName(tools, "memory.forget")!.execute({ agentId: "main", id: "m1" }, {
      requestUserInteraction: async <T,>(cb: () => Promise<T> | T) => { order.push("rui:start"); const v = await cb(); order.push("rui:end"); return v; },
    });
    assert.deepEqual(order, ["rui:start", "confirm", "rui:end"]);
    assert.equal(call.calls.length, 1);
  });

  it("a throwing confirm counts as decline", async () => {
    const call = fakeCall();
    const tools = buildWebMcpTools({ capabilities: caps, schema: SCHEMA, call, include: ["memory.forget"], confirm: () => { throw new Error("dialog closed"); } });
    const r = await byName(tools, "memory.forget")!.execute({ agentId: "main", id: "m1" });
    assert.equal(r.isError, true);
    assert.equal(call.calls.length, 0);
  });

  it("rejects non-object input and honours an aborted signal", async () => {
    const call = fakeCall();
    const tools = buildWebMcpTools({ capabilities: caps, schema: SCHEMA, call });
    const t = byName(tools, "memory.recall")!;
    assert.equal((await t.execute([1, 2])).isError, true);
    assert.equal((await t.execute("q")).isError, true);
    const ac = new AbortController();
    ac.abort();
    assert.equal((await t.execute({ agentId: "main", query: "q" }, { signal: ac.signal })).isError, true);
    assert.equal(call.calls.length, 0);
  });
});
