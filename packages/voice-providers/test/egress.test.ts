import assert from "node:assert/strict";
import { test } from "node:test";
import { toEgressConfig, voiceEgressHosts } from "../src/egress.ts";
import { builtinCatalog, loadCatalog } from "../src/local/catalog.ts";

test("only enabled providers declare hosts; region and baseUrl decide which", () => {
  const d = voiceEgressHosts({ providers: {
    elevenlabs: { enabled: true, region: "eu" },
    xai: { enabled: true },
    gemini: { enabled: false },
    polly: { enabled: true, region: "eu-central-1" },
  } });
  assert.deepEqual(d.hosts.map((h) => h.host), ["api.eu.residency.elevenlabs.io", "api.x.ai", "polly.eu-central-1.amazonaws.com"]);
  assert.ok(d.hosts.every((h) => h.tls && h.port === 443 && !h.loopback));
  assert.deepEqual(d.unresolved, []);
  assert.deepEqual(voiceEgressHosts({}).hosts, []);
});

test("a baseUrl wins over the region, with its port; loopback relays are marked", () => {
  const d = voiceEgressHosts({ providers: { elevenlabs: { enabled: true, region: "us", baseUrl: "https://relay.example.com:8443/x" }, gemini: { enabled: true, baseUrl: "http://127.0.0.1:9000" } } });
  assert.deepEqual(d.hosts.map((h) => [h.host, h.port, h.tls, h.loopback]), [["127.0.0.1", 9000, false, true], ["relay.example.com", 8443, true, false]]);
  const { config, plaintextNonLoopback } = toEgressConfig(d);
  assert.deepEqual(config, { allowHosts: ["127.0.0.1", "relay.example.com"], allowPorts: [8443, 9000], allowLoopback: true });
  assert.deepEqual(plaintextNonLoopback, []);
});

test("Polly without a region is reported as unresolved instead of guessed", () => {
  const d = voiceEgressHosts({ providers: { polly: { enabled: true } } });
  assert.deepEqual(d.hosts, []);
  assert.deepEqual(d.unresolved, ["polly"]);
});

test("model downloads declare github.com and the hosts its release assets redirect to, plus any override host", () => {
  const d = voiceEgressHosts({ catalog: builtinCatalog() });
  assert.deepEqual(d.hosts.map((h) => h.host), ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
  const c = loadCatalog({ models: { "x-tts": { kind: "tts", engine: "vits", displayName: "X", licence: { id: "MIT", name: "MIT", commercial: true, status: "confirmed" }, download: [{ url: "https://models.example.org/x.tar.bz2", sha256: "a".repeat(64), sizeBytes: 1, archive: "tar.bz2" }], roles: { model: "m.onnx" } } } });
  assert.ok(voiceEgressHosts({ catalog: c }).hosts.some((h) => h.host === "models.example.org"));
});

test("an invalid baseUrl throws instead of yielding a partial list", () => {
  assert.throws(() => voiceEgressHosts({ providers: { xai: { enabled: true, baseUrl: "not a url" } } }));
});
