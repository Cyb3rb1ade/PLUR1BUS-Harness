import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { composeTools } from "../../src/composition/tools.ts";
import { createSecretRedaction } from "../../src/secrets/redaction.ts";
import type { SecretFormsSnapshot } from "../../src/logs/secret-forms.ts";
import { ToolDispatcher, type DispatchContext, type ToolDispatcherDeps } from "../../src/tools/dispatcher.ts";
import { ToolRegistry, type ToolDef } from "../../src/tools/registry.ts";
import { turnRequest, useTempDirs } from "../composition/helpers.ts";

const tmp = useTempDirs("f2-dispatcher-known-");
const mark = "[REDACTED:secret]";
const grants = { list: () => [], get: () => undefined };
const ctx: DispatchContext = { agentId: "a1", principal: "owner", surface: 3, signal: new AbortController().signal };
function dispatcher(execute: ToolDef["execute"], extra: Partial<ToolDispatcherDeps>) {
  const registry = new ToolRegistry();
  registry.register({ name: "fixture.read", description: "Read a fixture", inputSchema: { type: "object" },
    capability: "sys.read", effect: "read", risk: "low", trust: "first-party", execute });
  return new ToolDispatcher({ registry, approvals: { request: async () => ({ approved: false }) }, grants, clock: { now: () => 1000 }, ...extra });
}

it("a trusted snapshot alone masks results and refreshes after execution registers another value", async () => {
  const redaction = createSecretRedaction();
  const before = randomUUID(), during = randomUUID();
  redaction.register(before);
  const d = dispatcher(async () => { redaction.register(during); return { text: `${before} ${during}`, region: "public-eu" }; }, { knownSecrets: () => redaction.snapshot() });
  const out = await d.call({ id: "c1", name: "fixture.read", args: {} }, ctx);
  assert.equal(out.isError, false, JSON.stringify(out));
  if (!out.isError) assert.deepEqual(out.value, { text: `${mark} ${mark}`, region: "public-eu" });
});

it("a trusted snapshot alone masks a failure before the 500-unit message boundary", async () => {
  const redaction = createSecretRedaction(), secret = randomUUID();
  redaction.register(secret);
  const d = dispatcher(async () => { throw new Error(`${"p".repeat(450)}${secret} tail`); }, { knownSecrets: () => redaction.snapshot() });
  const out = await d.call({ id: "c1", name: "fixture.read", args: {} }, ctx);
  assert.equal(out.isError, true);
  for (let i = 0; i <= secret.length - 8; i++) assert.ok(!JSON.stringify(out).includes(secret.slice(i, i + 8)));
  if (out.isError) assert.ok(out.error.message.includes(mark));
});

it("the trusted snapshot protects results even when legacy callbacks have a stale empty generation", async () => {
  const redaction = createSecretRedaction(), secret = randomUUID(); redaction.register(secret);
  const d = dispatcher(async () => ({ text: secret }), { knownSecrets: () => redaction.snapshot(), secrets: () => [], secretForms: () => [] });
  const out = await d.call({ id: "c1", name: "fixture.read", args: {} }, ctx);
  assert.equal(out.isError, false, JSON.stringify(out));
  if (!out.isError) assert.deepEqual(out.value, { text: mark });
});

for (const source of ["secrets", "secretForms"] as const) it(`legacy ${source} callbacks reuse a snapshot across ordering changes and refresh on membership`, async () => {
  const first = randomUUID(), second = randomUUID(), third = randomUUID();
  let values = [first, second];
  const snapshots: (SecretFormsSnapshot | undefined)[] = [];
  const d = dispatcher(async (_args, run) => { snapshots.push(run.knownSecrets?.()); return { text: values.join(" ") }; }, { [source]: () => [...values] });
  const call = () => d.call({ id: "c1", name: "fixture.read", args: {} }, ctx);
  for (const next of [[first, second], [second, first, first], [second, third]]) {
    values = next;
    const out = await call();
    assert.equal(out.isError, false, JSON.stringify(out));
    if (!out.isError) assert.deepEqual(out.value, { text: Array(next.length).fill(mark).join(" ") });
  }
  assert.ok(snapshots[0]);
  assert.equal(snapshots[0], snapshots[1], "fresh iterable ordering is the same compiled membership generation");
  assert.notEqual(snapshots[1], snapshots[2], "new membership replaces the compiled generation");
});

it("both invalid-argument rounds mask complete values before their runtime previews are capped", async () => {
  const redaction = createSecretRedaction(), first = randomUUID(), second = randomUUID();
  redaction.register(first);
  const registry = new ToolRegistry();
  registry.register({ name: "fixture.read", description: "Read fixture", inputSchema: { type: "object", properties: { region: { enum: ["public-eu"] } } },
    capability: "sys.read", effect: "read", risk: "low", trust: "first-party", execute: async () => { throw new Error("invalid arguments executed"); } });
  let repairText = "", repairs = 0;
  const d = new ToolDispatcher({ registry, approvals: { request: async () => ({ approved: false }) }, grants, clock: { now: () => 1000 },
    knownSecrets: () => redaction.snapshot(), repair: async input => {
      repairs++; repairText = JSON.stringify({ issues: input.issues, message: input.message });
      redaction.register(second); return { region: `${"p".repeat(17)}${second}` };
    } });
  const out = await d.call({ id: "c1", name: "fixture.read", args: { region: `${"p".repeat(17)}${first}` } }, ctx);
  assert.equal(repairs, 1);
  assert.ok(out.isError && out.error.code === "tool-call-invalid", JSON.stringify(out));
  const shown = `${repairText}\n${JSON.stringify(out)}`;
  for (const secret of [first, second]) for (let i = 0; i <= secret.length - 8; i++) assert.ok(!shown.includes(secret.slice(i, i + 8)));
  assert.ok(repairText.includes(mark));
});

for (const encoding of ["utf8", "base64"] as const) it(`real composed file.read masks both original byte-window edges through the trusted dispatcher (${encoding})`, async () => {
  const home = tmp.make(), path = join(home, "public.txt"), secret = randomUUID();
  const redaction = createSecretRedaction(); redaction.register(secret);
  writeFileSync(path, `${secret}|public-region|${secret}`);
  const registry = await composeTools({ home, roots: [{ id: "fixture", path: home }], audit: { append() {} } as never, grants }, turnRequest());
  const d = new ToolDispatcher({ registry, approvals: { request: async () => ({ approved: false }) }, grants, clock: { now: Date.now }, knownSecrets: () => redaction.snapshot() });
  const offset = secret.length - 12, length = 12 + "|public-region|".length + 12;
  const out = await d.call({ id: "native", name: "file.read", args: { path, offset, length, encoding } }, ctx);
  assert.equal(out.isError, false, JSON.stringify(out));
  if (out.isError) return;
  const value = out.value as { content: string; encoding: string; offset: number };
  const text = encoding === "base64" ? Buffer.from(value.content, "base64").toString("utf8") : value.content;
  assert.equal(text, `${mark}|public-region|${mark}`);
  assert.equal(value.offset, offset);
});
