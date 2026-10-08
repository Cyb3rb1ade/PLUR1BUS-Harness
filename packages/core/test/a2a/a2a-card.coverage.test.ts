import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { A2A_PROTOCOL_VERSION, buildAgentCard, DEFAULT_CARD_FEATURES, validateAgentCard, type AgentCard } from "../../src/a2a/card.ts";
import type { A2aAgentInfo } from "../../src/a2a/types.ts";

const BASE = "http://127.0.0.1:4100";
const card = (info: A2aAgentInfo = { optIn: true }, base = BASE, id = "bernd", features = DEFAULT_CARD_FEATURES): AgentCard => buildAgentCard(id, info, base, "1.2.3", features);
const clone = (): Record<string, any> => structuredClone(card({ optIn: true, skills: [{ id: "s", name: "S", description: "d", tags: ["t"] }] })) as Record<string, any>;

describe("buildAgentCard", () => {
  it("minimal info yields defaults and a valid card", () => {
    const c = card();
    assert.equal(c.protocolVersion, A2A_PROTOCOL_VERSION);
    assert.equal(c.name, "bernd"); assert.equal(c.description, "A PLUR1BUS agent.");
    assert.equal(c.url, `${BASE}/a2a/bernd/`); assert.equal(c.version, "1.2.3"); assert.equal(c.preferredTransport, "JSONRPC");
    assert.deepEqual(c.defaultInputModes, ["text/plain"]); assert.deepEqual(c.defaultOutputModes, ["text/plain"]);
    assert.deepEqual(c.skills, [{ id: "chat", name: "Chat", description: "Answers a text message.", tags: [] }]);
    assert.deepEqual(c.security, [{ peerKey: [] }]);
    assert.equal(c.securitySchemes.peerKey.scheme, "bearer");
    assert.deepEqual(validateAgentCard(c), []);
  });
  it("re-exports the protocol version and default features", () => {
    assert.equal(A2A_PROTOCOL_VERSION, "0.3.0");
    assert.deepEqual(DEFAULT_CARD_FEATURES, { streaming: true, pushNotifications: true });
    assert.deepEqual(card().capabilities, { streaming: true, pushNotifications: true, stateTransitionHistory: false });
  });
  const featureCases: [string, { streaming: boolean; pushNotifications: boolean }][] = [
    ["both off", { streaming: false, pushNotifications: false }],
    ["streaming only", { streaming: true, pushNotifications: false }],
    ["push only", { streaming: false, pushNotifications: true }],
  ];
  for (const [label, f] of featureCases) {
    it(`capabilities follow the features (${label})`, () => {
      assert.deepEqual(card({ optIn: true }, BASE, "a", f).capabilities, { ...f, stateTransitionHistory: false });
    });
  }
  it("non-boolean feature values count as off", () => {
    const c = card({ optIn: true }, BASE, "a", { streaming: "yes", pushNotifications: 1 } as never);
    assert.deepEqual(c.capabilities, { streaming: false, pushNotifications: false, stateTransitionHistory: false });
  });
  const urlCases: [string, string][] = [
    ["http://h:1", "http://h:1/a2a/bernd/"], ["http://h:1/", "http://h:1/a2a/bernd/"], ["http://h:1////", "http://h:1/a2a/bernd/"],
    ["https://h/base", "https://h/base/a2a/bernd/"],
  ];
  for (const [base, expected] of urlCases) it(`base url ${base} -> ${expected}`, () => assert.equal(card({ optIn: true }, base).url, expected));
  it("sanitises name and description: control characters become spaces, trimmed, truncated", () => {
    const c = card({ optIn: true, displayName: "\u0000Be\trnd\n\u007f" + "x".repeat(200), description: "  a\u001fb  " + "y".repeat(500) });
    assert.equal(c.name.length, 80); assert.ok(!/[\u0000-\u001f\u007f]/.test(c.name));
    assert.ok(c.name.startsWith("Be rnd"));
    assert.equal(c.description.length, 400); assert.ok(c.description.startsWith("a b"));
  });
  it("blank or control-only display fields fall back", () => {
    for (const v of ["", "   ", "\n\t\u0000", undefined]) {
      const c = card({ optIn: true, displayName: v as string, description: v as string });
      assert.equal(c.name, "bernd"); assert.equal(c.description, "A PLUR1BUS agent.");
    }
  });
  it("keeps unicode", () => {
    assert.equal(card({ optIn: true, displayName: "Bärbel 🌍 日本語" }).name, "Bärbel 🌍 日本語");
  });
  it("never copies unknown fields from the host info", () => {
    const c = card({ optIn: true, model: "gpt", memory: "secret", workspace: "/home/u" } as never);
    const s = JSON.stringify(c);
    assert.ok(!s.includes("gpt") && !s.includes("secret") && !s.includes("/home/u"));
  });
  it("skills: cleaned and capped (32 skills, 8 tags; id 64, name 80, description 400, tag 32)", () => {
    const skills = Array.from({ length: 40 }, (_, i) => ({
      id: `id${i}`.padEnd(100, "i"), name: "n".repeat(120), description: "d".repeat(900), tags: Array.from({ length: 12 }, () => "t".repeat(50)),
    }));
    const c = card({ optIn: true, skills });
    assert.equal(c.skills.length, 32);
    const s = c.skills[0]!;
    assert.equal(s.id.length, 64); assert.equal(s.name.length, 80); assert.equal(s.description.length, 400);
    assert.equal(s.tags.length, 8); assert.ok(s.tags.every((t) => t.length === 32));
    assert.deepEqual(validateAgentCard(c), []);
  });
  it("skill fields fall back when blank; missing tags become []", () => {
    const c = card({ optIn: true, skills: [{ id: " ", name: "\n", description: undefined as never }, { id: "x", name: "X", tags: ["", "ok"] }] as never });
    assert.deepEqual(c.skills[0], { id: "skill", name: "Skill", description: "No description.", tags: [] });
    assert.deepEqual(c.skills[1]!.tags, ["tag", "ok"]);
    assert.deepEqual(validateAgentCard(c), []);
  });
  it("skill modes: kept (max 8, cleaned, blanks dropped) or omitted when empty/absent", () => {
    const c = card({ optIn: true, skills: [
      { id: "a", name: "A", inputModes: ["text/plain", "\n", " application/json "], outputModes: Array.from({ length: 12 }, (_, i) => `m${i}`) },
      { id: "b", name: "B", inputModes: [], outputModes: ["", "   "] },
      { id: "c", name: "C" },
    ] });
    assert.deepEqual(c.skills[0]!.inputModes, ["text/plain", "application/json"]);
    assert.equal(c.skills[0]!.outputModes!.length, 8);
    assert.ok(!("inputModes" in c.skills[1]!)); assert.ok(!("outputModes" in c.skills[1]!));
    assert.ok(!("inputModes" in c.skills[2]!));
    assert.deepEqual(validateAgentCard(c), []);
  });
  it("default modes: custom values are used; blank-only or empty fall back", () => {
    assert.deepEqual(card({ optIn: true, defaultInputModes: ["application/json"], defaultOutputModes: ["image/png", "text/plain"] }).defaultInputModes, ["application/json"]);
    assert.deepEqual(card({ optIn: true, defaultOutputModes: ["image/png", "text/plain"] }).defaultOutputModes, ["image/png", "text/plain"]);
    for (const m of [[], ["", "  "]] as string[][]) {
      const c = card({ optIn: true, defaultInputModes: m, defaultOutputModes: m });
      assert.deepEqual(c.defaultInputModes, ["text/plain"]); assert.deepEqual(c.defaultOutputModes, ["text/plain"]);
    }
    assert.equal(card({ optIn: true, defaultInputModes: ["m".repeat(100)] }).defaultInputModes[0]!.length, 64);
    assert.equal(card({ optIn: true, defaultInputModes: Array.from({ length: 20 }, (_, i) => `m${i}`) }).defaultInputModes.length, 8);
  });
});

describe("validateAgentCard", () => {
  it("a built card is valid", () => assert.deepEqual(validateAgentCard(clone()), []));
  for (const [label, v] of [["null", null], ["undefined", undefined], ["array", []], ["string", "x"], ["number", 1]] as [string, unknown][]) {
    it(`non-object ${label}`, () => assert.deepEqual(validateAgentCard(v), ["card: not an object"]));
  }
  it("an empty object reports every missing key", () => {
    const errs = validateAgentCard({});
    for (const k of ["protocolVersion", "name", "description", "url", "preferredTransport", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills", "securitySchemes", "security"]) {
      assert.ok(errs.includes(`card: missing key ${k}`), k);
    }
    assert.ok(errs.includes("card.capabilities: object required"));
    assert.ok(errs.includes("card.skills: non-empty array required"));
    assert.ok(errs.includes("card.security: non-empty array required"));
    assert.ok(errs.includes("card.securitySchemes.peerKey: http bearer required"));
  });
  const mutations: [string, (c: Record<string, any>) => void, string][] = [
    ["unexpected top-level key", (c) => { c.extra = 1; }, "card: unexpected key extra"],
    ["name empty", (c) => { c.name = ""; }, "card.name: non-empty string required"],
    ["name number", (c) => { c.name = 5; }, "card.name: non-empty string required"],
    ["description missing value", (c) => { c.description = undefined; }, "card.description: non-empty string required"],
    ["version empty", (c) => { c.version = ""; }, "card.version: non-empty string required"],
    ["wrong protocol", (c) => { c.protocolVersion = "0.2.0"; }, "card.protocolVersion: must be 0.3.0"],
    ["wrong transport", (c) => { c.preferredTransport = "GRPC"; }, "card.preferredTransport: must be JSONRPC"],
    ["url not string", (c) => { c.url = 5; }, "card.url: must be an http(s) URL ending in /a2a/<agent>/"],
    ["url ftp", (c) => { c.url = "ftp://h/a2a/x/"; }, "card.url: must be an http(s) URL ending in /a2a/<agent>/"],
    ["url without trailing slash", (c) => { c.url = "http://h/a2a/x"; }, "card.url: must be an http(s) URL ending in /a2a/<agent>/"],
    ["url with whitespace", (c) => { c.url = "http://h /a2a/x/"; }, "card.url: must be an http(s) URL ending in /a2a/<agent>/"],
    ["url bad agent chars", (c) => { c.url = "http://h/a2a/x y/"; }, "card.url: must be an http(s) URL ending in /a2a/<agent>/"],
    ["capabilities missing", (c) => { delete c.capabilities; }, "card.capabilities: object required"],
    ["capabilities null", (c) => { c.capabilities = null; }, "card.capabilities: object required"],
    ["capabilities string", (c) => { c.capabilities = "x"; }, "card.capabilities: object required"],
    ["streaming not boolean", (c) => { c.capabilities.streaming = "yes"; }, "card.capabilities.streaming: boolean required"],
    ["push not boolean", (c) => { c.capabilities.pushNotifications = 1; }, "card.capabilities.pushNotifications: boolean required"],
    ["history not boolean", (c) => { delete c.capabilities.stateTransitionHistory; }, "card.capabilities.stateTransitionHistory: boolean required"],
    ["history true", (c) => { c.capabilities.stateTransitionHistory = true; }, "card.capabilities.stateTransitionHistory: must be false"],
    ["input modes empty", (c) => { c.defaultInputModes = []; }, "card.defaultInputModes: non-empty string array required"],
    ["input modes not array", (c) => { c.defaultInputModes = "text/plain"; }, "card.defaultInputModes: non-empty string array required"],
    ["output modes with number", (c) => { c.defaultOutputModes = ["a", 1]; }, "card.defaultOutputModes: non-empty string array required"],
    ["skills not array", (c) => { c.skills = {}; }, "card.skills: non-empty array required"],
    ["skills empty", (c) => { c.skills = []; }, "card.skills: non-empty array required"],
    ["skill null", (c) => { c.skills = [null]; }, "card.skills[0]: not an object"],
    ["skill string", (c) => { c.skills = ["x"]; }, "card.skills[0]: not an object"],
    ["skill extra key", (c) => { c.skills[0].secret = 1; }, "card.skills[0]: unexpected key secret"],
    ["skill missing tags", (c) => { delete c.skills[0].tags; }, "card.skills[0]: missing key tags"],
    ["skill id empty", (c) => { c.skills[0].id = ""; }, "card.skills[0].id: non-empty string required"],
    ["skill name number", (c) => { c.skills[0].name = 1; }, "card.skills[0].name: non-empty string required"],
    ["skill description empty", (c) => { c.skills[0].description = ""; }, "card.skills[0].description: non-empty string required"],
    ["skill tags not array", (c) => { c.skills[0].tags = "t"; }, "card.skills[0].tags: string array required"],
    ["skill tags with number", (c) => { c.skills[0].tags = ["t", 2]; }, "card.skills[0].tags: string array required"],
    ["skill inputModes bad", (c) => { c.skills[0].inputModes = "x"; }, "card.skills[0].inputModes: string array required"],
    ["skill outputModes bad", (c) => { c.skills[0].outputModes = [1]; }, "card.skills[0].outputModes: string array required"],
    ["securitySchemes null", (c) => { c.securitySchemes = null; }, "card.securitySchemes.peerKey: http bearer required"],
    ["securitySchemes string", (c) => { c.securitySchemes = "x"; }, "card.securitySchemes.peerKey: http bearer required"],
    ["securitySchemes without peerKey", (c) => { c.securitySchemes = {}; }, "card.securitySchemes.peerKey: http bearer required"],
    ["peerKey wrong type", (c) => { c.securitySchemes.peerKey.type = "apiKey"; }, "card.securitySchemes.peerKey: http bearer required"],
    ["peerKey wrong scheme", (c) => { c.securitySchemes.peerKey.scheme = "basic"; }, "card.securitySchemes.peerKey: http bearer required"],
    ["security not array", (c) => { c.security = {}; }, "card.security: non-empty array required"],
    ["security empty", (c) => { c.security = []; }, "card.security: non-empty array required"],
  ];
  for (const [label, mutate, expected] of mutations) {
    it(`reports: ${label}`, () => {
      const c = clone(); mutate(c);
      assert.ok(validateAgentCard(c).includes(expected), `${expected} in ${JSON.stringify(validateAgentCard(c))}`);
    });
  }
  it("accepts https urls, dotted/underscored agent ids and skills with valid optional modes", () => {
    const c = clone();
    c.url = "https://example.test:8443/base/a2a/Agent_1.x-y/";
    c.skills[0].inputModes = ["text/plain"]; c.skills[0].outputModes = [];
    assert.deepEqual(validateAgentCard(c), []);
  });
  it("every skill is checked and indexed", () => {
    const c = clone();
    c.skills.push({ id: "", name: "n", description: "d", tags: [] });
    assert.deepEqual(validateAgentCard(c), ["card.skills[1].id: non-empty string required"]);
  });
});
