import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SCHEMA, defaults, tierOf, validate } from "../src/index.ts";

// Owner decision 2026-10-18: "Nur lokal" exists, installation-wide plus a per-agent override; a cloud reranker needs its own
// function-specific privacy acknowledgment like the text embedding.
test("privacy.localOnly defaults to off, is a basic core-restart key and needs owner/admin plus audit", () => {
  const cfg = defaults();
  assert.deepEqual(cfg.privacy, { localOnly: false, localEndpoints: [] });
  const node = CONFIG_SCHEMA.properties.privacy.properties.localOnly;
  assert.equal(node["x-tier"], "basic");
  assert.equal(node["x-restart"], "core");
  assert.deepEqual(node["x-write-roles"], ["owner", "admin"]);
  assert.equal(node["x-audit"], true);
  assert.equal(tierOf("privacy.localOnly"), "basic");
  const endpoints = CONFIG_SCHEMA.properties.privacy.properties.localEndpoints;
  assert.deepEqual(endpoints["x-write-roles"], ["owner", "admin"]);
  assert.equal(endpoints["x-audit"], true);
});

test("privacy.localEndpoints accepts exact http(s) origins only", () => {
  const cfg: any = defaults();
  cfg.privacy.localOnly = true;
  cfg.privacy.localEndpoints = ["http://192.168.1.20:11434", "https://vllm.home.arpa", "http://10.0.0.5:8000/"];
  assert.equal(validate(cfg).ok, true);
  for (const bad of ["192.168.1.20:11434", "ftp://nas.local", "http://user:pw@nas.local", "http://nas.local/v1", "http://nas.local?x=1", "http:// space"]) {
    cfg.privacy.localEndpoints = [bad];
    assert.equal(validate(cfg).ok, false, bad);
  }
  cfg.privacy.localEndpoints = [];
  cfg.privacy.extra = true;
  assert.equal(validate(cfg).ok, false);
});

test("an agent may override privacy.localOnly; the override is closed and audited", () => {
  const cfg: any = defaults();
  cfg.agents.bernd = { privacy: { localOnly: true } };
  assert.equal(validate(cfg).ok, true);
  cfg.agents.bernd = { privacy: { localOnly: false } };
  assert.equal(validate(cfg).ok, true);
  cfg.agents.bernd = { privacy: { localOnly: "yes" } };
  assert.equal(validate(cfg).ok, false);
  cfg.agents.bernd = { privacy: { localEndpoints: [] } };
  assert.equal(validate(cfg).ok, false);
  const node = CONFIG_SCHEMA.properties.agents.additionalProperties.properties.privacy;
  assert.deepEqual(node["x-write-roles"], ["owner", "admin"]);
  assert.equal(node.properties.localOnly["x-audit"], true);
});

test("memory.reranker.privacyAck has the same closed, dated, role-bound form as memory.embedding.privacyAck", () => {
  const props = CONFIG_SCHEMA.properties.memory.properties;
  const { description: _a, ...embedding } = props.embedding.properties.privacyAck;
  const { description: _b, ...reranker } = props.reranker.properties.privacyAck;
  assert.deepEqual(reranker, embedding);
  const cfg: any = defaults();
  assert.equal(cfg.memory.reranker, undefined);
  const ack = { provider: "cohere", acknowledgedAt: "2026-10-18T10:00:00Z", by: "owner" };
  cfg.memory.reranker = { privacyAck: ack };
  assert.equal(validate(cfg).ok, true);
  for (const patch of [{ acknowledgedAt: "invalid" }, { by: "" }, { extra: true }]) {
    cfg.memory.reranker.privacyAck = { ...ack, ...patch };
    assert.equal(validate(cfg).ok, false);
  }
});
