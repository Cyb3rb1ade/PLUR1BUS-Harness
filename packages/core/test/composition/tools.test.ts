import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeTools, ToolAdapterError, type ToolCompositionOptions } from "../../src/composition/tools.ts";
import { RegistryError, type ToolDef, type ToolRegistry, type ToolRunContext } from "../../src/tools/registry.ts";
import { CallBudgetExceededError } from "../../src/budget/index.ts";
import { WebFailure } from "../../src/tools/web/failure.ts";
import { OutputStore, MediaError } from "../../../media/src/index.ts";
import { makePng } from "../../../media/test/adapters-fixtures.ts";
import type { ChatRequest } from "../../src/session/provider.ts";
import { useTempDirs } from "./helpers.ts";

const tmp = useTempDirs("p1b-tools-comp-");
const noAudit = { append() { /* discarded */ } } as never;
const noGrants = { get: () => undefined, list: () => [] };
const turn = (over: Partial<ChatRequest> = {}): ChatRequest => ({ sessionId: "s1", agentId: "a1", principal: "user-1", summaries: [], memory: "", messages: [], signal: new AbortController().signal, ...over });
const run = (signal = new AbortController().signal): ToolRunContext => ({ signal, agentId: "a1", principal: "user-1", sessionId: "s1", surface: 0 });
const options = (over: Partial<ToolCompositionOptions> = {}): ToolCompositionOptions => ({ home: tmp.make(), roots: [], audit: noAudit, grants: noGrants, ...over });
const names = (r: ToolRegistry) => r.entries().map((t) => t.name);
const get = (r: ToolRegistry, name: string) => r.entries().find((t) => t.name === name)!;

// From docs/host-tools.md: the D106 catalogue and its capability and risk.
const HOST: Record<string, [string, string]> = {
  "sys.info": ["sys.read", "low"], "sys.disks": ["sys.read", "low"], "sys.network": ["sys.read", "low"], "sys.battery": ["sys.read", "low"],
  "proc.list": ["sys.read", "low"], "proc.info": ["sys.read", "low"], "proc.kill": ["proc.signal", "medium"], "proc.wait": ["sys.read", "low"],
  "pkg.detect": ["sys.read", "low"], "pkg.search": ["sys.read", "low"], "pkg.list-installed": ["sys.read", "low"], "pkg.info": ["sys.read", "low"],
  "pkg.install": ["pkg.change", "high"], "pkg.remove": ["pkg.change", "high"],
  "apps.list": ["sys.read", "low"], "apps.open": ["sys.read", "low"], "apps.running": ["sys.read", "low"],
  "clipboard.read": ["clipboard.read", "low"], "clipboard.write": ["clipboard.read", "low"], notify: ["sys.read", "low"],
};

describe("composition/tools composeTools: what gets registered", () => {
  it("without roots there are no file tools: the host catalogue and exec.run only", async () => {
    const reg = await composeTools(options(), turn());
    assert.deepEqual(names(reg).filter((n) => n.startsWith("file.")), []);
    assert.deepEqual([...names(reg)].sort(), [...Object.keys(HOST), "exec.run"].sort());
  });

  it("with a root the four file tools come first, then the host tools, then exec.run", async () => {
    const reg = await composeTools(options({ roots: [{ id: "r", path: tmp.make() }] }), turn());
    const all = names(reg);
    assert.deepEqual(all.slice(0, 4), ["file.read", "file.write", "file.list", "file.stat"]);
    assert.equal(all.at(-1), "exec.run");
    assert.deepEqual([...all.slice(4, -1)].sort(), Object.keys(HOST).sort());
  });

  it("the same options give the same names in the same order, every time", async () => {
    const o = options({ roots: [{ id: "r", path: tmp.make() }] });
    const first = names(await composeTools(o, turn()));
    for (let i = 0; i < 3; i++) assert.deepEqual(names(await composeTools(o, turn())), first);
  });

  it("every registry is a fresh instance: no state is shared between turns", async () => {
    const o = options({ extra: [] });
    const a = await composeTools(o, turn()); const b = await composeTools(o, turn());
    assert.notEqual(a, b);
    a.register({ name: "only.in.a", description: "x", inputSchema: { type: "object" }, capability: "sys.read", effect: "read", risk: "low", execute: async () => 1 });
    assert.equal(names(b).includes("only.in.a"), false);
  });

  for (const [name, [capability, risk]] of Object.entries(HOST)) {
    it(`host tool ${name}: ${capability}, risk ${risk}, first-party, and every call is classified outside the roots (fail closed)`, async () => {
      const t = get(await composeTools(options(), turn()), name);
      assert.equal(t.capability, capability); assert.equal(t.risk, risk); assert.equal(t.trust, "first-party");
      assert.equal((await t.classify!({}))?.flags?.outsideRoots, true);
    });
  }

  it("exec.run is registered as shell.exec, local-write, medium risk", async () => {
    const t = get(await composeTools(options(), turn()), "exec.run");
    assert.deepEqual([t.capability, t.effect, t.risk, t.trust], ["shell.exec", "local-write", "medium", "first-party"]);
    assert.equal(t.inputSchema.additionalProperties, false);
  });

  it("file tools: read-class tools use fs.read, write tools fs.write, first-party, 1 MiB result cap", async () => {
    const reg = await composeTools(options({ roots: [{ id: "r", path: tmp.make() }] }), turn());
    for (const n of ["file.read", "file.list", "file.stat"]) assert.equal(get(reg, n).capability, "fs.read", n);
    assert.equal(get(reg, "file.write").capability, "fs.write");
    for (const n of ["file.read", "file.write", "file.list", "file.stat"]) { assert.equal(get(reg, n).trust, "first-party"); assert.equal(get(reg, n).limits.maxResultBytes, 1024 * 1024); assert.equal(get(reg, n).risk, "low"); }
  });
});

describe("composition/tools composeTools: extra tools and conflicts", () => {
  const extra = (name: string): ToolDef => ({ name, description: "extra", inputSchema: { type: "object" }, capability: "sys.read", effect: "read", risk: "low", execute: async () => name });

  it("extra tools are registered after the built-ins, in the given order", async () => {
    const reg = await composeTools(options({ extra: [extra("zeta.tool"), extra("alpha.tool")] }), turn());
    assert.deepEqual(names(reg).slice(-2), ["zeta.tool", "alpha.tool"]);
  });

  it("an extra tool with a built-in's name is refused, never silently overriding it", async () => {
    await assert.rejects(() => composeTools(options({ extra: [extra("exec.run")] }), turn()), (e) => e instanceof RegistryError && e.reason === "duplicate");
    await assert.rejects(() => composeTools(options({ extra: [extra("sys.info")] }), turn()), (e) => e instanceof RegistryError && e.reason === "duplicate");
  });

  it("two extra tools with the same name are refused", async () => {
    await assert.rejects(() => composeTools(options({ extra: [extra("dup.tool"), extra("dup.tool")] }), turn()), (e) => e instanceof RegistryError && e.reason === "duplicate");
  });

  it("an extra tool that fails registry validation fails the whole composition", async () => {
    await assert.rejects(() => composeTools(options({ extra: [{ ...extra("Bad Name") }] }), turn()), (e) => e instanceof RegistryError && e.reason === "name");
    await assert.rejects(() => composeTools(options({ extra: [{ ...extra("ok.tool"), capability: "no.such.capability" }] }), turn()), (e) => e instanceof RegistryError && e.reason === "capability");
  });
});

describe("composition/tools composeTools: file tools stay inside their roots", () => {
  function layout() {
    const base = tmp.make();
    const home = join(base, "home"), root = join(base, "root"), outside = join(base, "outside");
    for (const d of [join(home, "state"), join(home, "run"), root, outside]) mkdirSync(d, { recursive: true });
    writeFileSync(join(root, "a.txt"), "inside");
    writeFileSync(join(outside, "o.txt"), "outside-marker");
    writeFileSync(join(home, "state", "secret.txt"), "state-marker");
    symlinkSync(outside, join(root, "dirlink"));
    symlinkSync(join(outside, "o.txt"), join(root, "filelink"));
    return { base, home, root, outside };
  }
  async function reg(l: ReturnType<typeof layout>, extraRoots: { id: string; path: string }[] = []) {
    return composeTools({ home: l.home, roots: [{ id: "r", path: l.root }, ...extraRoots], audit: noAudit, grants: noGrants }, turn());
  }

  it("classification: a path inside the root is inside, with the canonical target", async () => {
    const l = layout(); const t = get(await reg(l), "file.read");
    for (const p of ["a.txt", join(l.root, "a.txt"), "sub/new.txt"]) {
      const c = await t.classify!({ path: p });
      assert.deepEqual(c?.flags, { outsideRoots: false, denyListHit: false }, p);
      assert.equal(c?.access, "read");
      assert.ok(c?.targets?.[0]!.startsWith(l.root), p);
    }
    assert.equal((await get(await reg(l), "file.write").classify!({ path: "a.txt" }))?.access, "write");
  });

  const outsideCases: [string, (l: ReturnType<typeof layout>) => string][] = [
    ["an absolute path elsewhere", (l) => join(l.outside, "o.txt")],
    ["a sibling reached with ..", () => "../outside/o.txt"],
    ["a directory symlink pointing out", () => "dirlink/o.txt"],
    ["a file symlink pointing out", () => "filelink"],
    ["/etc/passwd", () => "/etc/passwd"],
  ];
  for (const [name, path] of outsideCases) {
    it(`classification: ${name} is outside the roots`, async () => {
      const l = layout(); const c = await get(await reg(l), "file.read").classify!({ path: path(l) });
      assert.equal(c?.flags?.outsideRoots, true);
    });
    it(`execution: ${name} is refused even though classification only asks for approval`, async () => {
      const l = layout(); const t = get(await reg(l), "file.read");
      await assert.rejects(async () => { const out = await t.execute({ path: path(l) }, run()); assert.fail(`read succeeded: ${JSON.stringify(out)}`); }, (e) => e instanceof ToolAdapterError && e.code === "tool-failed");
    });
  }

  it("execution: reads inside the root work", async () => {
    const l = layout(); const out = await get(await reg(l), "file.read").execute({ path: "a.txt" }, run());
    assert.match(JSON.stringify(out), /inside/);
  });

  it("execution: a write outside the root is refused and nothing is created", async () => {
    const l = layout(); const target = join(l.outside, "new.txt");
    const t = get(await reg(l), "file.write");
    await assert.rejects(() => t.execute({ path: target, content: "x" }, run()), ToolAdapterError);
    await assert.rejects(() => t.execute({ path: "dirlink/new.txt", content: "x" }, run()), ToolAdapterError);
    assert.equal(existsSync(target), false);
    assert.equal(readFileSync(join(l.outside, "o.txt"), "utf8"), "outside-marker");
  });

  it("the harness state and run directories are denied even when the home is itself a granted root", async () => {
    const l = layout(); const r = await reg(l, [{ id: "home", path: l.home }]);
    for (const p of [join(l.home, "state", "secret.txt"), join(l.home, "run"), join(l.home, "state")]) {
      const c = await get(r, "file.read").classify!({ path: p });
      assert.equal(c?.flags?.denyListHit, true, p);
      await assert.rejects(() => get(r, "file.read").execute({ path: p }, run()), ToolAdapterError, p);
    }
  });

  it("a custom deny entry is honoured and listed beside the built-in ones", async () => {
    const l = layout(); mkdirSync(join(l.root, "private")); writeFileSync(join(l.root, "private", "x.txt"), "x");
    const r = await composeTools({ home: l.home, roots: [{ id: "r", path: l.root }], deny: [{ path: join(l.root, "private") }], audit: noAudit, grants: noGrants }, turn());
    assert.equal((await get(r, "file.read").classify!({ path: "private/x.txt" }))?.flags?.denyListHit, true);
    await assert.rejects(() => get(r, "file.read").execute({ path: "private/x.txt" }, run()), ToolAdapterError);
  });

  it("malformed paths are classified as denied rather than crashing classification", async () => {
    const l = layout(); const t = get(await reg(l), "file.read");
    for (const p of ["", "a\0b", "~/.ssh/id_rsa"]) {
      const c = await t.classify!({ path: p });
      assert.equal(c?.flags?.outsideRoots, true, JSON.stringify(p)); assert.equal(c?.flags?.denyListHit, true, JSON.stringify(p));
    }
  });
});

describe("composition/tools composeTools: exec.run", () => {
  const exec = async (o: Partial<ToolCompositionOptions>, args: unknown) => {
    const reg = await composeTools(options(o), turn());
    return get(reg, "exec.run").execute(args, run());
  };
  const refusedWith = (code: string) => (e: unknown) => e instanceof ToolAdapterError && e.code === "tool-failed" && JSON.stringify(e.detail).includes(code);

  it("default mode is deny: nothing starts, whatever the arguments", async () => {
    const root = tmp.make();
    await assert.rejects(() => exec({ roots: [{ id: "r", path: root }] }, { program: "true", cwd: root }), refusedWith("disabled"));
    await assert.rejects(() => exec({ roots: [{ id: "r", path: root }], exec: {} }, { program: "true", cwd: root }), refusedWith("disabled"));
  });

  it("allowlist mode: a program that is not listed is refused before it starts", async () => {
    const root = tmp.make();
    await assert.rejects(() => exec({ roots: [{ id: "r", path: root }], exec: { mode: "allowlist", allowlist: [{ program: "git" }] } }, { program: "rm", args: ["-rf", "x"], cwd: root }), refusedWith("not-allowlisted"));
  });

  it("the working directory must be inside a granted root", async () => {
    const root = tmp.make(); const other = tmp.make();
    await assert.rejects(() => exec({ roots: [{ id: "r", path: root }], exec: { mode: "allowlist", allowlist: [{ program: "git" }] } }, { program: "git", cwd: other }), refusedWith("cwd-refused"));
  });

  it("without any root there is no valid working directory", async () => {
    const dir = tmp.make();
    await assert.rejects(() => exec({ exec: { mode: "allowlist", allowlist: [{ program: "git" }] } }, { program: "git", cwd: dir }), refusedWith("cwd-refused"));
  });

  it("unknown arguments and non-object input are rejected as invalid input", async () => {
    const root = tmp.make();
    const o = { roots: [{ id: "r", path: root }], exec: { mode: "allowlist" as const, allowlist: [{ program: "git" }] } };
    await assert.rejects(() => exec(o, { program: "git", cwd: root, shell: true }), refusedWith("invalid-input"));
    await assert.rejects(() => exec(o, "git status"), refusedWith("invalid-input"));
    await assert.rejects(() => exec(o, null), refusedWith("invalid-input"));
  });

  it("a shell as the program is refused", async () => {
    const root = tmp.make();
    await assert.rejects(() => exec({ roots: [{ id: "r", path: root }], exec: { mode: "allowlist", allowlist: [{ program: "sh" }, { program: "bash" }] } }, { program: "sh", args: ["-c", "id"], cwd: root }), ToolAdapterError);
  });
});

describe("composition/tools composeTools: media generate and edit", () => {
  const fakeAdapter = (over: Record<string, unknown> = {}) => {
    const calls: { op: string; request: unknown }[] = [];
    const adapter = {
      id: "fixture", model: "synthetic-1", capabilities: () => ({ generate: true, edit: true, inpaint: false }),
      generate: async (request: unknown) => { calls.push({ op: "generate", request }); return { files: [{ bytes: makePng(), format: "png" }], metadata: { adapter: "fixture", model: "synthetic-1", durationMs: 1 } }; },
      edit: async (request: unknown) => { calls.push({ op: "edit", request }); return { files: [{ bytes: makePng(), format: "png" }], metadata: { adapter: "fixture", model: "synthetic-1", durationMs: 1 } }; },
      ...over,
    };
    return { adapter: adapter as never, calls };
  };
  const fakeBudget = (decision: "allow" | "refuse" = "allow") => {
    const events: [string, unknown][] = [];
    const budget = {
      checkBeforeCall: (r: unknown) => { events.push(["check", r]); return decision === "allow" ? { kind: "allow", reservationId: "res-1" } : { kind: "refuse", code: "budget_exceeded", reason: "hard", scope: "global", id: "", metric: "cost", limit: 1, used: 1 }; },
      settle: (id: string, usage: unknown) => { events.push(["settle", { id, usage }]); return { recorded: true, costMicros: 0, overages: [] }; },
      releaseUnused: (id: string) => { events.push(["release", id]); },
    };
    return { budget: budget as never, events };
  };
  const mk = async (adapterOver: Record<string, unknown> = {}, b = fakeBudget()) => {
    const home = tmp.make(); const a = fakeAdapter(adapterOver);
    const reg = await composeTools({ home, roots: [], audit: noAudit, grants: noGrants, budget: b.budget, media: { adapter: a.adapter, store: new OutputStore(join(home, "outputs")) } }, turn());
    return { reg, ...a, ...b };
  };

  it("offers image.generate and image.edit when the adapter can; the money-class capability gates both", async () => {
    const { reg } = await mk();
    for (const n of ["image.generate", "image.edit"]) { const t = get(reg, n); assert.deepEqual([t.capability, t.effect, t.risk], ["net.submit", "money", "high"], n); }
    assert.equal(names(reg).some((n) => n.startsWith("media.")), false, "no media.* capability exists in this build");
  });

  it("an adapter without edit support gets no image.edit tool", async () => {
    const { reg } = await mk({ capabilities: () => ({ generate: true, edit: false, inpaint: false }) });
    assert.equal(names(reg).includes("image.generate"), true);
    assert.equal(names(reg).includes("image.edit"), false);
  });

  it("no media option: no media tools at all", async () => {
    const reg = await composeTools(options(), turn());
    assert.equal(names(reg).some((n) => n.startsWith("image.") || n.startsWith("media.")), false);
  });

  it("generate: admits against the budget with the adapter identity, stores the output and settles the produced quantity", async () => {
    const { reg, events, calls } = await mk();
    const out = await get(reg, "image.generate").execute({ prompt: "a cat", n: 1 }, run()) as { id: string; files: unknown[] };
    assert.match(out.id, /^[0-9a-f-]{36}$/); assert.equal(out.files.length, 1);
    assert.equal(calls.length, 1);
    const check = events[0]![1] as Record<string, unknown>;
    assert.equal(events[0]![0], "check");
    assert.deepEqual([check.principal, check.agent, check.provider, check.model, check.session, check.project], ["user-1", "a1", "fixture", "synthetic-1", "s1", "direct"]);
    assert.deepEqual(events.map((e) => e[0]), ["check", "settle"]);
    assert.deepEqual((events[1]![1] as { usage: { media: unknown[] } }).usage.media, [{ kind: "image", resolution: "default", quantity: 1 }]);
  });

  it("a budget refusal is a typed budget_exceeded error and the adapter is never called", async () => {
    const { reg, calls, events } = await mk({}, fakeBudget("refuse"));
    await assert.rejects(() => get(reg, "image.generate").execute({ prompt: "a cat" }, run()), (e) => e instanceof CallBudgetExceededError && e.code === "budget_exceeded");
    assert.equal(calls.length, 0);
    assert.deepEqual(events.map((e) => e[0]), ["check"], "nothing was reserved, so nothing is settled or released");
  });

  it("a failed generation returns nothing, releases the reservation and never settles", async () => {
    const { reg, events } = await mk({ generate: async () => { throw new Error("provider failure"); } });
    await assert.rejects(() => get(reg, "image.generate").execute({ prompt: "a cat" }, run()), /provider failure/);
    assert.deepEqual(events.map((e) => e[0]), ["check", "release"]);
  });

  it("an aborted generation settles the requested quantity instead of releasing (it may still bill remotely)", async () => {
    const ac = new AbortController();
    const { reg, events } = await mk({ generate: async () => { ac.abort(new Error("stop")); throw new Error("aborted by caller"); } });
    await assert.rejects(() => get(reg, "image.generate").execute({ prompt: "a cat", n: 3 }, run(ac.signal)), /aborted by caller/);
    assert.deepEqual(events.map((e) => e[0]), ["check", "settle"]);
    assert.deepEqual((events[1]![1] as { usage: { media: { quantity: number }[] } }).usage.media[0]!.quantity, 3);
  });

  it("edit without reference images is refused before the adapter runs", async () => {
    const { reg, calls } = await mk();
    await assert.rejects(() => get(reg, "image.edit").execute({ prompt: "make it blue" }, run()), (e) => e instanceof MediaError && e.code === "unsupported_parameter");
    assert.equal(calls.length, 0);
  });

  it("edit only takes references from the private output store, never a path", async () => {
    const { reg, calls } = await mk();
    await assert.rejects(() => get(reg, "image.edit").execute({ prompt: "x", referenceIds: ["00000000-0000-0000-0000-000000000000"] }, run()), (e) => e instanceof MediaError && e.code === "unsupported_parameter");
    assert.equal(calls.length, 0);
    const t = get(reg, "image.edit");
    assert.equal(t.inputSchema.additionalProperties, false, "no free-form path argument can be added");
    assert.deepEqual(Object.keys(t.inputSchema.properties as object).filter((k) => /path|file|url/i.test(k)), [], "no path-like parameter exists");
  });

  it("edit with a reference previously generated into the store works end to end", async () => {
    const { reg, calls } = await mk();
    const made = await get(reg, "image.generate").execute({ prompt: "base" }, run()) as { id: string };
    const edited = await get(reg, "image.edit").execute({ prompt: "variation", referenceIds: [made.id] }, run()) as { id: string };
    assert.notEqual(edited.id, made.id);
    assert.deepEqual(calls.map((c) => c.op), ["generate", "edit"]);
    assert.equal((calls[1]!.request as { referenceImages: { bytes: Uint8Array }[] }).referenceImages[0]!.bytes.length, makePng().length);
  });

  it("without a budget the tool still works (the budget is optional in composition)", async () => {
    const home = tmp.make(); const a = fakeAdapter();
    const reg = await composeTools({ home, roots: [], audit: noAudit, grants: noGrants, media: { adapter: a.adapter, store: new OutputStore(join(home, "outputs")) } }, turn());
    const out = await get(reg, "image.generate").execute({ prompt: "p" }, run()) as { files: unknown[] };
    assert.equal(out.files.length, 1);
  });
});

describe("composition/tools composeTools: web.search", () => {
  const search = (impl: (args: unknown, o: { signal: AbortSignal }) => Promise<unknown>) => ({ search: impl }) as never;

  it("is registered only when a search service is configured, as a network read", async () => {
    assert.equal(names(await composeTools(options(), turn())).includes("web.search"), false);
    const t = get(await composeTools(options({ webSearch: search(async () => ({})) }), turn()), "web.search");
    assert.deepEqual([t.capability, t.effect, t.risk, t.trust], ["net.fetch", "read", "low", "first-party"]);
  });

  it("passes arguments and the abort signal through and returns the result as is", async () => {
    let seen: { args: unknown; signal: AbortSignal } | undefined;
    const t = get(await composeTools(options({ webSearch: search(async (args, o) => { seen = { args, signal: o.signal }; return { results: [] }; }) }), turn()), "web.search");
    const ctx = run();
    assert.deepEqual(await t.execute({ query: "cats" }, ctx), { results: [] });
    assert.deepEqual(seen!.args, { query: "cats" }); assert.equal(seen!.signal, ctx.signal);
  });

  it("a typed web failure becomes a tool-failed error carrying the structured result", async () => {
    const t = get(await composeTools(options({ webSearch: search(async () => { throw new WebFailure("no-provider", "none configured"); }) }), turn()), "web.search");
    await assert.rejects(() => t.execute({ query: "q" }, run()), (e) => e instanceof ToolAdapterError && e.code === "tool-failed" && (e.detail as { isError: boolean; error: { code: string } }).isError === true && (e.detail as { error: { code: string } }).error.code === "no-provider");
  });

  it("an unexpected error is reduced to a generic internal-error: its text never reaches the model", async () => {
    const t = get(await composeTools(options({ webSearch: search(async () => { throw new Error("upstream said key=redact-probe-alpha"); }) }), turn()), "web.search");
    await assert.rejects(() => t.execute({ query: "q" }, run()), (e) => {
      assert.ok(e instanceof ToolAdapterError);
      assert.equal(JSON.stringify(e.detail).includes("redact-probe-alpha"), false);
      assert.equal(e.message.includes("redact-probe-alpha"), false);
      assert.equal((e.detail as { error: { code: string } }).error.code, "internal-error");
      return true;
    });
  });
});

describe("composition/tools composeTools: MCP servers", () => {
  const descriptor = (name: string, over: Record<string, unknown> = {}) => ({ name, description: `${name} tool`, inputSchema: { type: "object", properties: {} }, ...over });
  function port(table: Record<string, () => unknown>) {
    const listed: { server: string; caller: unknown }[] = [];
    return { listed, port: { async listTools(server: string, caller: unknown) { listed.push({ server, caller }); const f = table[server]; if (!f) throw new Error(`no server ${server}`); return f(); }, async callTool() { throw new Error("not used"); } } as never };
  }

  it("registers every server's tools as mcp.<server>.<tool>, in server order, as untrusted network submits", async () => {
    const { port: p } = port({ one: () => [descriptor("echo"), descriptor("Zap")], two: () => [descriptor("other")] });
    const reg = await composeTools(options({ mcp: { port: p, servers: ["one", "two"] } }), turn());
    assert.deepEqual(names(reg).filter((n) => n.startsWith("mcp.")), ["mcp.one.echo", "mcp.one.zap", "mcp.two.other"]);
    const t = get(reg, "mcp.one.echo");
    assert.deepEqual([t.capability, t.trust], ["net.submit", "untrusted"]);
    assert.equal((await t.classify!({}))?.flags?.outsideRoots, true);
  });

  it("lists under the turn's canonical principal, whatever the caller identity said", async () => {
    const { port: p, listed } = port({ one: () => [] });
    await composeTools(options({ mcp: { port: p, servers: ["one"] } }), turn({ principal: "user-canonical", authenticatedPerson: "someone-else", agentId: "agent-7" }));
    assert.deepEqual(listed[0]!.caller, { agentId: "agent-7", principal: "user-canonical" });
  });

  it("one failing server degrades alone: the others stay available and the failure is reported with its service name", async () => {
    const { port: p } = port({ ok: () => [descriptor("echo")], bad: () => { throw new Error("spawn failed"); } });
    const degraded: [string, unknown][] = [];
    const reg = await composeTools(options({ mcp: { port: p, servers: ["bad", "ok"] }, degraded: (s, e) => degraded.push([s, e]) }), turn());
    assert.deepEqual(names(reg).filter((n) => n.startsWith("mcp.")), ["mcp.ok.echo"]);
    assert.deepEqual(degraded.map((d) => d[0]), ["mcp.bad"]);
    assert.match(String((degraded[0]![1] as Error).message), /spawn failed/);
  });

  it("tools the bridge cannot use are skipped and reported, not registered", async () => {
    const { port: p } = port({ one: () => [descriptor("good"), descriptor("badschema", { inputSchema: { type: "string" } }), descriptor("!!!")] });
    const degraded: [string, unknown][] = [];
    const reg = await composeTools(options({ mcp: { port: p, servers: ["one"] }, degraded: (s, e) => degraded.push([s, e]) }), turn());
    assert.deepEqual(names(reg).filter((n) => n.startsWith("mcp.")), ["mcp.one.good"]);
    assert.deepEqual(degraded.map((d) => [d[0], (d[1] as { tool: string; reason: string }).reason]), [["mcp.one", "schema"], ["mcp.one", "name"]]);
  });

  it("a cancelled turn aborts composition instead of reporting every server as degraded", async () => {
    const { port: p } = port({ one: () => [] });
    const ac = new AbortController(); ac.abort(new Error("turn cancelled"));
    const degraded: string[] = [];
    await assert.rejects(() => composeTools(options({ mcp: { port: p, servers: ["one"] }, degraded: (s) => degraded.push(s) }), turn({ signal: ac.signal })), /turn cancelled/);
    assert.deepEqual(degraded, []);
  });

  it("listing the same server twice neither duplicates nor replaces its tools; the second registration is reported", async () => {
    const { port: p } = port({ one: () => [descriptor("echo")] });
    const degraded: string[] = [];
    const reg = await composeTools(options({ mcp: { port: p, servers: ["one", "one"] }, degraded: (s) => degraded.push(s) }), turn());
    assert.equal(names(reg).filter((n) => n === "mcp.one.echo").length, 1);
    assert.deepEqual(degraded, ["mcp.one"]);
  });
});
