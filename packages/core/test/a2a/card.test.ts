import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentCard, validateAgentCard } from "../../src/a2a/card.ts";
import { AGENTS, BASE, KEY_A, KEY_B, http, rig } from "./helpers.ts";

describe("agent card", () => {
  it("is schema-valid and carries the per-agent base url", () => {
    const c = buildAgentCard("bernd", AGENTS.bernd!, BASE, "0.1.0");
    assert.deepEqual(validateAgentCard(c), []);
    assert.equal(c.url, `${BASE}/a2a/bernd/`);
    assert.equal(c.protocolVersion, "0.3.0");
    assert.equal(c.preferredTransport, "JSONRPC");
    assert.equal(c.capabilities.streaming, true);
    assert.equal(c.capabilities.pushNotifications, true);
    assert.equal(c.capabilities.stateTransitionHistory, false);
    assert.deepEqual(c.defaultInputModes, ["text/plain"]);
    assert.deepEqual(c.defaultOutputModes, ["text/plain"]);
    assert.equal(c.securitySchemes.peerKey.type, "http");
    assert.equal(c.securitySchemes.peerKey.scheme, "bearer");
  });
  it("snapshots the A2A 0.3.0 Agent Card fields", () => {
    const c = buildAgentCard("bernd", {
      optIn: true, displayName: "Bernd", description: "Helpful assistant",
      defaultInputModes: ["text/plain", "application/json"], defaultOutputModes: ["text/plain"],
      skills: [{ id: "chat", name: "Chat", description: "Talk", tags: ["general"], inputModes: ["text/plain"], outputModes: ["text/plain"] }],
    }, BASE, "0.1.0");
    assert.deepEqual(validateAgentCard(c), []);
    assert.deepEqual(c, {
      protocolVersion: "0.3.0",
      name: "Bernd",
      description: "Helpful assistant",
      url: `${BASE}/a2a/bernd/`,
      preferredTransport: "JSONRPC",
      version: "0.1.0",
      capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: false },
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["text/plain"],
      skills: [{ id: "chat", name: "Chat", description: "Talk", tags: ["general"], inputModes: ["text/plain"], outputModes: ["text/plain"] }],
      securitySchemes: { peerKey: { type: "http", scheme: "bearer", description: "A per-peer API key issued by the operator." } },
      security: [{ peerKey: [] }],
    });
  });
  it("falls back to a generic skill and the agent id", () => {
    const c = buildAgentCard("anna", AGENTS.anna!, `${BASE}/`, "0.1.0");
    assert.equal(c.name, "anna");
    assert.deepEqual(c.skills.map((s) => s.id), ["chat"]);
    assert.equal(c.url, `${BASE}/a2a/anna/`);
    assert.deepEqual(validateAgentCard(c), []);
  });
  it("is content-free: only the closed key set, control characters stripped, no host-internal strings", () => {
    const c = buildAgentCard("bernd", { optIn: true, displayName: "Be\u0000rnd", description: "x".repeat(5000), ...({ workspace: "/home/u/ws", model: "gpt-x", provider: "fake" } as object) }, BASE, "0.1.0");
    const s = JSON.stringify(c);
    for (const leak of ["/home/u/ws", "gpt-x", "provider", "workspace", "memory", "\u0000"]) assert.ok(!s.includes(leak), leak);
    assert.ok(c.description.length <= 400);
    assert.equal(c.name, "Be rnd");
  });
  it("the validator rejects drift", () => {
    const c = buildAgentCard("bernd", AGENTS.bernd!, BASE, "0.1.0") as unknown as Record<string, unknown>;
    assert.ok(validateAgentCard({ ...c, extra: 1 }).some((e) => e.includes("unexpected key extra")));
    assert.ok(validateAgentCard({ ...c, capabilities: { streaming: "yes", pushNotifications: false, stateTransitionHistory: false } }).length > 0);
    assert.ok(validateAgentCard({ ...c, url: "ftp://x" }).length > 0);
    assert.ok(validateAgentCard({ ...c, skills: [] }).length > 0);
    assert.ok(validateAgentCard(null).length > 0);
  });
  it("is served per agent over GET with security headers, to a granted peer only", async () => {
    const { h } = rig();
    const ok = await http(h, { method: "GET", path: "/a2a/bernd/.well-known/agent-card.json" });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["Cache-Control"], "no-store");
    assert.deepEqual(validateAgentCard(JSON.parse(ok.body)), []);
    // peer-b may read bernd's card but holds nothing on `hidden`; anna's card is not granted to peer-a.
    assert.equal((await http(h, { method: "GET", path: "/a2a/anna/.well-known/agent-card.json" })).status, 404);
    assert.equal((await http(h, { method: "GET", path: "/a2a/anna/.well-known/agent-card.json", key: KEY_B })).status, 200);
    assert.equal((await http(h, { method: "GET", path: "/a2a/hidden/.well-known/agent-card.json" })).status, 404);
    assert.equal((await http(h, { method: "GET", path: "/a2a/nobody/.well-known/agent-card.json" })).status, 404);
  });
  it("has no root card unless defaultAgentId is set, and rejects other methods", async () => {
    const { h } = rig();
    assert.equal((await http(h, { method: "GET", path: "/.well-known/agent-card.json" })).status, 404);
    const r = await http(h, { method: "POST", path: "/a2a/bernd/.well-known/agent-card.json", body: {} });
    assert.equal(r.status, 405); assert.equal(r.headers.Allow, "GET");
    const rooted = rig({ opts: { defaultAgentId: "bernd" } });
    const root = await http(rooted.h, { method: "GET", path: "/.well-known/agent-card.json" });
    assert.equal(root.status, 200);
    const card = JSON.parse(root.body);
    assert.deepEqual(validateAgentCard(card), []);
    assert.equal(card.url, `${BASE}/a2a/bernd/`);
  });
});
