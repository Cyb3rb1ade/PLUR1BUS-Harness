import { test } from "node:test";
import assert from "node:assert/strict";
import { egressHosts, embeddingEgressHosts, rerankEgressHosts, toEgressConfig } from "../src/egress.ts";
import { ConfigError } from "../src/config.ts";

test("hosted providers declare their API host on 443 with TLS", () => {
  assert.deepEqual(embeddingEgressHosts({ provider: "openai", model: "m", dimensions: 8, secretName: "k" }), [{ host: "api.openai.com", port: 443, tls: true, loopback: false }]);
  assert.deepEqual(embeddingEgressHosts({ provider: "google", model: "m", dimensions: 8, secretName: "k" })[0]!.host, "generativelanguage.googleapis.com");
  assert.deepEqual(rerankEgressHosts({ provider: "cohere", model: "m", secretName: "k" })[0]!.host, "api.cohere.com");
});

test("local servers are loopback, plain http, with their port; IPv6 keeps its brackets", () => {
  assert.deepEqual(embeddingEgressHosts({ provider: "ollama", model: "m", dimensions: 8 }), [{ host: "127.0.0.1", port: 11434, tls: false, loopback: true }]);
  assert.deepEqual(embeddingEgressHosts({ provider: "tei", model: "m", dimensions: 8, baseURL: "http://[::1]:8080" }), [{ host: "[::1]", port: 8080, tls: false, loopback: true }]);
  assert.equal(embeddingEgressHosts({ provider: "tei", model: "m", dimensions: 8, baseURL: "http://localhost:8080" })[0]!.loopback, true);
});

test("a LAN host over plain http is declared and flagged as not representable", () => {
  const decl = egressHosts({ embedding: { provider: "tei", model: "m", dimensions: 8, baseURL: "http://nas.lan:8080" } });
  const { config, plaintextNonLoopback } = toEgressConfig(decl);
  assert.deepEqual(plaintextNonLoopback.map((h) => h.host), ["nas.lan"]);
  assert.deepEqual(config, { allowHosts: ["nas.lan"], allowPorts: [8080], allowLoopback: false });
});

test("mixed configs are merged, de-duplicated and sorted", () => {
  const decl = egressHosts({
    embedding: [{ provider: "cohere", model: "e", dimensions: 8, secretName: "k" }, { provider: "ollama", model: "m", dimensions: 8 }],
    rerank: { provider: "cohere", model: "r", secretName: "k" },
  });
  assert.deepEqual(decl.hosts.map((h) => `${h.host}:${h.port}`), ["127.0.0.1:11434", "api.cohere.com:443"]);
  const { config } = toEgressConfig(decl);
  assert.deepEqual(config, { allowHosts: ["127.0.0.1", "api.cohere.com"], allowPorts: [443, 11434], allowLoopback: true });
});

test("an invalid config throws with the indexed path and yields no partial list", () => {
  assert.throws(
    () => egressHosts({ embedding: [{ provider: "openai", model: "m", dimensions: 8, secretName: "k" }, { provider: "tei", model: "m", dimensions: 8 } as never] }),
    (e: unknown) => e instanceof ConfigError && /embedding\[1\]\.baseURL/.test(e.message),
  );
});
