import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaults, type HarnessConfig } from "@plur1bus/config-schema";
import { buildChannelSurface, looksLikeSecretValue, looksLikeToken, scrub, TEST_MESSAGE, type ChannelRegistryView, type ChannelSurfaceDeps } from "../../src/rpc/channel-surface.ts";
import { guardMethods, RPC_RULES, type PrincipalResolver } from "../../src/rbac/guard.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import type { CallContext, Handler } from "../../src/rpc/server.ts";
import type { ChannelStatus } from "../../src/channels/registry.ts";
import type { ChannelManifest } from "../../src/channels/manifest.ts";
import type { ChannelHealth, OutboundMessage } from "../../src/channels/types.ts";
import type { IdentityService } from "../../src/identity/service.ts";

const schema = JSON.parse(readFileSync(new URL("../../../rpc-schema/schema/rpc.schema.json", import.meta.url), "utf8"));
const METHODS = ["channel.list", "channel.get", "channel.enable", "channel.disable", "channel.set", "channel.test", "channel.status"];
// The channel ids the config schema declares, derived so a newly hosted channel needs no fixture edit.
const SCHEMA_CHANNELS = Object.keys(defaults().channels).sort();
// A channel a switchboard could register that the config schema does not declare.
const UNSCHEMAED = "irc";
const OWNER = { userId: "local-owner", role: "owner", kind: "person" } as const;
// A credential-shaped string built at runtime so no secret scanner sees a literal token in the repository.
const TOKEN = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
const LONG_VALUE = ["Zk3", "pQ9vL2mX7", "cR5tY8wB1nA4dF6g", "H2jK8sN4"].join("");

class FakeRegistry implements ChannelRegistryView {
  statuses = new Map<string, ChannelStatus>();
  manifests = new Map<string, ChannelManifest>();
  health = new Map<string, ChannelHealth>();
  sent: { name: string; msg: OutboundMessage }[] = [];
  sendFails = false;
  list() { return [...this.statuses.values()]; }
  status(name: string) { return this.statuses.get(name); }
  manifestOf(name: string) { return this.manifests.get(name); }
  async probe(name: string) { return this.statuses.has(name) ? (this.statuses.get(name)!.state === "running" ? this.health.get(name) ?? { ok: true } : { ok: false, detail: "not running" }) : undefined; }
  async sendTo(name: string, msg: OutboundMessage) {
    if (this.statuses.get(name)?.state !== "running") return false;
    if (this.sendFails) throw new Error(`send failed with ${TOKEN}`);
    this.sent.push({ name, msg });
    return true;
  }
  add(name: string, state: ChannelStatus["state"], extra: Partial<ChannelStatus> = {}, manifest: Partial<ChannelManifest> = {}) {
    this.statuses.set(name, { name, version: "0.1.0", state, attempts: 0, ...extra });
    this.manifests.set(name, { name, version: "0.1.0", kind: "channel", apiVersion: "1", chatKinds: ["direct"], startDelayMs: 0, maxRestarts: 8, ...manifest });
  }
}

function setup(o: { stored?: string[]; writable?: boolean; registry?: boolean; links?: { id: string; channel: string; userId: string; revokedAt: number | null }[]; config?: (c: any) => void } = {}) {
  let config = defaults() as HarnessConfig;
  if (o.config) o.config(config);
  const registry = new FakeRegistry();
  const sets: { key: string; value: unknown }[][] = [];
  const audit: any[] = [];
  const state = { stored: o.stored ?? [], writable: o.writable ?? true, refuse: false };
  const source = {
    current: () => config,
    set(changes: { key: string; value: unknown }[]) {
      if (!state.writable) return null;
      if (state.refuse) return Promise.reject(new Error("nope"));
      sets.push(changes);
      const next = structuredClone(config) as any;
      for (const c of changes) { const path = c.key.split("."); let cur = next; for (const s of path.slice(0, -1)) cur = cur[s] ??= {}; cur[path.at(-1)!] = c.value; }
      config = next;
      return Promise.resolve();
    },
  };
  const identity = { list: () => ({ humans: [{ id: "local-owner", displayName: "o", createdAt: 0, identities: (o.links ?? []).map((l) => ({ ...l, humanId: "local-owner", accountId: "bot" })) }, { id: "other", displayName: "x", createdAt: 0, identities: [{ id: "l-other", humanId: "other", channel: "discord", accountId: "bot", userId: "999", revokedAt: null }] }], pairings: [] }) } as unknown as IdentityService;
  const deps: ChannelSurfaceDeps = {
    config: () => config, source, identity: () => identity, clock: () => 1,
    secrets: { list: async () => state.stored.map((name) => ({ name })) },
    registry: () => (o.registry === false ? null : registry),
    audit: { append: (e: unknown) => { audit.push(e); } } as never,
  };
  const raw = buildChannelSurface(deps);
  const resolve = (p: Parameters<PrincipalResolver>[0] extends never ? never : any = OWNER): PrincipalResolver => () => p;
  const guard = (principal: any = OWNER) => guardMethods(raw, { resolve: resolve(principal), now: () => 1 });
  const ctx = (): CallContext => ({ requestId: "r", connectionId: "c", signal: new AbortController().signal });
  const methods = guard();
  const call = (m: string, p: unknown = {}) => methods[m]!(p, ctx()) as Promise<any>;
  const refusal = async (m: string, p: unknown = {}) => call(m, p).then(() => assert.fail("expected a refusal"), (e: unknown) => { assert.ok(e instanceof RpcError, String(e)); return { error: e.error, reason: e.reason, message: e.message, detail: e.detail }; });
  return { registry, sets, audit, state, source, config: () => config, raw, guard, ctx, call, refusal };
}

test("the channel surface declares exactly the seven schema methods, all core and closed", () => {
  const names = Object.keys(buildChannelSurface({} as ChannelSurfaceDeps)).sort();
  assert.deepEqual(names, [...METHODS].sort());
  for (const n of names) {
    assert.equal(schema.$defs.methods[n]["x-server"], "core");
    assert.equal(schema.$defs.methods[n].params.additionalProperties, false);
    assert.ok(RPC_RULES[n], n);
  }
});

test("list: every schema channel, disabled and unconfigured by default, not-registered without a switchboard", async () => {
  const s = setup({ registry: false });
  const r = await s.call("channel.list");
  assert.equal(r.host, false);
  assert.deepEqual(r.channels.map((c: any) => c.id), SCHEMA_CHANNELS);
  assert.ok(SCHEMA_CHANNELS.includes("telegram"));
  for (const c of r.channels) assert.equal(c.enabled, false);
  const discord = r.channels.find((c: any) => c.id === "discord");
  assert.deepEqual(discord, { id: "discord", displayName: "Discord", enabled: false, configured: false, state: "not-registered", health: "unknown" });
});

test("list: configured follows the stored secrets; running and failing channels show their state; a registered-only channel is listed", async () => {
  const s = setup({ stored: ["channels.discord.token"] });
  s.registry.add("discord", "running", {}, { displayName: "Discord (switchboard)" });
  s.registry.add("slack", "backoff", { attempts: 2, lastError: "boom" });
  s.registry.add(UNSCHEMAED, "stopped");
  await s.call("channel.enable", { id: "discord" });
  const r = await s.call("channel.list");
  const by = Object.fromEntries(r.channels.map((c: any) => [c.id, c]));
  assert.deepEqual(by.discord, { id: "discord", displayName: "Discord (switchboard)", enabled: true, configured: true, state: "running", health: "ok" });
  assert.equal(by.slack.configured, false);
  assert.equal(by.slack.health, "failing");
  assert.equal(by[UNSCHEMAED].configured, false); // no configuration here
  assert.equal(by[UNSCHEMAED].state, "stopped");
  assert.equal(r.host, true);
});

test("get: secrets are names with a presence flag, restart class, link help; unknown id is not found", async () => {
  const s = setup({ stored: [] });
  const r = await s.call("channel.get", { id: "discord" });
  assert.deepEqual(r.secrets, [{ key: "tokenSecret", name: "channels.discord.token", present: false }]);
  assert.deepEqual(r.config.tokenSecret, { secret: "channels.discord.token", present: false });
  assert.deepEqual(r.missing, ["secret:channels.discord.token"]);
  assert.equal(r.restart, "module:discord");
  assert.equal(r.configured, false);
  assert.match(r.linkHelp, /\/link/);
  assert.match(r.linkHelp, /plur1bus identity link --channel discord/);
  assert.equal(r.probe, undefined);
  const email = await s.call("channel.get", { id: "email" });
  assert.deepEqual(email.secrets.map((x: any) => x.key).sort(), ["imap.passwordSecret", "smtp.passwordSecret"]);
  assert.deepEqual(await s.refusal("channel.get", { id: "nosuch" }), { error: "E_NOT_FOUND", reason: "unknown-channel", message: "unknown channel", detail: undefined });
  assert.equal((await s.refusal("channel.get", { id: "../x" })).reason, "invalid-id");
});

test("get: a running channel is probed; a failing probe and a last error (scrubbed) are reported; the manifest's link help wins", async () => {
  const s = setup({ stored: ["channels.discord.token"] });
  s.registry.add("discord", "running", { lastError: `login failed for ${TOKEN}`, startedAt: 5 }, { linkHelp: "DM the bot /link CODE.", chatKinds: ["direct", "group"] });
  s.registry.health.set("discord", { ok: false, detail: `gateway closed (${TOKEN})` });
  const r = await s.call("channel.get", { id: "discord" });
  assert.deepEqual(r.probe, { ok: false, detail: "gateway closed ([redacted])" });
  assert.equal(r.lastError, "login failed for [redacted]");
  assert.equal(r.linkHelp, "DM the bot /link CODE.");
  assert.deepEqual(r.chatKinds, ["direct", "group"]);
  assert.equal(r.startedAt, 5);
  assert.equal(JSON.stringify(r).includes(TOKEN), false);
});

test("status: compact rows for every channel; last errors scrubbed", async () => {
  const s = setup();
  s.registry.add("slack", "failed", { lastError: `bad ${TOKEN}` });
  const r = await s.call("channel.status");
  assert.equal(r.host, true);
  assert.equal(r.channels.length, SCHEMA_CHANNELS.length);
  assert.deepEqual(r.channels.find((c: any) => c.id === "slack"), { id: "slack", enabled: false, state: "failed", health: "failing", lastError: "bad [redacted]" });
  assert.equal(JSON.stringify(r).includes(TOKEN), false);
});

test("enable / disable write channels.<id>.enabled through the config source and report the module restart", async () => {
  const s = setup();
  const on = await s.call("channel.enable", { id: "discord" });
  assert.deepEqual(on, { id: "discord", enabled: true, changed: true, restart: { live: [], core: false, modules: ["discord"] }, missing: ["secret:channels.discord.token"] });
  assert.deepEqual(s.sets, [[{ key: "channels.discord.enabled", value: true }]]);
  assert.equal((s.config() as any).channels.discord.enabled, true);
  assert.deepEqual((await s.call("channel.enable", { id: "discord" })).changed, false);
  assert.equal(s.sets.length, 1);
  const off = await s.call("channel.disable", { id: "discord" });
  assert.deepEqual(off, { id: "discord", enabled: false, changed: true, restart: { live: [], core: false, modules: ["discord"] }, missing: [] });
  assert.equal((await s.call("channel.disable", { id: "slack" })).changed, false);
  assert.deepEqual(s.audit.map((a) => [a.action, a.target]), [["channel.enable", "discord"], ["channel.disable", "discord"]]);
});

test("enable: no supervisor, a refused write, an unknown or unconfigurable channel", async () => {
  const s = setup({ writable: false });
  assert.deepEqual(await s.refusal("channel.enable", { id: "discord" }), { error: "E_NOT_AVAILABLE", reason: "config-not-writable", message: "the configuration cannot be changed without a supervisor", detail: undefined });
  const t = setup();
  t.state.refuse = true;
  assert.equal((await t.refusal("channel.enable", { id: "discord" })).error, "E_CONFIG_INVALID");
  assert.equal((await t.refusal("channel.enable", { id: "nosuch" })).reason, "unknown-channel");
  t.registry.add(UNSCHEMAED, "stopped");
  assert.equal((await t.refusal("channel.enable", { id: UNSCHEMAED })).reason, "not-configurable");
  assert.equal((await t.refusal("channel.set", { id: UNSCHEMAED, key: "x", text: "1" })).reason, "not-configurable");
});

test("set: validates against the schema, interprets text by type, reports the restart plan", async () => {
  const s = setup();
  const a = await s.call("channel.set", { id: "discord", key: "allowlist", text: "[\"123456789012345678\"]" });
  assert.deepEqual(a, { id: "discord", key: "allowlist", changed: true, restart: { live: [], core: false, modules: ["discord"] }, value: ["123456789012345678"] });
  // A numeric-looking string key stays a string; a 25-digit id never goes through a float.
  const id = "0000012345678901234567890";
  assert.equal((await s.call("channel.set", { id: "discord", key: "applicationId", text: id })).value, id);
  assert.equal((await s.call("channel.set", { id: "discord", key: "maxMediaBytes", text: "1048576" })).value, 1048576);
  assert.equal((await s.call("channel.set", { id: "discord", key: "locale", value: "de" })).value, "de");
  assert.equal((await s.call("channel.set", { id: "email", key: "imap.host", text: "imap.example.org" })).value, "imap.example.org");
  assert.equal((await s.call("channel.set", { id: "discord", key: "locale", text: "de" })).changed, false);
  assert.deepEqual(s.sets.at(-1), [{ key: "channels.email.imap.host", value: "imap.example.org" }]);
});

test("set: refusals are specific and never echo the submitted value", async () => {
  const s = setup();
  const bad = async (p: any) => s.refusal("channel.set", { id: "discord", ...p });
  assert.equal((await bad({ key: "locale", text: "xx" })).reason, "invalid-value");
  assert.match(String((await bad({ key: "locale", text: "xx" })).detail), /\/channels\/discord\/locale/);
  assert.equal((await bad({ key: "maxMediaBytes", text: "lots" })).reason, "invalid-value");
  assert.equal((await bad({ key: "maxMediaBytes", text: "0" })).reason, "invalid-value");
  assert.equal((await bad({ key: "enabled", text: "yes" })).reason, "invalid-value");
  assert.equal((await bad({ key: "intents", text: "[not json" })).reason, "invalid-value");
  assert.equal((await bad({ key: "nope", text: "1" })).reason, "unknown-key");
  assert.equal((await bad({ key: "tokenSecret.deep", text: "1" })).reason, "unknown-key");
  assert.equal((await bad({ key: "__proto__", text: "1" })).reason, "invalid-key");
  assert.equal((await bad({ key: "constructor.prototype", text: "1" })).reason, "unknown-key");
  assert.equal((await bad({ key: "a b", text: "1" })).reason, "invalid-key");
  assert.equal((await bad({ key: "locale" })).reason, "value-required");
  assert.equal((await bad({ key: "locale", text: "de", value: "de" })).reason, "value-required");
  assert.equal(s.sets.length, 0);
});

test("set: a *Secret key takes a name; credential-shaped values are refused without being echoed, stored or audited", async () => {
  const s = setup({ stored: ["my.discord.token"] });
  for (const v of [TOKEN, LONG_VALUE, "x".repeat(70), "123456789:" + "A".repeat(35)]) {
    const e = await s.refusal("channel.set", { id: "discord", key: "tokenSecret", text: v });
    assert.equal(e.reason, "secret-value");
    assert.equal(JSON.stringify(e).includes(v), false);
    const f = await s.refusal("channel.set", { id: "discord", key: "tokenSecret", value: v });
    assert.equal(f.reason, "secret-value");
  }
  assert.equal((await s.refusal("channel.set", { id: "discord", key: "tokenSecret", value: 5 })).reason, "secret-value");
  assert.equal((await s.refusal("channel.set", { id: "slack", key: "botTokenSecret", text: "" })).reason, "invalid-value");
  // A token in an ordinary string key is refused too.
  assert.equal((await s.refusal("channel.set", { id: "email", key: "imap.user", text: TOKEN })).reason, "secret-value");
  assert.equal(s.sets.length, 0);
  assert.equal(JSON.stringify(s.audit).includes(TOKEN), false);
  const ok = await s.call("channel.set", { id: "discord", key: "tokenSecret", text: "my.discord.token" });
  assert.deepEqual(ok, { id: "discord", key: "tokenSecret", changed: true, restart: { live: [], core: false, modules: ["discord"] }, secret: { name: "my.discord.token", present: true } });
  assert.equal("value" in ok, false);
  // A name for a secret that is not stored yet is accepted and flagged.
  assert.equal((await s.call("channel.set", { id: "slack", key: "botTokenSecret", text: "later.name" })).secret.present, false);
});

test("set: a *Secret key takes only a name in the schema's format; other text is refused before any write and never echoed", async () => {
  const s = setup({ stored: ["my.discord.token"] });
  // The config schema's `pattern` on every *Secret key is the name rule. A space is outside it and passes the credential
  // heuristic, so the schema is what refuses it here.
  const text = "not a name";
  for (const [id, key] of [["discord", "tokenSecret"], ["email", "imap.passwordSecret"]] as const) {
    const e = await s.refusal("channel.set", { id, key, text });
    assert.equal(e.reason, "invalid-value");
    assert.equal(JSON.stringify(e).includes(text), false);
  }
  assert.equal(s.sets.length, 0);
  assert.equal(JSON.stringify(s.audit).includes(text), false);
  // Empty text is refused by the same schema rule.
  assert.equal((await s.refusal("channel.set", { id: "discord", key: "tokenSecret", text: "" })).reason, "invalid-value");
});

test("secret heuristics", () => {
  for (const v of [TOKEN, "sk-" + "a".repeat(20), "ghp_" + "b".repeat(30), "eyJ" + "c".repeat(30), "123456789:" + "D".repeat(30)]) assert.ok(looksLikeToken(v), v);
  for (const v of ["channels.discord.token", "channels.slack.bot-token", "my/secret", "x"]) assert.equal(looksLikeSecretValue(v), false, v);
  assert.ok(looksLikeSecretValue(LONG_VALUE));
  assert.equal(scrub(`a ${TOKEN} b\n\nc`), "a [redacted] b c");
  assert.equal(scrub("e".repeat(500)).length, 301);
});

test("test: health only, health failure, and --send-owner variants", async () => {
  const s = setup({ links: [{ id: "link-1", channel: "discord", userId: "4242", revokedAt: null }, { id: "link-0", channel: "discord", userId: "old", revokedAt: 1 }, { id: "link-s", channel: "slack", userId: "U1", revokedAt: null }] });
  assert.deepEqual(await s.call("channel.test", { id: "discord" }), { id: "discord", ok: false, state: "not-registered", detail: "not registered", sent: false });
  const noHost = setup({ registry: false });
  assert.deepEqual(await noHost.call("channel.test", { id: "discord" }), { id: "discord", ok: false, state: "not-registered", detail: "no switchboard host", sent: false });

  s.registry.add("discord", "running");
  assert.deepEqual(await s.call("channel.test", { id: "discord" }), { id: "discord", ok: true, state: "running", sent: false });
  s.registry.health.set("discord", { ok: false, detail: "gateway down" });
  assert.deepEqual(await s.call("channel.test", { id: "discord" }), { id: "discord", ok: false, state: "running", detail: "gateway down", sent: false });
  assert.deepEqual(s.registry.sent, []);

  s.registry.health.delete("discord");
  const sent = await s.call("channel.test", { id: "discord", sendOwner: true });
  assert.deepEqual(sent, { id: "discord", ok: true, state: "running", sent: true, sentTo: { linkId: "link-1" } });
  assert.deepEqual(s.registry.sent, [{ name: "discord", msg: { chatId: "4242", text: TEST_MESSAGE } }]);
  assert.deepEqual(s.audit.map((a) => a.action), ["channel.test.send"]);
});

test("test --send-owner: only the owner's own active link; refuses when not running, not linked, or the send fails", async () => {
  const s = setup({ links: [{ id: "link-s", channel: "slack", userId: "U1", revokedAt: null }, { id: "link-r", channel: "discord", userId: "gone", revokedAt: 9 }] });
  assert.equal((await s.refusal("channel.test", { id: "discord", sendOwner: true })).reason, "channel-not-running");
  s.registry.add("discord", "running");
  // Another human's link on this channel (id 999) is never used; a revoked link of the owner is not used either.
  assert.deepEqual(await s.refusal("channel.test", { id: "discord", sendOwner: true }), { error: "E_NOT_FOUND", reason: "owner-not-linked", message: "you have no linked identity on this channel", detail: undefined });
  assert.deepEqual(s.registry.sent, []);
  const t = setup({ links: [{ id: "link-1", channel: "discord", userId: "4242", revokedAt: null }] });
  t.registry.add("discord", "running");
  t.registry.sendFails = true;
  const e = await t.refusal("channel.test", { id: "discord", sendOwner: true });
  assert.equal(e.reason, "send-failed");
  assert.equal(JSON.stringify(e).includes(TOKEN), false);
  // The caller cannot name a recipient: unknown params are not part of the method.
  assert.equal((await t.refusal("channel.test", { id: "discord", sendOwner: "yes" })).error, "E_INVALID_PARAMS");
});

test("test --send-owner needs channel.write even where the token scope only grants channel.read", async () => {
  const s = setup({ links: [{ id: "link-1", channel: "discord", userId: "4242", revokedAt: null }] });
  s.registry.add("discord", "running");
  const guarded = s.guard({ ...OWNER, tokenScopes: ["channel.read"] });
  assert.equal((await guarded["channel.test"]!({ id: "discord" }, s.ctx()) as any).sent, false);
  await assert.rejects(() => guarded["channel.test"]!({ id: "discord", sendOwner: true }, s.ctx()) as Promise<unknown>, { error: "E_DENIED", reason: "role-denied" });
  assert.deepEqual(s.registry.sent, []);
});

test("results of every method contain no secret value even when the registry carries one", async () => {
  const s = setup({ stored: ["channels.discord.token"], links: [{ id: "l", channel: "discord", userId: "1", revokedAt: null }] });
  s.registry.add("discord", "running", { lastError: TOKEN });
  s.registry.health.set("discord", { ok: false, detail: TOKEN });
  const seen = [
    await s.call("channel.list"), await s.call("channel.status"), await s.call("channel.get", { id: "discord" }),
    await s.call("channel.test", { id: "discord", sendOwner: true }), await s.call("channel.enable", { id: "discord" }), await s.call("channel.disable", { id: "discord" }),
    await s.call("channel.set", { id: "discord", key: "tokenSecret", text: "channels.discord.token" }), s.audit,
  ];
  assert.equal(JSON.stringify(seen).includes(TOKEN), false);
});

// --- RBAC: deny by default -------------------------------------------------------------------------------------

const PARAMS: Record<string, unknown> = {
  "channel.list": {}, "channel.status": {}, "channel.get": { id: "discord" }, "channel.test": { id: "discord" },
  "channel.enable": { id: "discord" }, "channel.disable": { id: "discord" }, "channel.set": { id: "discord", key: "locale", text: "de" },
};

test("RBAC: owner and admin pass, every other role is denied role-denied, and the handler never runs for a denial", async () => {
  for (const [role, allowed] of [["owner", true], ["admin", true], ["operator", false], ["member", false], ["viewer", false]] as const) {
    for (const m of METHODS) {
      let ran = false;
      const g = guardMethods({ [m]: (async () => { ran = true; return {}; }) as Handler }, { resolve: () => ({ userId: "u", role, kind: "person" }), now: () => 1 });
      const ctx: CallContext = { requestId: "r", connectionId: "c", signal: new AbortController().signal };
      if (allowed) { await g[m]!(PARAMS[m], ctx); assert.equal(ran, true, `${role} ${m}`); }
      else {
        await assert.rejects(() => g[m]!(PARAMS[m], ctx) as Promise<unknown>, { error: "E_DENIED", reason: "role-denied" }, `${role} ${m}`);
        assert.equal(ran, false, `${role} ${m}`);
      }
    }
  }
});

test("RBAC: agent principals (any role, any scope), unauthenticated and malformed principals never reach a handler", async () => {
  const ctx: CallContext = { requestId: "r", connectionId: "c", signal: new AbortController().signal };
  const principals: [string, any, string, string][] = [
    ["agent owner", { userId: "a", role: "owner", kind: "agent" }, "E_DENIED", "agent-principal"],
    ["agent with scope", { userId: "a", role: "owner", kind: "agent", tokenScopes: ["channel.*"] }, "E_DENIED", "agent-principal"],
    ["no principal", null, "E_UNAUTHORIZED", "no-principal"],
    ["bad role", { userId: "u", role: "root", kind: "person" }, "E_DENIED", "invalid-principal"],
    ["wrong scope", { userId: "u", role: "owner", kind: "person", tokenScopes: ["jobs.run"] }, "E_DENIED", "token-scope"],
  ];
  for (const [label, principal, error, reason] of principals) {
    for (const m of METHODS) {
      let ran = false;
      const g = guardMethods({ [m]: (async () => { ran = true; }) as Handler }, { resolve: () => principal, now: () => 1 });
      await assert.rejects(() => g[m]!(PARAMS[m], ctx) as Promise<unknown>, { error, reason }, `${label} ${m}`);
      assert.equal(ran, false, `${label} ${m}`);
    }
  }
});

test("RBAC: a handler called without the guard's principal refuses (no ambient authority)", async () => {
  const s = setup();
  for (const m of METHODS) await assert.rejects(() => s.raw[m]!(PARAMS[m], s.ctx()) as Promise<unknown>, { error: "E_UNAUTHORIZED" }, m);
});

test("RBAC: reads are read-class and writes write-class in the rule table", () => {
  const action = (m: string) => RPC_RULES[m]!.action;
  for (const m of ["channel.list", "channel.get", "channel.status", "channel.test"]) assert.equal(action(m), "channel.read", m);
  for (const m of ["channel.enable", "channel.disable", "channel.set"]) assert.equal(action(m), "channel.write", m);
});
