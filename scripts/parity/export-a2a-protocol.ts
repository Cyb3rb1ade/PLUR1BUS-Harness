import { createPrivateKey, createPublicKey } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { artifactUpdate, sseLines, statusUpdate } from "../../packages/core/src/a2a/events.ts";
import { parseParts, PartError } from "../../packages/core/src/a2a/parts.ts";
import { verifyPeerCard } from "../../packages/core/src/a2a/peer-card.ts";
import { hashKey } from "../../packages/core/src/a2a/policy.ts";
import { createA2aServer } from "../../packages/core/src/a2a/server.ts";
import { DEFAULT_LIMITS, type A2aTask } from "../../packages/core/src/a2a/types.ts";
import { recordPush } from "./a2a-push.ts";
import { exporterMain } from "./lib.mjs";

const base = "https://fixture-peer.example.invalid";
const source = `${base}/.well-known/agent-card.json`;

function recordParts() {
  const raw = [
    [{ kind: "text", text: "Grüße 🌱", metadata: { title: "Ignored" } }],
    [
      { kind: "text", text: "Report" },
      { kind: "file", file: { name: " page\n1 ", mimeType: " text/plain ", data: "Z g==\n" } },
      { kind: "file", file: { uri: "https://files.example.invalid/sample", bytes: "ZnI=" } },
      { kind: "data", data: { z: 1e-7, 10: null, 2: "two", nested: { b: false, a: 3 }, items: ["🌱", 0] } },
    ],
    [],
    [{ kind: "text", text: "   " }],
    [{ kind: "image", value: "sample" }],
    [{ kind: "data", data: [] }],
    [{ kind: "file", file: { name: "sample" } }],
    [{ kind: "file", file: { bytes: "x" } }],
    [{ kind: "file", file: { bytes: "" } }],
    [{ kind: "text", text: "🌱".repeat(5) }],
    [{ kind: "data", data: { name: "é".repeat(20) } }],
    [{ kind: "file", file: { bytes: "AQIDBAUG" } }],
    Array.from({ length: 5 }, () => ({ kind: "text", text: "a" })),
  ];
  const limits = { maxParts: 4, maxTextBytes: 16, maxDataBytes: 120, maxFileBytes: 4 };
  return { source: "packages/core/src/a2a/parts.ts", cases: raw.map(input => {
    const body = JSON.stringify(input);
    const bounds = input.length === 1 && input[0]?.kind === "data" ? { ...limits, maxDataBytes: 32 } : limits;
    try { return { body, limits: bounds, expected: parseParts(JSON.parse(body), { ...DEFAULT_LIMITS, ...bounds }) }; }
    catch (error) {
      if (!(error instanceof PartError)) throw error;
      return { body, limits: bounds, expectedError: { code: error.code, message: error.message } };
    }
  }) };
}

async function recordEvents() {
  const task: A2aTask = { kind: "task", id: "task-fixture", contextId: "context-fixture",
    status: { state: "submitted", timestamp: "2026-01-01T00:00:00.000Z" } };
  const frames = [
    task, statusUpdate(task, "working", false, "2026-01-01T00:00:01.000Z"),
    artifactUpdate(task, "artifact-fixture", "α\nβ", false, false),
    artifactUpdate(task, "artifact-fixture", "🎵", true, true),
    statusUpdate(task, "completed", true, "2026-01-01T00:00:02.000Z"),
  ];
  const chunks = [];
  for await (const chunk of sseLines("request-fixture", (async function* () { yield* frames; })())) {
    chunks.push(Buffer.from(chunk).toString("base64"));
  }
  return { source: "packages/core/src/a2a/events.ts", task, chunks };
}

export async function recordPeerCards() {
  const requireCore = createRequire(new URL("../../packages/core/package.json", import.meta.url));
  const { AgentCard, generateAgentCardSignature } = await import(requireCore.resolve("@a2a-js/sdk"));
  // RFC 8032's public example seed. Its public key is for these fixtures only.
  const privateKey = createPrivateKey({ type: "pkcs8", format: "der",
    key: Buffer.from("302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex") });
  const key = createPublicKey(privateKey).export({ format: "jwk" });
  const kid = "fixture-key";
  const sign = generateAgentCardSignature(privateKey, { alg: "EdDSA", kid, typ: "JWT" });
  const card = await sign(AgentCard.fromJSON({
    name: "Fixture Agent", description: "Public protocol example", version: "1",
    iconUrl: `${base}/symbol.png`,
    provider: { organization: "Fixture Org", url: base },
    supportedInterfaces: [{ protocolBinding: "JSONRPC", protocolVersion: "1.0", url: `${base}/messages` }],
    capabilities: { streaming: false, pushNotifications: true,
      extensions: [{ uri: "urn:fixture:tags", required: true, params: { display: "🌱", nested: ["", null, false, 0] } }] },
    defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: "bearer", bearerFormat: "fixture" } },
      client: { oauth2SecurityScheme: { flows: { clientCredentials: { tokenUrl: `${base}/token`, scopes: { chat: "Chat" } } } } },
      user: { oauth2SecurityScheme: { flows: { authorizationCode: {
        authorizationUrl: `${base}/authorize`, tokenUrl: `${base}/token`, pkceRequired: true,
      } } } },
    },
    securityRequirements: [{ schemes: { user: { list: ["chat"] } } }],
    skills: [{ id: "chat", name: "Chat", description: "Café", tags: ["chat"] }],
  }));
  const crossOrigin = await sign(AgentCard.fromJSON({ ...card, signatures: [], supportedInterfaces: [
    { protocolBinding: "JSONRPC", protocolVersion: "1.0", url: "https://other.example.invalid/messages" },
  ] }));
  const cases = [
    { name: "verified", card, kid, source },
    { name: "wrong-key-id", card, kid: "another-key", source },
    { name: "description-changed", card: { ...card, description: "Other public description" }, kid, source },
    { name: "unsigned", card: { ...card, signatures: [] }, kid, source },
    { name: "different-origin", card: crossOrigin, kid, source },
  ].map(input => {
    try { return { ...input, expected: verifyPeerCard(input.card, { key, kid: input.kid, cardUrl: input.source }) }; }
    catch (error) { return { ...input, expectedError: (error as { code?: string }).code }; }
  });
  return { source: "packages/core/src/a2a/peer-card.ts", key, cases };
}

async function recordEndpoint() {
  const bearer = "fixture-only";
  const server = createA2aServer({
    advertisedBaseUrl: base, defaultAgentId: "sample",
    peers: [{ id: "fixture-reader", keySha256: hashKey(bearer), grants: { sample: ["card.read", "task.read"] } }],
    agents: id => id === "sample" ? { optIn: true, displayName: "Example" } : undefined,
    provider: () => null, version: "fixture", limits: { maxBodyBytes: 256 },
  });
  const { url } = await server.listen();
  try {
    const call = (method: string, params: unknown) => JSON.stringify({ jsonrpc: "2.0", id: "id-fixture", method, params });
    const inputs = [
      { name: "scoped-card", method: "GET", path: "/a2a/sample/.well-known/agent-card.json" },
      { name: "default-card", method: "GET", path: "/.well-known/agent-card.json" },
      { name: "bad-route", method: "GET", path: "/about" },
      { name: "wrong-method", method: "GET", path: "/a2a/sample/" },
      { name: "no-auth", method: "GET", path: "/.well-known/agent-card.json", auth: false },
      { name: "hidden-agent", method: "GET", path: "/a2a/other/.well-known/agent-card.json" },
      { name: "wrong-encoding", body: "hello", contentType: "text/plain" },
      { name: "oversize", body: JSON.stringify({ message: "x".repeat(300) }) },
      { name: "parse", body: "{" },
      { name: "batch", body: "[]" },
      { name: "unknown-method", body: call("tasks/describe", {}) },
      { name: "forbidden", body: call("message/send", {}) },
      { name: "missing-param", body: call("tasks/get", {}) },
      { name: "task-missing", body: call("tasks/get", { id: "unassigned" }) },
    ];
    const cases = [];
    for (const { body, method = "POST", path = "/a2a/sample/", auth = true, contentType = "application/json", name } of inputs) {
      const response = await fetch(url + path, { method, headers: {
        ...(auth ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body !== undefined ? { "content-type": contentType } : {}),
      }, ...(body !== undefined ? { body } : {}) });
      const text = await response.text();
      const headers = Object.fromEntries(["allow", "content-type", "cache-control", "www-authenticate", "x-content-type-options"]
        .filter(key => response.headers.has(key)).map(key => [key, response.headers.get(key)]));
      cases.push({ name, request: { method, path, auth, contentType, body }, expected: {
        status: response.status, headers, bodyBase64: Buffer.from(text).toString("base64"),
      } });
    }
    return { source: "packages/core/src/a2a/server.ts", base, cases };
  } finally { await server.close(); }
}

async function recordLifecycle() {
  const bearer = "fixture-turn";
  const push = { id: "notification-example", url: "https://callbacks.example.invalid/fixture" };
  const clock = { now: () => Date.parse("2026-01-01T00:00:00.000Z") };
  const server = createA2aServer({
    advertisedBaseUrl: base, clock,
    peers: [{ id: "fixture-owner", keySha256: hashKey(bearer), grants: {
      sample: ["card.read", "task.send", "task.read", "task.cancel", "task.push"],
    } }],
    agents: id => id === "sample" ? { optIn: true } : undefined,
    provider: () => null,
    turns: {
      available: () => true, ensureSession: () => ({ sessionId: "test-session" }), cancel: () => true,
      async *run({ text, signal }) {
        if (text === "Hold") {
          if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        } else { yield { type: "delta", text: "Antwort 🌱" }; }
      },
    },
    pushTransport: {
      async decide() { return { allowed: true, address: "127.0.0.1", family: 4, host: "callbacks.example.invalid", port: 443 }; },
      async post() { return { status: 204 }; },
    },
  });
  const { url } = await server.listen();
  try {
    const cases: { method: string; params: unknown; expected: unknown }[] = [];
    const ids = new Map<string, string>();
    const normalize = (raw: string): string => {
      let text = raw.replace(/("role":"agent","messageId":")[0-9a-f-]{36}"/g, '$1fixture-reply"');
      for (const [from, to] of ids) text = text.replaceAll(from, to);
      return text;
    };
    const rpc = async (method: string, params: unknown, taskName?: string) => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: "lifecycle-rpc", method, params });
      const response = await fetch(url + "/a2a/sample/", { method: "POST", headers: {
        authorization: `Bearer ${bearer}`, "content-type": "application/json",
      }, body });
      if (response.status !== 200) throw new Error("fixture endpoint returned non-RPC response");
      const raw = await response.text();
      if (taskName) {
        const task = response.headers.get("content-type")?.startsWith("text/event-stream")
          ? JSON.parse(raw.split("\n", 1)[0]!.slice(6)).result.id
          : JSON.parse(raw).result.id;
        if (typeof task !== "string") throw new Error("fixture expected a task ID");
        ids.set(task, taskName);
      }
      cases.push({ method, params: JSON.parse(normalize(JSON.stringify(params))), expected: {
        contentType: response.headers.get("content-type"), rawBase64: Buffer.from(normalize(raw)).toString("base64"),
      } });
      return raw;
    };
    const message = (text: string, configuration?: unknown) => ({
      message: { role: "user", messageId: text.toLowerCase(), contextId: "fixture-context", parts: [{ kind: "text", text }] },
      ...(configuration ? { configuration } : {}),
    });
    const held = JSON.parse(await rpc("message/send", message("Hold"), "held-task")).result.id;
    await rpc("tasks/get", { id: held, historyLength: 0 });
    await rpc("tasks/pushNotificationConfig/set", { taskId: held, pushNotificationConfig: push });
    await rpc("tasks/pushNotificationConfig/get", { taskId: held, pushNotificationConfigId: push.id });
    await rpc("tasks/pushNotificationConfig/list", { taskId: held });
    await rpc("tasks/pushNotificationConfig/delete", { taskId: held, pushNotificationConfigId: push.id });
    await rpc("tasks/cancel", { id: held });
    await rpc("tasks/resubscribe", { id: held });
    await rpc("message/send", message("Block", { blocking: true }), "blocked-task");
    await rpc("message/stream", message("Stream"), "streamed-task");
    return { source: "packages/core/src/a2a/handler.ts", cases };
  } finally { await server.close(); }
}

export async function recordA2aProtocol() {
  const [events, peerCards, endpoint, lifecycle] = await Promise.all([recordEvents(), recordPeerCards(), recordEndpoint(), recordLifecycle()]);
  return { parts: recordParts(), events, "peer-cards": peerCards, endpoint, lifecycle, push: await recordPush() };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "a2a", build: recordA2aProtocol });
}
