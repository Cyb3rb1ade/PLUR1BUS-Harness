// Installed module metadata must refuse unsupported reference privacy before accepting a configuration snapshot.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigDisclosureUnavailable, loadConfigDisclosurePolicy } from "../src/config-disclosure.ts";
import { tempDir } from "./helpers/temp-dir.ts";

test("installed reference-only policies behind references and conditionals cannot become raw log registrations", async () => {
  for (const schema of [
    { $defs: { name: { type: "string", "x-secret-reference": true } },
      properties: { ordinary: { $ref: "#/$defs/name" } } },
    { allOf: [{ properties: { ordinary: { type: "string", "x-secret-reference": true } } }] },
  ]) {
    const home = tempDir("p1b-reference-policy-");
    const directory = join(home, "modules", "fixture");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "module.json"), JSON.stringify({ name: "fixture", version: "0.1.0",
      apiVersion: "1", entry: "index.js", scope: "installation", priority: 500, configSchema: schema }));
    const policy = await loadConfigDisclosurePolicy(home);
    const pasted = "sk-" + randomUUID();
    assert.throws(() => policy.values({ modules: { fixture: { enabled: false, ordinary: pasted } } }),
      (error: unknown) => error instanceof ConfigDisclosureUnavailable && !error.message.includes(pasted));
  }
});
