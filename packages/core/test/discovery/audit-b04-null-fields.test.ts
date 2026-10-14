// Audit b04 (model discovery): null-fields.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanAnthropic } from "../../src/discovery/scanners/anthropic.ts";
import { scanOpenAi } from "../../src/discovery/scanners/openai.ts";
import type { PinnedClient } from "../../src/discovery/http.ts";
import type { ProfileInfo } from "../../src/discovery/ports.ts";

const prof = (id: string): ProfileInfo => ({ id, discovery: "openai-models", baseUrl: `https://${id}.example/v1` });

describe("b04: null for optional fields", () => {
  const clientOf = (...pages: unknown[]): PinnedClient => { let i = 0; return { get: async () => pages[i++], get pages() { return i; } }; };
  const p: ProfileInfo = prof("p1");
  it("openai: null context_length, name and created count as absent", async () => {
    const out = await scanOpenAi(p, clientOf({ data: [{ id: "a", context_length: null, name: null, created: null }] }));
    assert.deepEqual(out.entries, [{ id: "a" }]);
  });
  it("anthropic: null max_input_tokens and display_name count as absent", async () => {
    const out = await scanAnthropic(p, clientOf({ data: [{ id: "a", max_input_tokens: null, display_name: null }], has_more: false }));
    assert.deepEqual(out.entries, [{ id: "a" }]);
  });
});
