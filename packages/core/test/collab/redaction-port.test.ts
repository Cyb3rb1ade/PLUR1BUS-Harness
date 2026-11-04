import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { liveLogsRedactionPort } from "../../src/collab/ports.ts";
import { createSecretRedaction } from "../../src/secrets/redaction.ts";
import { SPAN_PREVIEW_CHARS } from "../../src/collab/defaults.ts";
import { open, owner, projectWithAgents } from "./helpers.ts";

test("live trace redaction derives one generation for equal secret membership", t => {
  const first = randomUUID(), second = randomUUID();
  let values = [first, second];
  const encode = globalThis.encodeURIComponent;
  let derivations = 0;
  t.mock.method(globalThis, "encodeURIComponent", (value: string) => {
    if (value === first || value === second) derivations++;
    return encode(value);
  });
  const port = liveLogsRedactionPort(() => values);
  assert.ok(!port.text(`message ${first} ${second}`).includes(first));
  values = [second, first, first];
  assert.ok(!JSON.stringify(port.value({ message: `${first} ${second}` })).includes(second));
  assert.equal(derivations, 2, "ordering and duplicates must not prepare another generation");
  const next = randomUUID();
  values = [first, second, next];
  assert.ok(!port.text(next).includes(next), "changed membership is protected immediately");
});

test("live trace redaction uses the complete shared snapshot without rederiving Store and config forms", t => {
  const stored = randomUUID(), configured = randomUUID();
  const registry = createSecretRedaction();
  registry.register(stored, "stored-credential");
  registry.replaceGroup(Symbol("configuration"), [configured]);
  const snapshot = registry.snapshot();
  const encode = globalThis.encodeURIComponent;
  let derivations = 0;
  t.mock.method(globalThis, "encodeURIComponent", (value: string) => {
    if (value === stored || value === configured) derivations++;
    return encode(value);
  });
  const port = liveLogsRedactionPort(() => registry.values(), () => snapshot);
  const output = port.text(`${stored} ${configured} person@example.com`);
  for (const value of [stored, configured, "person@example.com"]) assert.ok(!output.includes(value));
  assert.ok(!JSON.stringify(port.value({ transcript: `${stored} ${configured}` })).includes(configured));
  assert.equal(derivations, 0, "an already compiled generation must reach the trace port unchanged");
});

test("trace previews redact complete secrets before cutting either input or output", async t => {
  const secret = randomUUID();
  const raw = `${"!".repeat(SPAN_PREVIEW_CHARS - 12)}${secret}${"x".repeat(100)}`;
  const port = liveLogsRedactionPort(() => [secret]);
  const h = open({ redact: port, runner: { async run() { return { text: raw, inputTokens: 10, outputTokens: 10 }; } } });
  t.after(() => h.collab.close());
  const project = await projectWithAgents(h, ["lead", "worker"]);
  const answer = await h.collab.consult({ principal: owner(), projectId: project.id,
    fromAgent: "lead", toAgent: "worker", question: raw, context: "" });
  const span = h.collab.getTrace(owner(), answer.traceId).spans.find(row => row.kind === "consult")!;
  for (const preview of [span.inputPreview, span.outputPreview]) {
    assert.ok(!preview.includes(secret.slice(0, 12)), "a retained secret prefix escaped the preview");
    assert.ok(preview.includes("[REDACTED:"), "the preview retains a redaction marker");
    assert.ok(preview.endsWith("…"));
    assert.ok(preview.length <= SPAN_PREVIEW_CHARS + 1);
    assert.equal(preview.isWellFormed(), true);
  }
});

test("trace preview caps preserve valid UTF-16 when an emoji crosses the limit", async t => {
  const raw = `${"!".repeat(SPAN_PREVIEW_CHARS - 1)}😀public`;
  const h = open({ redact: liveLogsRedactionPort(() => []),
    runner: { async run() { return { text: raw, inputTokens: 10, outputTokens: 10 }; } } });
  t.after(() => h.collab.close());
  const project = await projectWithAgents(h, ["lead", "worker"]);
  const answer = await h.collab.consult({ principal: owner(), projectId: project.id,
    fromAgent: "lead", toAgent: "worker", question: raw, context: "" });
  const span = h.collab.getTrace(owner(), answer.traceId).spans.find(row => row.kind === "consult")!;
  for (const preview of [span.inputPreview, span.outputPreview]) {
    assert.equal(preview.isWellFormed(), true);
    assert.equal(preview, `${"!".repeat(SPAN_PREVIEW_CHARS - 1)}…`, "the cap drops the incomplete emoji instead of replacing it");
  }
});
