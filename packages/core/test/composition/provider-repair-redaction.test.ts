import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { createSecretRedaction } from "../../src/secrets/redaction.ts";
import { collect, readTool, scriptedAdapter, turnFixture, useTempDirs } from "./helpers.ts";

const tmp = useTempDirs("f2-provider-repair-");

for (const mode of ["string", "numeric", "absent"] as const) it(`repair wire sanitizes full invalid arguments before presentation (${mode})`, async () => {
  const numeric = mode === "numeric";
  const redaction = createSecretRedaction(), secret = randomUUID();
  const pin = String(1000000000 + parseInt(randomUUID().replaceAll("-", "").slice(0, 7), 16));
  if (mode !== "absent") redaction.register(secret); if (numeric) redaction.register(pin);
  const initial = { path: "/public/report.txt", version: "2026.11", region: `${"p".repeat(25)}${secret}`, credential: secret, ...(numeric ? { pin: Number(pin) } : {}) };
  const fixed = { ...initial, region: "public-eu" };
  const wire = scriptedAdapter([
    { calls: [{ id: "invalid", name: "file.read", args: initial }] },
    { calls: [{ id: "fixed", name: "file.read", args: fixed }] },
    { text: "done" },
  ]);
  const f = turnFixture(wire.adapter, { knownSecrets: () => redaction.snapshot() }, tmp.make());
  const executed: unknown[] = [];
  f.registry.register(readTool("file.read", async args => { executed.push(args); return { region: "public-eu" }; }, {
    inputSchema: { type: "object", additionalProperties: false, required: ["path", "version", "region", "credential"], properties: {
      path: { type: "string" }, version: { type: "string" }, region: { enum: ["public-eu"] }, credential: { type: "string" }, pin: { type: "integer" },
    } },
  }));
  try {
    await collect(f.provider);
    assert.equal(wire.requests.length, 3, "one repair followed by the next model round");
    const repair = wire.requests[1]!;
    assert.equal(repair.messages.length, 1);
    const shown = String(repair.messages[0]!.content);
    if (mode !== "absent") for (let i = 0; i <= secret.length - 8; i++) assert.ok(!shown.includes(secret.slice(i, i + 8)), "repair diagnostics and argument data contain no canary fragment");
    if (numeric) {
      assert.ok(!shown.includes(pin));
      assert.ok(shown.includes("withheld"));
    } else if (mode === "string") {
      for (const control of ["/public/report.txt", "2026.11", "public-eu"]) assert.ok(shown.includes(control), control);
      assert.ok(shown.includes("[REDACTED:secret]"));
    } else {
      assert.ok(shown.includes(JSON.stringify(initial)), "a no-hit argument presentation stays intact");
    }
    assert.deepEqual(executed, [fixed], "execution receives the original corrected data, including its credential");
  } finally { f.close(); }
});
