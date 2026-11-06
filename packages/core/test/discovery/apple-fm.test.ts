/** AF2 discovery uses the same bounded managed socket, never a DNS/egress or credential path. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPinnedClient, ScanError } from "../../src/discovery/http.ts";
import { scanOpenAi } from "../../src/discovery/scanners/openai.ts";
import { startFakeFmServe } from "../../../providers/test/fixtures/fake-fm-serve.ts";

const PROFILE = { id: "apple-fm", vendor: "apple", discovery: "openai-models" as const, baseUrl: "http://apple-fm.invalid/v1" };

test("Apple scanner drops PCC and all unknown ids, fixes policy metadata, and reports filtering", async () => {
  const output = await scanOpenAi(PROFILE, { pages: 1, get: async () => ({ data: [
    { id: "system", context_length: 100_000, supported_parameters: ["reasoning"] },
    { id: "pcc" }, { id: "synthetic-unknown" },
  ] }) });
  assert.deepEqual(output.entries.map(entry => entry.id), ["system"]);
  assert.equal(output.entries[0]?.contextWindow, 4096);
  assert.deepEqual(output.entries[0]?.capabilities, ["tools", "structured_output"]);
  assert.equal(output.entries[0]?.reasoning, undefined);
  assert.equal(output.filteredByPolicy, 2);
});

test("managed discovery sends only GET models without egress, DNS or authentication", {
  skip: process.platform === "win32" && "AF2: native Unix sockets require POSIX",
}, async () => {
  const fm = await startFakeFmServe();
  try {
    let checks = 0;
    const client = createPinnedClient({
      baseUrl: PROFILE.baseUrl, lease: null, userAgent: "synthetic",
      socketPath: fm.socket.path, socketGuard: { verify: () => { checks++; return { ok: true }; } },
      egress: { decide: async () => { throw new Error("egress must not run"); } } as never,
      lookup: () => { throw new Error("DNS must not run"); },
    });
    assert.deepEqual((await scanOpenAi(PROFILE, client)).entries.map(entry => entry.id), ["system"]);
    assert.equal(checks, 1);
    assert.equal(fm.requests.length, 1);
    assert.equal(fm.requests[0]?.headers.authorization, undefined);
    assert.equal(fm.requests[0]?.headers["user-agent"], undefined);
    await assert.rejects(client.get({ path: "/models", query: { unsafe: "x" } }), ScanError);
    assert.equal(fm.requests.length, 1);
  } finally {
    await fm.close();
  }
});
