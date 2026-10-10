import { test } from "node:test";
import assert from "node:assert/strict";
import { egressHosts, toEgressConfig, voiceEgressHosts } from "../src/egress.ts";
import type { VoiceProvidersConfig } from "../src/registry.ts";

test("egress: declares default vendor hosts for enabled cloud providers", () => {
  const config: VoiceProvidersConfig = {
    elevenlabs: { enabled: true, apiKeyRef: "ref" },
    xai: { enabled: true, apiKeyRef: "ref" },
    gemini: { enabled: true, apiKeyRef: "ref" },
    polly: { enabled: true, region: "eu-central-1" },
  };
  const hosts = voiceEgressHosts(config);
  const hostnames = hosts.map((h) => h.host).sort();
  assert.ok(hostnames.includes("api.elevenlabs.io"));
  assert.ok(hostnames.includes("api.x.ai"));
  assert.ok(hostnames.includes("generativelanguage.googleapis.com"));
  assert.ok(hostnames.includes("polly.eu-central-1.amazonaws.com"));
  assert.ok(hosts.every((h) => h.tls === true));
  assert.ok(hosts.every((h) => h.port === 443));
});

test("egress: custom baseUrl updates egress declaration", () => {
  const config: VoiceProvidersConfig = {
    elevenlabs: { enabled: true, apiKeyRef: "ref", baseUrl: "https://custom-eleven.example.com:8443" },
  };
  const hosts = voiceEgressHosts(config);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0]!.host, "custom-eleven.example.com");
  assert.equal(hosts[0]!.port, 8443);
  assert.equal(hosts[0]!.tls, true);
});

test("egress: toEgressConfig formats allowlist and flags non-loopback plaintext", () => {
  const decl = egressHosts({
    elevenlabs: { enabled: true, apiKeyRef: "ref" },
  });
  const { config, plaintextNonLoopback } = toEgressConfig(decl);
  assert.ok(config.allowHosts.includes("api.elevenlabs.io"));
  assert.ok(config.allowPorts.includes(443));
  assert.equal(config.allowLoopback, false);
  assert.equal(plaintextNonLoopback.length, 0);
});
