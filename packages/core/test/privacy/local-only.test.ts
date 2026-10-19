import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertLocalEndpoint, isLocalEndpoint, isLoopbackEndpoint, localOnlyFor, localOnlyShared, localOnlyDenied, localEndpoints } from "../../src/privacy/local-only.ts";

describe("privacy.localOnly", () => {
  it("loopback is local by spelling: localhost, 127.0.0.0/8 and ::1", () => {
    for (const u of ["http://localhost:11434/v1", "https://localhost", "http://127.0.0.1:8080", "http://127.255.0.9", "http://[::1]:8000/v1"]) assert.equal(isLoopbackEndpoint(u), true, u);
    for (const u of ["http://192.168.1.5:11434", "http://10.0.0.1", "http://localhost.example.com", "http://127.0.0.1.nip.io", "https://api.openai.com/v1", "ftp://localhost", "not a url", "http://[::2]"]) assert.equal(isLoopbackEndpoint(u), false, u);
  });

  it("a LAN address is local only when its exact origin is listed in privacy.localEndpoints", () => {
    const listed = ["http://192.168.1.20:11434", "https://vllm.home.arpa/"];
    assert.equal(isLocalEndpoint("http://192.168.1.20:11434/v1", listed), true);
    assert.equal(isLocalEndpoint("https://vllm.home.arpa/v1/embeddings", listed), true);
    assert.equal(isLocalEndpoint("http://192.168.1.20:8080/v1", listed), false, "another port is another origin");
    assert.equal(isLocalEndpoint("https://192.168.1.20:11434/v1", listed), false, "another scheme is another origin");
    assert.equal(isLocalEndpoint("http://192.168.1.21:11434/v1", listed), false);
    assert.equal(isLocalEndpoint("http://user:pw@192.168.1.20:11434/v1", listed), false, "credentials in the URL are never local");
    assert.equal(isLocalEndpoint("http://192.168.1.20:11434/v1", ["not a url"]), false);
  });

  it("an agent override wins in both directions; unset inherits the installation value", () => {
    const cfg = { privacy: { localOnly: true, localEndpoints: [] }, agents: { a: {}, b: { privacy: { localOnly: false } }, c: { privacy: { localOnly: true } } } };
    assert.equal(localOnlyFor(cfg), true);
    assert.equal(localOnlyFor(cfg, "a"), true);
    assert.equal(localOnlyFor(cfg, "b"), false);
    assert.equal(localOnlyFor(cfg, "unknown"), true);
    const off = { privacy: { localOnly: false }, agents: { c: { privacy: { localOnly: true } } } };
    assert.equal(localOnlyFor(off), false);
    assert.equal(localOnlyFor(off, "c"), true);
    assert.equal(localOnlyFor(off, "d"), false);
  });

  it("shared services (engine, media index) stay local while the installation or any agent is local-only", () => {
    assert.equal(localOnlyShared({ privacy: { localOnly: false }, agents: {} }), false);
    assert.equal(localOnlyShared({ privacy: { localOnly: true }, agents: { b: { privacy: { localOnly: false } } } }), true);
    assert.equal(localOnlyShared({ privacy: { localOnly: false }, agents: { c: { privacy: { localOnly: true } } } }), true);
    assert.equal(localOnlyShared(undefined), false);
  });

  it("refuses with E_DENIED reason local-only, names the switch, and shows the origin only", () => {
    const e = localOnlyDenied("embedding provider openrouter", "https://openrouter.ai/api/v1?key=x");
    assert.equal(e.error, "E_DENIED");
    assert.equal(e.reason, "local-only");
    assert.match(e.message, /privacy\.localOnly/);
    assert.match(e.message, /https:\/\/openrouter\.ai/);
    assert.equal(e.message.includes("key=x"), false);
    assert.equal(e.message.includes("/api/v1"), false);
  });

  it("assertLocalEndpoint treats a missing endpoint as the provider's cloud default", () => {
    assert.doesNotThrow(() => assertLocalEndpoint({ active: false, what: "x", endpoint: undefined, listed: [] }));
    assert.throws(() => assertLocalEndpoint({ active: true, what: "x", endpoint: undefined, listed: [] }), (e: any) => e.reason === "local-only");
    assert.doesNotThrow(() => assertLocalEndpoint({ active: true, what: "x", endpoint: "http://127.0.0.1:1/v1", listed: [] }));
    assert.equal(localEndpoints({ privacy: { localEndpoints: ["http://a.b", 3] } }).length, 1);
  });
});
