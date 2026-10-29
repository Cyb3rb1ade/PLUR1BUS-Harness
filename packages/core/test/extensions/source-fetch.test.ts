/** Native source-download bridge contracts: real egress denial, validated configuration, streaming caps and redaction. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults } from "@plur1bus/config-schema";
import { createEgress } from "../../src/egress/index.ts";
import { fetchExtensionSource, parseExtensionSourceRequest } from "../../src/extension-source-fetch.ts";
const request = { home: "/tmp/test-home", url: "https://example.test/bundle.mcpb", maxBytes: 1024 };
test("the native request accepts HTTPS and refuses credentials, extra fields and invalid limits", () => {
  assert.deepEqual(parseExtensionSourceRequest(request), request);
  for (const invalid of [
    { ...request, url: "http://example.test/bundle" },
    { ...request, url: "https://user:PRIVATE-CREDENTIAL@example.test/bundle" },
    { ...request, headers: { authorization: "PRIVATE-CREDENTIAL" } },
    { ...request, maxBytes: 0 },
    { ...request, maxBytes: 2 ** 31 },
  ]) {
    assert.throws(() => parseExtensionSourceRequest(invalid), error => !String(error).includes("PRIVATE-CREDENTIAL"));
  }
});
test("the real egress service rejects an unlisted source before DNS or a connection", async () => {
  const config = defaults();
  const egress = createEgress({ config: () => config.egress, resolver: async () => { throw new Error("DNS MUST NOT RUN"); } });
  await assert.rejects(fetchExtensionSource(request, { config: () => config, egress }), /egress/i);
  assert.equal(egress.status().decisions.denied, 1);
});
test("invalid target configuration fails before invoking the network port", async () => {
  let called = false;
  await assert.rejects(fetchExtensionSource(request, {
    config: () => { throw new Error("PRIVATE-CONFIG"); },
    egress: { request: async () => { called = true; throw new Error("NETWORK MUST NOT RUN"); } },
  }), error => !String(error).includes("PRIVATE-CONFIG"));
  assert.equal(called, false);
});
test("successful source responses remain streamed and request no credentials or caller headers", async () => {
  const config = defaults();
  let requested = false;
  const stream = await fetchExtensionSource(request, {
    config: () => config,
    egress: { request: async (_url, options) => {
        requested = true;
        assert.equal(options.streamResponse, true);
        assert.equal(options.maxBytes, request.maxBytes);
        assert.equal(options.headers, undefined);
        return { url: request.url, status: 200, headers: {}, redirects: [], body: Buffer.alloc(0),
          stream: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.close(); } }) };
      } },
  });
  assert.equal(requested, true);
  assert.deepEqual([...new Uint8Array(await new Response(stream).arrayBuffer())], [1, 2]);
});
test("the bridge independently caps a response even when a supplied port exceeds its budget", async () => {
  const stream = await fetchExtensionSource({ ...request, maxBytes: 1 }, {
    config: () => defaults(),
    egress: { request: async () => ({ url: request.url, status: 200, headers: {}, redirects: [], body: Buffer.alloc(0),
        stream: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.close(); } }) }) },
  });
  await assert.rejects(new Response(stream).arrayBuffer(), /limit|large/i);
});
test("HTTP failures and raw port errors never expose URL or credential-bearing causes", async () => {
  for (const status of [403, 404, 500]) {
    await assert.rejects(fetchExtensionSource(request, { config: () => defaults(), egress: {
        request: async () => ({ url: request.url, status, headers: {}, redirects: [], body: Buffer.from("PRIVATE-ERROR") }),
      } }), error => !String(error).includes("PRIVATE-ERROR"));
  }
  await assert.rejects(fetchExtensionSource(request, { config: () => defaults(), egress: {
      request: async () => { throw new Error("PRIVATE-CREDENTIAL"); },
    } }), error => !String(error).includes("PRIVATE-CREDENTIAL"));
});
