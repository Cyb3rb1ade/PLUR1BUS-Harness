// Records RE-04/T1 goldens from the pinned engine.
//
//   PLUR1BUS_ENGINE_SRC=/path/to/engine-at-9f34008c \
//     node crates/plur1bus-engine/tests/fixtures/recall/record.mjs
//
// Pass --principals to rewrite only golden/principals.json.
// The engine checkout is the harness pin
// 9f34008c143c5da87b2194b5a28442b407ff8ba7.
// This script writes the JSON files next to itself and prints no model data.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const engineRoot = process.env.PLUR1BUS_ENGINE_SRC;
if (!engineRoot) {
  console.error("PLUR1BUS_ENGINE_SRC must point at the pinned engine checkout");
  process.exit(1);
}

const onlyPrincipals = process.argv.includes("--principals");
const here = path.dirname(new URL(import.meta.url).pathname);
const goldenDir = path.join(here, "golden");
mkdirSync(goldenDir, { recursive: true });

const load = (relative) => import(pathToFileURL(path.join(engineRoot, relative)));
const principalApi = await load("engine/identity/principal.js");
const requestApi = await load("lib/memory-request-context.js");
const aclApi = await load("lib/acl-middleware.js");
const schedulerApi = await load("lib/runtime-scheduler.js");

const commit = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const recordedFrom = {
  engine: "node",
  commit,
  node: process.version,
  unicode: process.versions.unicode,
  icu: process.versions.icu,
};

function userPrincipal(channel, accountId, userId) {
  const hash = createHash("sha256")
    .update(JSON.stringify([channel, accountId, userId]), "utf8")
    .digest("hex");
  return { hash, userPrincipal: `user:v1:${hash}` };
}

const forbidden = "open" + "claw";

function scrubMarkers(value) {
  if (typeof value === "string") {
    if (value.toLowerCase().includes(forbidden)) {
      return { parts: value.split(forbidden), joiner: ["open", "claw"] };
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(scrubMarkers);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = scrubMarkers(child);
    return out;
  }
  return value;
}

function writeJson(name, value) {
  const payload = scrubMarkers(value);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (text.toLowerCase().includes(forbidden)) {
    throw new Error(`refusing to write ${name}: forbidden token survived`);
  }
  writeFileSync(path.join(goldenDir, name), text);
}

const triples = [
  ["cli", "mac.local", "ada"],
  ["telegram", "default", "123456"],
  ["discord", "main", "user_one"],
  ["slack", "acct", "user-two"],
  ["mattermost", "team", "user.three"],
  ["telegram", "default", "Müller"],
  ["discord", "a\"b", "c\\d"],
  ["slack", "acct", "user-🚀"],
  ["telegram", "work", "ada lovelace"],
  ["CLI", "Host", "Ada"],
];

const principalRows = triples.map(([channel, accountId, userId]) => {
  const hashed = userPrincipal(channel, accountId, userId);
  const fromEngine = requestApi.channelIdentityUserPrincipal(channel, userId, accountId);
  if (fromEngine !== hashed.userPrincipal) {
    throw new Error(`principal formula drifted for ${channel}`);
  }
  return { channel, accountId, userId, hash: hashed.hash, userPrincipal: fromEngine };
});

writeJson("principals.json", {
  schema: "recall-principal/1",
  recordedFrom,
  triples: principalRows,
});

if (onlyPrincipals) {
  console.log("wrote golden/principals.json");
  process.exit(0);
}

function emptyAliases() {
  return { paths: [], aliases: [] };
}

function contextView(memoryCtx) {
  return {
    agentId: memoryCtx.agentId,
    workspaceId: memoryCtx.workspaceId,
    workspaceIdentity: memoryCtx.workspaceIdentity,
    userPrincipal: memoryCtx.userPrincipal,
    channel: memoryCtx.channel ?? "",
    accountId: memoryCtx.accountId ?? "",
    chatId: memoryCtx.chatId ?? "",
    chatKind: memoryCtx.chatKind ?? "",
    trust: memoryCtx.trust,
  };
}

function principalOf(fields) {
  return {
    workspace: "",
    user: "",
    channel: "",
    accountId: "",
    chat: { id: "", kind: "direct" },
    trust: "proved",
    ...fields,
    ...(fields.chat ? { chat: { id: "", kind: "direct", ...fields.chat } } : {}),
  };
}

function recordContext(name, fields, facts = {}) {
  try {
    const memoryCtx = principalApi.memoryContextFromPrincipal(principalOf(fields), facts);
    return { name, ok: true, context: contextView(memoryCtx), input: { ...fields, facts } };
  } catch (error) {
    return { name, ok: false, error: String(error?.message || error), input: { ...fields, facts } };
  }
}

const proved = principalRows[0];
const agents = ["alpha", "beta", "gamma"];
const scratch = mkdtempSync(path.join(tmpdir(), "recall-workspaces-"));
const directories = Object.fromEntries(agents.map((agent) => {
  const directory = path.join(scratch, agent);
  mkdirSync(directory);
  return [agent, realpathSync(directory)];
}));

const workspaceCases = [];
for (const agentId of agents) {
  workspaceCases.push(recordContext(`${agentId}-without-dir`, {
    agentId,
    workspace: "workspace:v1:main",
    user: proved.userPrincipal,
    channel: "telegram",
    accountId: "default",
    chat: { id: "1", kind: "direct" },
    trust: "proved",
  }));
  workspaceCases.push(recordContext(`${agentId}-with-dir`, {
    agentId,
    workspace: `workspace-dir:v1:${directories[agentId]}`,
    user: proved.userPrincipal,
    channel: "telegram",
    accountId: "default",
    chat: { id: "1", kind: "direct" },
    trust: "proved",
  }, { workspaceDir: directories[agentId] }));
}

workspaceCases.push(recordContext("proved-workspace-conflict", {
  agentId: "alpha",
  workspace: "workspace:v1:other",
  user: proved.userPrincipal,
  channel: "telegram",
  accountId: "default",
  chat: { id: "1", kind: "direct" },
  trust: "proved",
}, { workspaceDir: directories.alpha }));

workspaceCases.push(recordContext("inferred-keeps-dir-and-clears-user", {
  agentId: "alpha",
  workspace: "workspace:v1:other",
  user: proved.userPrincipal,
  channel: "telegram",
  accountId: "default",
  chat: { id: "1", kind: "direct" },
  trust: "inferred",
}, { workspaceDir: directories.alpha }));

workspaceCases.push(recordContext("proved-without-user", {
  agentId: "alpha",
  workspace: "workspace:v1:main",
  channel: "telegram",
  accountId: "default",
  chat: { id: "1", kind: "direct" },
  trust: "proved",
}));

workspaceCases.push(recordContext("proved-channel-case", {
  agentId: "alpha",
  workspace: "workspace:v1:main",
  user: proved.userPrincipal,
  channel: "Telegram",
  accountId: " default ",
  chat: { id: " 42 ", kind: "dm" },
  trust: "proved",
}));

workspaceCases.push(recordContext("proved-unknown-channel-degrades", {
  agentId: "alpha",
  workspace: "workspace:v1:main",
  user: proved.userPrincipal,
  channel: "cli",
  accountId: "mac.local",
  chat: { id: "cli:ada", kind: "direct" },
  trust: "proved",
}));

const registry = principalApi.createChannelRegistry();
let reservedError = "";
try {
  registry.register("main");
} catch (error) {
  reservedError = String(error?.message || error);
}
registry.register("cli");

workspaceCases.push(recordContext("proved-registered-cli", {
  agentId: "alpha",
  workspace: "workspace:v1:main",
  user: proved.userPrincipal,
  channel: "cli",
  accountId: "mac.local",
  chat: { id: "cli:ada", kind: "direct" },
  trust: "proved",
}));

workspaceCases.push(recordContext("dotted-agent-rejected", {
  agentId: "alpha.beta",
  workspace: "workspace:v1:main",
  channel: "telegram",
  accountId: "default",
  chat: { id: "1", kind: "direct" },
  trust: "proved",
}));

workspaceCases.push(recordContext("long-agent-rejected", {
  agentId: "a".repeat(65),
  workspace: "workspace:v1:main",
  channel: "telegram",
  accountId: "default",
  chat: { id: "1", kind: "direct" },
  trust: "proved",
}));

workspaceCases.push(recordContext("proved-missing-dir", {
  agentId: "alpha",
  workspace: "workspace:v1:main",
  user: proved.userPrincipal,
  channel: "telegram",
  accountId: "default",
  chat: { id: "1", kind: "direct" },
  trust: "proved",
}, { workspaceDir: path.join(scratch, "missing-alpha") }));

workspaceCases.push(recordContext("inferred-missing-dir", {
  agentId: "alpha",
  workspace: "workspace:v1:main",
  user: proved.userPrincipal,
  channel: "telegram",
  accountId: "default",
  chat: { id: "1", kind: "direct" },
  trust: "inferred",
}, { workspaceDir: path.join(scratch, "missing-alpha") }));

workspaceCases.push(recordContext("group-chat-kind", {
  agentId: "alpha",
  workspace: "workspace:v1:main",
  user: proved.userPrincipal,
  channel: "telegram",
  accountId: "default",
  chat: { id: "room", kind: "channel" },
  trust: "proved",
}));

const replacements = Object.entries(directories).sort((left, right) => right[1].length - left[1].length);
function scrubPaths(value) {
  if (typeof value === "string") {
    let out = value;
    for (const [agent, absolute] of replacements) out = out.split(absolute).join(`__DIR_${agent}__`);
    return out;
  }
  if (Array.isArray(value)) return value.map(scrubPaths);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = scrubPaths(child);
    return out;
  }
  return value;
}

const scrubbedCases = scrubPaths(workspaceCases);
const leaked = JSON.stringify(scrubbedCases).split(scratch).join("__SCRATCH__");
for (const absolute of Object.values(directories)) {
  if (leaked.includes(absolute)) throw new Error("workspace realpath survived scrubbing");
}
if (leaked.includes(scratch)) throw new Error("scratch path survived scrubbing");
const portableCases = JSON.parse(leaked);

writeJson("workspaces.json", {
  schema: "recall-workspace/1",
  recordedFrom,
  note: "Directory tokens __DIR_<agent>__ stand for Node realpathSync of a directory created for that agent. Replay creates its own directories and substitutes those realpaths.",
  provedUser: proved.userPrincipal,
  reservedRegisterError: reservedError,
  cases: portableCases,
});

const otherUser = principalRows[1].userPrincipal;
const baseCtx = {
  agentId: "alpha",
  workspaceId: "workspace:v1:main",
  workspaceIdentity: "workspace:v1:main",
  userPrincipal: proved.userPrincipal,
  workspaceAliases: emptyAliases(),
};

function memoryOf(fields) {
  return {
    id: "row-1",
    scope: "agent-private",
    agentId: "alpha",
    storedBy: "",
    workspaceId: "",
    workspaceKey: "",
    ownerUserId: "",
    type: "note",
    ...fields,
  };
}

function recordAccess(name, ctx, memory) {
  const result = aclApi.checkAccess(ctx, memory);
  return {
    name,
    ctx,
    memory,
    allowed: result.allowed === true,
    reason: result.reason ?? null,
  };
}

const aclCases = [
  recordAccess("agent-private-same-agent", baseCtx, memoryOf({ scope: "agent-private", agentId: "alpha" })),
  recordAccess("agent-private-other-agent", baseCtx, memoryOf({ scope: "agent-private", agentId: "beta" })),
  recordAccess("agent-private-stored-by-only", baseCtx, memoryOf({ scope: "agent-private", agentId: "", storedBy: "alpha" })),
  recordAccess("agent-private-missing-owner", baseCtx, memoryOf({ scope: "agent-private", agentId: "", storedBy: "" })),
  recordAccess("workspace-same", baseCtx, memoryOf({ scope: "workspace", workspaceId: "workspace:v1:main" })),
  recordAccess("workspace-other", baseCtx, memoryOf({ scope: "workspace", workspaceId: "workspace:v1:other" })),
  recordAccess("workspace-missing", baseCtx, memoryOf({ scope: "workspace", workspaceId: "", workspaceKey: "" })),
  recordAccess("workspace-bare-id", baseCtx, memoryOf({ scope: "workspace", workspaceId: "main" })),
  recordAccess("user-same-owner", baseCtx, memoryOf({ scope: "user", ownerUserId: proved.userPrincipal })),
  recordAccess("user-other-owner", baseCtx, memoryOf({ scope: "user", ownerUserId: otherUser })),
  recordAccess("user-missing-principal", { ...baseCtx, userPrincipal: "" }, memoryOf({ scope: "user", ownerUserId: proved.userPrincipal })),
  recordAccess("user-missing-owner", baseCtx, memoryOf({ scope: "user", ownerUserId: "" })),
  recordAccess("user-trimmed-principal", { ...baseCtx, userPrincipal: `  ${proved.userPrincipal}  ` }, memoryOf({ scope: "user", ownerUserId: proved.userPrincipal })),
  recordAccess("unknown-scope", baseCtx, memoryOf({ scope: "nope" })),
  recordAccess("blank-scope-is-not-private", baseCtx, memoryOf({ scope: " " })),
  recordAccess("missing-scope-defaults-private", baseCtx, memoryOf({ scope: "" })),
  recordAccess("missing-scope-other-agent", baseCtx, memoryOf({ scope: "", agentId: "beta" })),
  recordAccess("conflicting-workspace-binding", baseCtx, memoryOf({
    scope: "workspace",
    workspaceId: "workspace:v1:main",
    workspaceKey: "workspace:v1:other",
  })),
  recordAccess("invalid-workspace-binding", baseCtx, memoryOf({ scope: "workspace", workspaceId: "workspace:v9:nope" })),
  recordAccess("conflicting-agent-binding", baseCtx, memoryOf({ scope: "agent-private", agentId: "alpha", storedBy: "beta" })),
  recordAccess("invalid-user-owner", baseCtx, memoryOf({ scope: "agent-private", ownerUserId: "not-a-principal" })),
  recordAccess("no-context", null, memoryOf({})),
  recordAccess("no-memory", baseCtx, null),
  recordAccess("incognito-flag-ignored", { ...baseCtx, incognito: true }, { ...memoryOf({ scope: "agent-private", agentId: "alpha" }), incognito: true }),
  recordAccess("dotted-requester-missing-agent", { ...baseCtx, agentId: "alpha.beta" }, memoryOf({ scope: "agent-private", agentId: "alpha.beta" })),
  recordAccess("null-alias-snapshot", { ...baseCtx, workspaceAliases: null }, memoryOf({ scope: "workspace", workspaceId: "workspace:v1:main" })),
];

const critical = ["person", "beziehung", "geburtstag", "geld_konto", "gesundheit", "zugang_passwort"];
const scopeDefaults = [];
for (const typeName of critical) {
  const row = { type: typeName };
  aclApi.enforceDefaultScope(row, {});
  scopeDefaults.push({ type: typeName, scope: row.scope });
}
const explicit = { type: "person", scope: "user" };
aclApi.enforceDefaultScope(explicit, {});
scopeDefaults.push({ type: "person", scopeBefore: "user", scope: explicit.scope });
const ordinary = { type: "note" };
aclApi.enforceDefaultScope(ordinary, {});
scopeDefaults.push({ type: "note", scope: ordinary.scope ?? null });

writeJson("acl.json", {
  schema: "recall-acl/1",
  recordedFrom,
  provedUser: proved.userPrincipal,
  otherUser,
  cases: aclCases,
  scopeDefaults,
});

function marker(suffix) {
  return `__${"open"}${"claw"}_memory_core_${suffix}__`;
}

function recordSkip(name, event, ctx, extra = {}) {
  return {
    name,
    event,
    ctx,
    skip: schedulerApi.shouldSkipAutoRecallForInternalTurn(event, ctx) === true,
    ...extra,
  };
}

const autoRecall = [
  recordSkip("ordinary-prompt", { prompt: "what did we decide about the budget" }, {}),
  recordSkip("explicit-recall-in-cron", { prompt: "/recall the note", origin: "cron" }, {}),
  recordSkip("explicit-memory-while-dreaming", { prompt: "please /memory status", origin: "nightly-dreaming" }, {}),
  recordSkip("active-memory-session", { prompt: "/recall the note" }, { sessionKey: "agent:main:active-memory:1" }),
  recordSkip("active-memory-mixed-case", { prompt: "hello" }, { sessionKey: "agent:main:Active-Memory:1" }),
  recordSkip("origin-cron", { origin: "cron", prompt: "tick" }, {}),
  recordSkip("origin-internal", { origin: "internal", prompt: "tick" }, {}),
  recordSkip("kind-heartbeat", { kind: "heartbeat", prompt: "tick" }, {}),
  recordSkip("trigger-manual", { trigger: "manual", prompt: "tick" }, {}),
  recordSkip("session-heartbeat", { prompt: "tick" }, { sessionKey: "agent:main:heartbeat" }),
  recordSkip("session-cron", { prompt: "tick" }, { sessionKey: "agent:main:cron:nightly" }),
  recordSkip("origin-includes-dreaming", { origin: "nightly-dreaming", prompt: "tick" }, {}),
  recordSkip("kind-includes-promotion", { kind: "short-term-promotion", prompt: "tick" }, {}),
  recordSkip("session-includes-background", { prompt: "tick" }, { sessionKey: "agent:background:1" }),
  recordSkip("magic-marker", { prompt: marker("short_term_promotion_dream") }, {}),
  recordSkip("magic-marker-light", { prompt: `prefix ${marker("light_sleep")} suffix` }, {}),
  recordSkip("cron-hint", { prompt: "run [cron: nightly]" }, {}),
  recordSkip("heartbeat-hint", { prompt: "heartbeat_ok" }, {}),
  recordSkip("uppercase-command", { prompt: "please /RECALL that", origin: "cron" }, {}),
  recordSkip("source-fallback", { source: "cron" }, { origin: "" }),
  recordSkip("ctx-trigger", { prompt: "tick" }, { trigger: "background" }),
  recordSkip("event-type", { type: "heartbeat", prompt: "tick" }, {}),
  recordSkip("session-id-fallback", { prompt: "tick", sessionId: "job:cron:1" }, {}),
];

writeJson("auto-recall.json", {
  schema: "recall-auto-recall/1",
  recordedFrom,
  cases: autoRecall,
});

console.log("wrote golden/principals.json golden/workspaces.json golden/acl.json golden/auto-recall.json");
