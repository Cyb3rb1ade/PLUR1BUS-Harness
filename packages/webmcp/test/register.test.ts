import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getModelContext, normalizePageToolResult, registerPlur1busTools, type NativeTool, type WebMcpTool } from "../src/index.ts";

function tool(name: string, readOnly = true): WebMcpTool {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: readOnly },
    async execute(input, ctx) {
      return { content: [{ type: "text", text: JSON.stringify({ input, hasSignal: !!ctx?.signal, hasRui: !!ctx?.requestUserInteraction }) }] };
    },
  };
}

/** Current CG draft: registerTool(tool, { signal }) -> Promise; InvalidStateError on duplicates. */
function currentMc() {
  const tools = new Map<string, NativeTool>();
  return {
    tools,
    registerTool(t: NativeTool, opts: { signal?: AbortSignal } = {}) {
      if (tools.has(t.name)) return Promise.reject(Object.assign(new Error("duplicate"), { name: "InvalidStateError" }));
      tools.set(t.name, t);
      opts.signal?.addEventListener("abort", () => { if (tools.get(t.name) === t) tools.delete(t.name); });
      return Promise.resolve(undefined);
    },
  };
}
/** Early shape (Chrome 146 flag): sync registerTool, unregisterTool(name), provideContext. */
function legacyMc() {
  const tools = new Map<string, NativeTool>();
  return {
    tools,
    registerTool(t: NativeTool) { if (tools.has(t.name)) throw new Error("duplicate"); tools.set(t.name, t); },
    unregisterTool(name: string) { if (!tools.delete(name)) throw new Error("unknown"); },
  };
}
function provideOnlyMc() {
  const snapshots: string[][] = [];
  return { snapshots, provideContext(c: { tools: NativeTool[] }) { snapshots.push(c.tools.map((t) => t.name).sort()); }, clearContext() { snapshots.push([]); } };
}

describe("registerPlur1busTools", () => {
  it("is a no-op without a ModelContext", () => {
    for (const mc of [undefined, null, {} as any]) {
      const reg = registerPlur1busTools(mc, [tool("a")]);
      reg.unregister();
      reg.unregister();
    }
    assert.equal(getModelContext({}), undefined);
    assert.equal(getModelContext(undefined), undefined);
  });

  it("feature-detects document.modelContext first, then navigator.modelContext", () => {
    const d = currentMc(), n = legacyMc();
    assert.equal(getModelContext({ document: { modelContext: d }, navigator: { modelContext: n } }), d);
    assert.equal(getModelContext({ navigator: { modelContext: n } }), n);
  });

  it("registers and unregisters through the current draft (AbortSignal)", async () => {
    const mc = currentMc();
    const reg = registerPlur1busTools(mc, [tool("a"), tool("b", false)]);
    assert.deepEqual([...mc.tools.keys()].sort(), ["a", "b"]);
    const native = mc.tools.get("b")!;
    assert.deepEqual(native.annotations, { readOnlyHint: false });
    const out = JSON.parse((await native.execute({ x: 1 }, { signal: new AbortController().signal })).content[0]!.text);
    assert.deepEqual(out, { input: { x: 1 }, hasSignal: true, hasRui: false });
    reg.unregister();
    assert.equal(mc.tools.size, 0);
    reg.unregister(); // idempotent
  });

  it("registers and unregisters through the early shape (unregisterTool), passing requestUserInteraction", async () => {
    const mc = legacyMc();
    const reg = registerPlur1busTools(mc, [tool("a")]);
    const out = JSON.parse((await mc.tools.get("a")!.execute(undefined, { requestUserInteraction: async (cb: () => unknown) => cb() })).content[0]!.text);
    assert.deepEqual(out, { input: {}, hasSignal: false, hasRui: true });
    reg.unregister();
    assert.equal(mc.tools.size, 0);
    reg.unregister();
  });

  it("registering again replaces instead of colliding; the stale handle leaves the new tools alone", async () => {
    const mc = currentMc();
    const errors: string[] = [];
    const first = registerPlur1busTools(mc, [tool("a"), tool("b")], { onError: (n) => errors.push(n) });
    const second = registerPlur1busTools(mc, [tool("a")], { onError: (n) => errors.push(n) });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(errors, []);
    assert.deepEqual([...mc.tools.keys()].sort(), ["a", "b"]);
    first.unregister(); // removes b (still first's), keeps a (now second's)
    assert.deepEqual([...mc.tools.keys()], ["a"]);
    second.unregister();
    assert.equal(mc.tools.size, 0);
  });

  it("reports a browser refusal through onError without throwing", async () => {
    const mc = currentMc();
    mc.tools.set("taken", {} as NativeTool); // registered by other page code
    const errors: string[] = [];
    const reg = registerPlur1busTools(mc, [tool("taken")], { onError: (n) => errors.push(n) });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(errors, ["taken"]);
    reg.unregister();
    assert.ok(mc.tools.has("taken"), "other page code's tool is untouched");

    const lm = legacyMc();
    lm.tools.set("dup", {} as NativeTool);
    const errs2: string[] = [];
    registerPlur1busTools(lm, [tool("dup")], { onError: (n) => errs2.push(n) }).unregister();
    assert.deepEqual(errs2, ["dup"]);
  });

  it("falls back to provideContext when registerTool is absent", () => {
    const mc = provideOnlyMc();
    const r1 = registerPlur1busTools(mc, [tool("a"), tool("b")]);
    const r2 = registerPlur1busTools(mc, [tool("c")]);
    assert.deepEqual(mc.snapshots.at(-1), ["a", "b", "c"]);
    r1.unregister();
    assert.deepEqual(mc.snapshots.at(-1), ["c"]);
    r2.unregister();
    assert.deepEqual(mc.snapshots.at(-1), []);
    const n = mc.snapshots.length;
    r2.unregister();
    assert.equal(mc.snapshots.length, n);
  });
});

describe("normalizePageToolResult", () => {
  it("accepts the current draft's JSON string and the early shape's raw value", () => {
    assert.deepEqual(normalizePageToolResult(JSON.stringify({ content: [{ type: "text", text: "hi" }] })), { content: [{ type: "text", text: "hi" }] });
    assert.deepEqual(normalizePageToolResult({ content: [{ type: "text", text: "e" }], isError: true }), { content: [{ type: "text", text: "e" }], isError: true });
    assert.deepEqual(normalizePageToolResult("200"), { content: [{ type: "text", text: "200" }] });
    assert.deepEqual(normalizePageToolResult("not json"), { content: [{ type: "text", text: "not json" }] });
    assert.deepEqual(normalizePageToolResult({ content: [{ type: "image", data: "x" }] }), { content: [{ type: "text", text: '{"type":"image","data":"x"}' }] });
  });
});
