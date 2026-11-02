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

  it("the failure path: the envelope is the same with or without a registry when its message holds no registered value; modelToolError still masks", async () => {
    const secret = fakeSecret("err");
    const calm = async () => { throw Object.assign(new Error("failed upstream"), { code: "upstream_failed" }); };
    const plain = await rig(calm).run();
    const withRegistry = await rig(calm, () => [secret]).run();
    assert.deepEqual(withRegistry, plain);
    const leaking = await rig(async () => { throw Object.assign(new Error(`failed with ${secret}`), { code: "upstream_failed" }); }, () => [secret]).run();
    assert.ok(leaking.isError && leaking.error.code === "tool-failed" && leaking.error.sourceCode === "upstream_failed", JSON.stringify(leaking));
    const safe = JSON.stringify(modelToolError(leaking as never, [secret]));
    assert.ok(!safe.includes(secret));
    assert.match(safe, /\[REDACTED:secret\]/);
  });
});

describe("ToolDispatcher: failure messages are masked before they are cut to length", () => {
  const windows = (secret: string): string[] => Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8));

  it("a registered value the 500-character cut would split is masked first: no part of it (8 characters or more) survives, wherever it sits", async () => {
    const secret = fakeSecret("straddle");
    for (let lead = 440; lead <= 500; lead += 3) {
      const { run, audit } = rig(async () => { throw new Error(`${"a".repeat(lead)}${secret} and then some trailing text`); }, () => [secret]);
      const r = await run();
      assert.ok(r.isError && r.error.code === "tool-failed", JSON.stringify(r));
      const seen = JSON.stringify([r, audit.events]);
      for (const w of windows(secret)) assert.ok(!seen.includes(w), `lead ${lead}: "${w}" survives`);
      assert.ok(r.error.message.length <= 500);
    }
    const { run } = rig(async () => { throw new Error(`${"a".repeat(440)}${secret} and then some trailing text`); }, () => [secret]);
    const r = await run();
    assert.ok(r.isError && r.error.message.includes(MARK), r.isError ? r.error.message : "");
  });

  it("a message that cannot be checked is replaced, never passed on", async () => {
    const secret = fakeSecret("unreadable");
    const { run } = rig(async () => { throw new Error(`failed with ${secret}`); }, () => { throw new Error("registry unavailable"); });
    const r = await run();
    assert.ok(r.isError && r.error.code === "tool-failed");
    assert.ok(!JSON.stringify(r).includes(secret));
  });
});

describe("ToolDispatcher: the size limit and the secret check", () => {
  const numericSecret = (label: string): string => BigInt(`0x${createHash("sha256").update(label).digest("hex")}`).toString().slice(0, 10);

  it("a result over the limit is refused on its raw size, before anything is parsed or masked; the refusal carries only the size", async () => {
    const pin = numericSecret("oversize");
    const raw = { pin: Number(pin), pad: "x".repeat(2000) }; // masking it would withhold the result (a number), so the code tells which check ran first
    const { run } = rig(async () => raw, () => [pin], { limits: { maxResultBytes: 1000 } });
    const r = await run();
    assert.ok(r.isError && r.error.code === "tool-result-too-large", JSON.stringify(r));
    assert.equal(r.error.message, `demo.print returned ${Buffer.byteLength(JSON.stringify(raw), "utf8")} bytes, over its 1000-byte limit`);
    assert.ok(!JSON.stringify(r).includes(pin));
  });

  it("the limit holds for what is passed on too: a mask longer than the value can push a result over it, and says the redacted size", async () => {
    const secret = "e".repeat(8);
    const text = Array(100).fill(secret).join(",");
    const { run } = rig(async () => ({ text }), () => [secret], { limits: { maxResultBytes: 1000 } });
    assert.ok(Buffer.byteLength(JSON.stringify({ text }), "utf8") <= 1000, "within the limit as it came");
    const r = await run();
    assert.ok(r.isError && r.error.code === "tool-result-too-large", JSON.stringify(r));
    assert.equal(r.error.message, `demo.print returned ${Buffer.byteLength(JSON.stringify({ text: Array(100).fill(MARK).join(",") }), "utf8")} bytes, over its 1000-byte limit`);
    // the same result without a registered value is within the limit and passed on as it is
    assert.deepEqual(valueOf(await rig(async () => ({ text }), () => [], { limits: { maxResultBytes: 1000 } }).run()), { text });
  });

  it("a result that holds no registered value is not walked: a deep one comes back exactly as it was, with no depth cut", async () => {
    const present = fakeSecret("present");
    let deep: unknown = { leaf: "plain" };
    for (let i = 0; i < 100; i++) deep = { next: deep };
    const plain = await rig(async () => ({ deep })).run();
    const withRegistry = await rig(async () => ({ deep }), () => [present, fakeSecret("other")]).run();
    assert.equal(JSON.stringify(valueOf(withRegistry)), JSON.stringify(valueOf(plain)));
    assert.ok(!JSON.stringify(valueOf(withRegistry)).includes("TRUNCATED"));
    // the same shape holding a registered value is walked (and cut at the redactor's bound), as before
    deep = { leaf: present }; for (let i = 0; i < 100; i++) deep = { next: deep };
    const cut = JSON.stringify(valueOf(await rig(async () => ({ deep }), () => [present]).run()));
    assert.ok(cut.includes("[TRUNCATED:depth]") && !cut.includes(present));
  });

  it("a registered value that comes back as a JSON number cannot be masked, so the result is withheld and audited as failed", async () => {
    const pin = numericSecret("pin");
    assert.match(pin, /^[1-9]\d{9}$/);
    const asNumber = rig(async () => ({ id: Number(pin), note: `pin ${pin}` }), () => [pin]);
    const r = await asNumber.run();
    assert.ok(r.isError && r.error.code === "tool-result-invalid", JSON.stringify(r));
    assert.ok(!JSON.stringify([r, asNumber.audit.events]).includes(pin));
    assert.ok(asNumber.audit.events.some((e) => JSON.stringify(e).includes("\"outcome\":\"failed\"")));
    // as a string it is masked and passed on; a number that is not the registered value is untouched
    assert.deepEqual(valueOf(await rig(async () => ({ id: pin }), () => [pin]).run()), { id: MARK });
    assert.deepEqual(valueOf(await rig(async () => ({ id: Number(pin) + 1 }), () => [pin]).run()), { id: Number(pin) + 1 });
  });

  it("two keys that mask to the same text both stay, numbered in order in key position only", async () => {
    const a = fakeSecret("key-a"), b = fakeSecret("key-b");
    const hexOfA = Buffer.from(a).toString("hex");
    const { run } = rig(async () => ({ [a]: 1, plain: 2, [b]: 3, [hexOfA]: 4, [`${MARK}#2`]: 5, text: `${a} ${b}` }), () => [a, b]);
    const out = valueOf(await run()) as Record<string, unknown>;
    assert.deepEqual(Object.entries(out), [
      [MARK, 1], ["plain", 2], [`${MARK}#2`, 3], [`${MARK}#3`, 4], [`${MARK}#2#2`, 5], ["text", `${MARK} ${MARK}`],
    ]);
  });

  it("the secrets are read at every call: a value registered between two calls is masked on the second, and one registered during the call in that call", async () => {
    const later = fakeSecret("later"), during = fakeSecret("during");
    const known: string[] = [];
    let first = true;
    const { run } = rig(async () => {
      if (first) return { text: later };
      known.push(during);
      return { text: `${later} ${during}` };
    }, () => known);
    assert.deepEqual(valueOf(await run()), { text: later }, "not registered yet: passed on as it is");
    first = false;
    known.push(later);
    assert.deepEqual(valueOf(await run()), { text: `${MARK} ${MARK}` });
  });

  it("a source that lists the same value many times masks the same as one that lists it once", async () => {
    const secret = fakeSecret("dup");
    const body = { text: `a ${secret} b`, list: [secret] };
    const once = await rig(async () => body, () => [secret]).run();
    const many = await rig(async () => body, () => Array(1000).fill(secret)).run();
    assert.equal(JSON.stringify(valueOf(many)), JSON.stringify(valueOf(once)));
    assert.equal(many.meta.bytes, once.meta.bytes);
  });
});
