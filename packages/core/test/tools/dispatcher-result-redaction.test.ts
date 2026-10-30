// A successful tool result is redacted against the registered secret values before it leaves the dispatcher, with the same
// rule `secret` and the same marker a failed call gets at the model boundary (`modelToolError`). Only registered values are
// masked: a result without one is passed on untouched.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ToolDispatcher, type DispatchContext, type ToolResult } from "../../src/tools/dispatcher.ts";
import { ToolRegistry, type ToolDef } from "../../src/tools/registry.ts";
import { createPolicyAudit } from "../../src/policy/audit.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { modelToolError } from "../../src/toolcall/model-tool-error.ts";
import type { Grant } from "../../src/policy/index.ts";

/** A fake secret value derived from a short label at run time; no token-like literal is committed. */
const fakeSecret = (label: string): string => `fixture-${label}-${createHash("sha256").update(label).digest("hex").slice(0, 16)}`;
const MARK = "[REDACTED:secret]";
const CTX: DispatchContext = { agentId: "bernd", principal: "user:v1:o", sessionId: "s1", surface: 3, signal: new AbortController().signal };
const NOGRANTS = { list: () => [] as readonly Grant[], get: () => undefined };

function rig(execute: ToolDef["execute"], secrets?: () => Iterable<string>, over: Partial<ToolDef> = {}) {
  const registry = new ToolRegistry();
  registry.register({
    name: "demo.print", description: "prints", inputSchema: { type: "object", additionalProperties: false, properties: {} },
    capability: "sys.read", effect: "read", risk: "low", trust: "operator-vetted", execute, ...over,
  });
  const audit = memoryAuditSink();
  const d = new ToolDispatcher({
    registry, approvals: { request: async () => ({ approved: false }) }, grants: NOGRANTS, clock: { now: () => 1000 },
    audit: createPolicyAudit({ sink: audit, clock: { now: () => 1000 }, host: "h" }), ...(secrets ? { secrets } : {}),
  });
  const run = (): Promise<ToolResult> => d.call({ id: "c1", name: "demo.print", args: {} }, CTX);
  return { d, run, audit };
}
const valueOf = (r: ToolResult): unknown => { assert.equal(r.isError, false, JSON.stringify(r)); return r.isError ? undefined : r.value; };

describe("ToolDispatcher: successful results are redacted against registered secret values", () => {
  it("masks a registered value in a string result, with the marker the failure path uses", async () => {
    const secret = fakeSecret("env");
    const { run } = rig(async () => ({ stdout: `HOME=/work\nAPI_KEY=${secret}\n` }), () => [secret]);
    const r = await run();
    assert.deepEqual(valueOf(r), { stdout: `HOME=/work\nAPI_KEY=${MARK}\n` });
    assert.ok(!JSON.stringify(r).includes(secret));
    // the same value in a failed call is masked by modelToolError with the very same marker
    const failing = rig(async () => { throw new Error(`upstream said ${secret}`); }, () => [secret]);
    const failed = await failing.run();
    assert.ok(failed.isError);
    assert.match(JSON.stringify(modelToolError(failed as never, [secret])), /\[REDACTED:secret\]/);
  });

  it("masks the encoded forms of a registered value too (base64, hex, URL-encoded)", async () => {
    const secret = `${fakeSecret("enc")} +/&`;
    const forms = [Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("hex"), encodeURIComponent(secret)];
    const { run } = rig(async () => ({ lines: forms.map((f, i) => `form${i}: ${f}`) }), () => [secret]);
    const out = JSON.stringify(valueOf(await run()));
    for (const f of forms) assert.ok(!out.includes(f), `${f} must not survive`);
    assert.equal(out.split(MARK).length - 1, forms.length);
  });

  it("redacts inside the string values of a JSON-shaped result; the result stays valid, structured JSON", async () => {
    const secret = fakeSecret("json");
    const awkward = `${fakeSecret("quoted")}"\\\n `; // characters JSON escapes: matching must not depend on the serialised text
    const { run } = rig(async () => ({
      body: JSON.stringify({ auth: { value: secret }, n: 1, ok: true }),
      list: [secret, 2, null, true, { deep: [`x ${secret} y`] }],
      awkward: `before ${awkward} after`,
      [secret]: "a secret as a key",
    }), () => [secret, awkward]);
    const r = await run();
    const text = JSON.stringify(valueOf(r));
    assert.doesNotThrow(() => JSON.parse(text));
    assert.ok(!text.includes(secret) && !text.includes(JSON.stringify(awkward).slice(1, -1)));
    const v = JSON.parse(text) as { body: string; list: unknown[]; awkward: string } & Record<string, unknown>;
    assert.deepEqual(JSON.parse(v.body), { auth: { value: MARK }, n: 1, ok: true });
    assert.deepEqual(v.list, [MARK, 2, null, true, { deep: [`x ${MARK} y`] }]);
    assert.equal(v.awkward, `before ${MARK} after`);
    assert.equal(v[MARK], "a secret as a key");
    assert.equal(r.meta.bytes, Buffer.byteLength(text, "utf8"), "meta.bytes counts what leaves the dispatcher");
  });

  it("a result that holds no registered value is byte-identical, with or without a registry", async () => {
    const value = JSON.parse(`{"z":1,"a":[1,2,{"b":null,"c":"ünï\\u2028 \\"q\\""}],"__proto__":{"p":1},"1":"int-key","url":"https://example.test/a?x=1&y=2","note":"password=hunter2 Bearer abc.def","run":"${"A".repeat(60)}","path":"/home/u/.ssh/id_rsa"}`) as unknown;
    const plain = await rig(async () => value).run();
    const withRegistry = await rig(async () => value, () => [fakeSecret("absent")]).run();
    const emptyRegistry = await rig(async () => value, () => []).run();
    const bytes = (r: ToolResult): string => JSON.stringify(valueOf(r));
    assert.equal(bytes(withRegistry), bytes(plain));
    assert.equal(bytes(emptyRegistry), bytes(plain));
    assert.equal(withRegistry.meta.bytes, plain.meta.bytes);
    // only registered values are masked: the log redactor's other rules (keys, URLs, credential shapes, paths) do not apply to a result
    assert.match(bytes(plain), /example\.test\/a\?x=1&y=2/);
    assert.match(bytes(plain), /password=hunter2 Bearer abc\.def/);
  });

  it("keeps the redactor's short-value rule: a value under 8 characters is not masked, 8 is", async () => {
    const seven = "s".repeat(7), eight = "e".repeat(8);
    const { run } = rig(async () => ({ text: `a ${seven} b ${eight} c` }), () => [seven, eight]);
    assert.deepEqual(valueOf(await run()), { text: `a ${seven} b ${MARK} c` });
  });

  it("the audit outcome line is written for the redacted result: its size is the redacted size, no line carries the value", async () => {
    const secret = fakeSecret("audit");
    const { run, audit } = rig(async () => ({ stdout: `token is ${secret}` }), () => [secret]);
    const r = await run();
    assert.ok(!r.isError);
    const lines = audit.events.map((e) => JSON.stringify(e));
    assert.ok(lines.length >= 2 && lines.every((l) => !l.includes(secret)), lines.join("\n"));
    const outcome = audit.events.find((e) => JSON.stringify(e).includes("policy.outcome"));
    assert.ok(outcome, "an outcome line");
    const detail = (outcome as unknown as { detail: { resultBytes: number } }).detail;
    assert.equal(detail.resultBytes, r.meta.bytes);
    assert.equal(r.meta.bytes, Buffer.byteLength(JSON.stringify({ stdout: `token is ${MARK}` }), "utf8"));
    assert.notEqual(r.meta.bytes, Buffer.byteLength(JSON.stringify({ stdout: `token is ${secret}` }), "utf8"));
  });

  it("a result nested deeper than the redactor's depth bound is cut there, never passed on unchecked", async () => {
    const secret = fakeSecret("deep");
    let deep: unknown = { leaf: secret };
    for (let i = 0; i < 80; i++) deep = { next: deep };
    const { run } = rig(async () => ({ deep }), () => [secret]);
    const text = JSON.stringify(valueOf(await run()));
    assert.ok(!text.includes(secret));
    assert.match(text, /\[TRUNCATED:depth\]/);
  });

  it("fails closed: a registry that cannot be read withholds the result instead of passing it on", async () => {
    const secret = fakeSecret("down");
    const { run, audit } = rig(async () => ({ stdout: secret }), () => { throw new Error("registry unavailable"); });
    const r = await run();
    assert.ok(r.isError && r.error.code === "tool-result-invalid", JSON.stringify(r));
    assert.ok(!JSON.stringify([r, audit.events]).includes(secret));
    assert.ok(audit.events.some((e) => JSON.stringify(e).includes("\"outcome\":\"failed\"")));
  });

  it("the failure path is unchanged: the dispatcher's error envelope is the same with or without a registry, and modelToolError still masks", async () => {
    const secret = fakeSecret("err");
    const boom = async () => { throw Object.assign(new Error(`failed with ${secret}`), { code: "upstream_failed" }); };
    const plain = await rig(boom).run();
    const withRegistry = await rig(boom, () => [secret]).run();
    assert.deepEqual(withRegistry, plain);
    assert.ok(withRegistry.isError && withRegistry.error.message.includes(secret), "the raw envelope keeps its diagnostics for logs");
    const safe = JSON.stringify(modelToolError(withRegistry as never, [secret]));
    assert.ok(!safe.includes(secret));
    assert.match(safe, /\[REDACTED:secret\]/);
  });
});
