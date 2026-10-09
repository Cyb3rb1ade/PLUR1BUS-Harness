// RPC surface for channel management over the switchboard (R3): channel.list|get|enable|disable|set|test|status.
//
// Generic over the channel registry and the config schema's `channels.*` block: nothing here knows one channel from
// another. A channel is "known" when the schema describes `channels.<id>` or the registry holds it.
//
//  - Secrets: a `*Secret` key holds a secret NAME. Reads show the name and whether the store has it, never a value;
//    `channel.set` refuses anything that looks like a credential in a `*Secret` key (and a recognisable token in any key)
//    without echoing it. Error messages and results never contain a submitted value.
//  - Writes go through the config source (`config.set` on the supervisor), so the per-key restart class applies: the
//    result carries the restart plan (`module:<id>` for a channel key).
//  - `channel.test --send-owner` sends one fixed text to the caller's own linked identity on that channel, never to a
//    recipient named by the caller.
import { CONFIG_SCHEMA, restartClassOf, restartPlan, validate, type HarnessConfig } from "@plur1bus/config-schema";
import type { Handler, CallContext } from "./server.ts";
import { RpcError } from "./errors.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import { authorize } from "../rbac/authorize.ts";
import type { AuditSink } from "../rbac/audit.ts";
import type { IdentityService } from "../identity/service.ts";
import type { ChannelStatus } from "../channels/registry.ts";
import type { ChannelManifest } from "../channels/manifest.ts";
import type { ChannelHealth, OutboundMessage } from "../channels/types.ts";

/** What the surface needs of the registry (a `ChannelRegistry` satisfies it; tests use a fake). */
export interface ChannelRegistryView {
  list(): ChannelStatus[];
  status(name: string): ChannelStatus | undefined;
  manifestOf(name: string): ChannelManifest | undefined;
  probe(name: string): Promise<ChannelHealth | undefined>;
  sendTo(name: string, msg: OutboundMessage): Promise<boolean>;
}

export interface ChannelSurfaceDeps {
  config: () => HarnessConfig;
  /** The configuration source; `set` is null while the configuration is a plain file (no supervisor to write it). */
  source: { set(changes: { key: string; value: unknown }[]): Promise<void> | null; current(): HarnessConfig };
  /** The secret store, listed as the installation owner (metadata only). */
  secrets: { list(principal: { kind: "owner" }): Promise<ReadonlyArray<{ name: string }>> };
  identity: () => IdentityService | null;
  /** The running registry; null while the core hosts no switchboard (channels then show as `not-registered`). */
  registry: () => ChannelRegistryView | null;
  audit?: AuditSink;
  clock: () => number;
}

/** The fixed text `channel.test --send-owner` sends. Nothing the caller supplies is part of it. */
export const TEST_MESSAGE = "PLUR1BUS test message: this channel is connected. You can ignore it.";
const MAX_ERROR = 300;
const ID = /^[a-z][a-z0-9-]{1,31}$/;
const KEY = /^[A-Za-z][A-Za-z0-9]{0,63}(\.[A-Za-z][A-Za-z0-9]{0,63}){0,3}$/;
const SECRET_KEY = /Secret$/;
const MAX_TEXT = 8192;
type Schema = Record<string, any>;

// --- secrets ---------------------------------------------------------------------------------------------------

const TOKEN_PREFIX = /^(xox[abprs]-|xapp-|sk-|sk_|pk_|rk_|ghp_|gho_|ghs_|github_pat_|glpat-|AKIA[0-9A-Z]{8}|AIza|ya29\.|eyJ|syt_|mfa\.)/;
const TELEGRAM_TOKEN = /^[0-9]{6,}:[A-Za-z0-9_-]{20,}$/;
const DOTTED_TOKEN = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/;

/** Recognisable credentials, for any key. A heuristic: it refuses, it never promises to find every secret. */
export function looksLikeToken(v: string): boolean {
  return TOKEN_PREFIX.test(v) || TELEGRAM_TOKEN.test(v) || DOTTED_TOKEN.test(v);
}
/** A `*Secret` key takes a NAME (`channels.discord.token`); long separator-free mixed strings are values, not names. */
export function looksLikeSecretValue(v: string): boolean {
  if (looksLikeToken(v) || v.length > 64) return true;
  return v.length >= 32 && !/[./:@]/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v);
}
/** Masks recognisable tokens inside free text (a channel's last error) and bounds it. */
export function scrub(text: unknown): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  const masked = s
    .split(" ")
    .map((w) => { const core = w.replace(/^[("'`]+|[)"'`,.;:]+$/g, ""); return core && looksLikeToken(core) ? w.replace(core, "[redacted]") : w; })
    .join(" ");
  return masked.length > MAX_ERROR ? `${masked.slice(0, MAX_ERROR)}…` : masked;
}

// --- schema and config helpers ---------------------------------------------------------------------------------

const hasOwn = (o: unknown, k: string): boolean => typeof o === "object" && o !== null && Object.hasOwn(o, k);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function channelSchemas(): Schema {
  return (CONFIG_SCHEMA.properties?.channels?.properties ?? {}) as Schema;
}
function nodeAt(root: Schema, path: string[]): Schema | undefined {
  let node: Schema | undefined = root;
  for (const seg of path) {
    if (!node || !hasOwn(node.properties, seg)) return undefined;
    node = node.properties[seg];
  }
  return node;
}
function channelConfig(cfg: HarnessConfig, id: string): Record<string, unknown> {
  const all = (cfg as unknown as { channels?: Record<string, unknown> }).channels;
  const v = all && hasOwn(all, id) ? all[id] : undefined;
  return isObj(v) ? v : {};
}
interface SecretRef { key: string; name: string }
function secretRefs(cfg: Record<string, unknown>, prefix: string[] = []): SecretRef[] {
  const out: SecretRef[] = [];
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === "string" && SECRET_KEY.test(k)) out.push({ key: [...prefix, k].join("."), name: v });
    else if (isObj(v)) out.push(...secretRefs(v, [...prefix, k]));
  }
  return out;
}
/** The config with every `*Secret` leaf replaced by `{ secret: <name>, present }`; whatever else is configured is not secret by construction. */
function project(cfg: Record<string, unknown>, present: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === "string" && SECRET_KEY.test(k)) out[k] = { secret: v, present: present.has(v) };
    else if (isObj(v)) out[k] = project(v, present);
    else out[k] = structuredClone(v);
  }
  return out;
}
function displayNameOf(id: string, manifest?: ChannelManifest): string {
  return manifest?.displayName ?? id.charAt(0).toUpperCase() + id.slice(1);
}

const GENERIC_LINK_HELP = (id: string, name: string): string => [
  `Linking your ${name} account to your PLUR1BUS identity (pairing):`,
  `1. Make sure the channel is enabled and running: plur1bus channel enable ${id}, then plur1bus channel status.`,
  `2. Mint a one-time code for yourself: plur1bus identity link --channel ${id}. The code is shown once, is valid for a limited time and works once.`,
  `3. From your own ${name} account, send the code to the bot in a direct message as "/link <code>". Group chats never accept a code.`,
  `4. Approve the claim: plur1bus identity approve <pairing id> (see plur1bus identity links). Nothing is linked until you approve.`,
  `Until an account is linked the bot answers it with a pairing notice only; it never reaches an agent.`,
].join("\n");

function restartView(before: unknown, after: unknown) {
  const plan = restartPlan(before, after);
  return { live: plan.restart.live, core: plan.restart.core, modules: plan.restart.modules };
}

// --- value parsing ---------------------------------------------------------------------------------------------

type Parsed = { ok: true; value: unknown } | { ok: false; reason: string };
/** Interprets the CLI's raw text by the schema node's type, so "00123" stays a string and a 25-digit id is never a float. */
function parseText(text: string, node: Schema): Parsed {
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (type) {
    case "string": return { ok: true, value: text };
    case "boolean":
      return text === "true" ? { ok: true, value: true } : text === "false" ? { ok: true, value: false } : { ok: false, reason: "expected true or false" };
    case "integer":
    case "number": {
      if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false, reason: "expected a number" };
      const n = Number(text);
      return Number.isSafeInteger(n) || (type === "number" && Number.isFinite(n)) ? { ok: true, value: n } : { ok: false, reason: "expected a number in range" };
    }
    case "array":
    case "object":
      try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, reason: `expected JSON ${type}` }; }
    default:
      if (Array.isArray(node.enum)) return { ok: true, value: text };
      try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: true, value: text }; }
  }
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = target;
  for (const seg of path.slice(0, -1)) {
    const next = hasOwn(cur, seg) && isObj(cur[seg]) ? (cur[seg] as Record<string, unknown>) : (cur[seg] = {});
    cur = next as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}

function paramsOf(p: unknown): Record<string, unknown> {
  if (!isObj(p)) throw new RpcError("E_INVALID_PARAMS", "params must be an object");
  return p;
}
function idParam(p: unknown): string {
  const v = paramsOf(p).id;
  if (typeof v !== "string" || !ID.test(v)) throw new RpcError("E_INVALID_PARAMS", "invalid channel id", { reason: "invalid-id" });
  return v;
}

export function buildChannelSurface(d: ChannelSurfaceDeps): Record<string, Handler> {
  const knownIds = (): string[] => {
    const ids = new Set<string>(Object.keys(channelSchemas()));
    for (const s of d.registry()?.list() ?? []) ids.add(s.name);
    return [...ids].sort();
  };
  const requireKnown = (id: string): void => {
    if (!knownIds().includes(id)) throw new RpcError("E_NOT_FOUND", "unknown channel", { reason: "unknown-channel" });
  };
  const presentSecrets = async (): Promise<Set<string>> => {
    try { return new Set((await d.secrets.list({ kind: "owner" })).map((s) => s.name)); }
    catch { return new Set(); } // an unreadable store reads as "not present"; the value is never needed here
  };
  const audit = (who: string, action: string, target: string, detail: Record<string, unknown>): void => {
    try { d.audit?.append({ at: d.clock(), actor: { user: who, host: "rpc" }, action, target, detail }); } catch { /* the change stands */ }
  };

  interface Facts {
    id: string; displayName: string; configurable: boolean; enabled: boolean; missing: string[]; secrets: { key: string; name: string; present: boolean }[];
    state: string; health: "ok" | "failing" | "unknown"; status?: ChannelStatus; manifest?: ChannelManifest;
  }
  const facts = (id: string, cfg: HarnessConfig, present: ReadonlySet<string>): Facts => {
    const registry = d.registry();
    const status = registry?.status(id);
    const manifest = registry?.manifestOf(id);
    const own = channelConfig(cfg, id);
    const secrets = secretRefs(own).map((r) => ({ ...r, present: present.has(r.name) }));
    const state = status?.state ?? "not-registered";
    const health = state === "running" ? "ok" : state === "backoff" || state === "failed" ? "failing" : "unknown";
    return {
      id, displayName: displayNameOf(id, manifest), configurable: hasOwn(channelSchemas(), id), enabled: own.enabled === true,
      missing: secrets.filter((s) => !s.present).map((s) => `secret:${s.name}`), secrets, state, health,
      ...(status ? { status } : {}), ...(manifest ? { manifest } : {}),
    };
  };
  const summary = (f: Facts) => ({ id: f.id, displayName: f.displayName, enabled: f.enabled, configured: f.configurable && f.missing.length === 0, state: f.state, health: f.health });

  const read = (fn: (p: unknown, who: string) => Promise<unknown> | unknown): Handler => async (p, ctx: CallContext) => {
    const principal = authenticatedPrincipal(ctx);
    return fn(p, principal.userId);
  };

  /** Applies `changes` (already validated) through the config source and returns the restart plan. */
  const write = async (changes: { key: string; value: unknown }[], before: HarnessConfig, after: unknown) => {
    const pending = d.source.set(changes);
    if (pending === null) throw new RpcError("E_NOT_AVAILABLE", "the configuration cannot be changed without a supervisor", { reason: "config-not-writable" });
    try { await pending; }
    catch (e) {
      if (e instanceof RpcError) throw e;
      throw new RpcError("E_CONFIG_INVALID", "the configuration change was refused", { reason: "config-refused" });
    }
    return restartView(before, after);
  };

  const toggle = (enabled: boolean): Handler => async (p, ctx) => {
    const principal = authenticatedPrincipal(ctx);
    const id = idParam(p);
    requireKnown(id);
    if (!hasOwn(channelSchemas(), id)) throw new RpcError("E_NOT_AVAILABLE", "this channel has no configuration here", { reason: "not-configurable" });
    const before = d.config();
    const own = channelConfig(before, id);
    const present = await presentSecrets();
    const f = facts(id, before, present);
    if ((own.enabled === true) === enabled) return { id, enabled, changed: false, restart: { live: [], core: false, modules: [] }, missing: f.missing };
    const after = structuredClone(before) as unknown as Record<string, any>;
    setPath(after, ["channels", id, "enabled"], enabled);
    const key = `channels.${id}.enabled`;
    const restart = await write([{ key, value: enabled }], before, after);
    audit(principal.userId, enabled ? "channel.enable" : "channel.disable", id, { key });
    return { id, enabled, changed: true, restart, missing: enabled ? f.missing : [] };
  };

  return {
    "channel.list": read(async () => {
      const cfg = d.config(), present = await presentSecrets();
      return { host: d.registry() !== null, channels: knownIds().map((id) => summary(facts(id, cfg, present))) };
    }),

    "channel.status": read(async () => {
      const cfg = d.config(), present = await presentSecrets();
      return {
        host: d.registry() !== null,
        channels: knownIds().map((id) => {
          const f = facts(id, cfg, present);
          return { id, enabled: f.enabled, state: f.state, health: f.health, ...(f.status?.lastError ? { lastError: scrub(f.status.lastError) } : {}) };
        }),
      };
    }),

    "channel.get": read(async (p) => {
      const id = idParam(p);
      requireKnown(id);
      const cfg = d.config(), present = await presentSecrets();
      const f = facts(id, cfg, present);
      const probe = f.state === "running" ? await d.registry()?.probe(id) : undefined;
      const node = channelSchemas()[id] as Schema | undefined;
      const manifest = f.manifest;
      return {
        ...summary(f),
        configurable: f.configurable,
        ...(node?.description ? { description: String(node.description) } : {}),
        ...(manifest ? { version: manifest.version, chatKinds: manifest.chatKinds } : {}),
        restart: f.configurable ? restartClassOf(`channels.${id}.enabled`) : "none",
        missing: f.missing,
        secrets: f.secrets,
        config: project(channelConfig(cfg, id), present),
        attempts: f.status?.attempts ?? 0,
        ...(f.status?.lastError ? { lastError: scrub(f.status.lastError) } : {}),
        ...(f.status?.startedAt !== undefined ? { startedAt: f.status.startedAt } : {}),
        ...(probe ? { probe: { ok: probe.ok, ...(probe.detail ? { detail: scrub(probe.detail) } : {}) } } : {}),
        linkHelp: manifest?.linkHelp ?? GENERIC_LINK_HELP(id, f.displayName),
      };
    }),

    "channel.enable": toggle(true),
    "channel.disable": toggle(false),

    "channel.set": async (p, ctx) => {
      const principal = authenticatedPrincipal(ctx);
      const params = paramsOf(p);
      const id = idParam(params);
      requireKnown(id);
      if (!hasOwn(channelSchemas(), id)) throw new RpcError("E_NOT_AVAILABLE", "this channel has no configuration here", { reason: "not-configurable" });
      const key = params.key;
      if (typeof key !== "string" || !KEY.test(key)) throw new RpcError("E_INVALID_PARAMS", "invalid key", { reason: "invalid-key" });
      const hasValue = "value" in params, hasText = "text" in params;
      if (hasValue === hasText) throw new RpcError("E_INVALID_PARAMS", "give exactly one of value and text", { reason: "value-required" });
      const path = key.split(".");
      const node = nodeAt(channelSchemas()[id] as Schema, path);
      if (!node) throw new RpcError("E_INVALID_PARAMS", "unknown key for this channel", { reason: "unknown-key" });
      let value: unknown;
      if (hasText) {
        if (typeof params.text !== "string" || params.text.length > MAX_TEXT) throw new RpcError("E_INVALID_PARAMS", "invalid value", { reason: "invalid-value", detail: key });
        const parsed = parseText(params.text, node);
        if (!parsed.ok) throw new RpcError("E_INVALID_PARAMS", `invalid value for ${key}`, { reason: "invalid-value", detail: parsed.reason });
        value = parsed.value;
      } else value = params.value;

      const leaf = path[path.length - 1]!;
      if (SECRET_KEY.test(leaf)) {
        if (typeof value !== "string" || looksLikeSecretValue(value)) {
          throw new RpcError("E_INVALID_PARAMS",
            `${key} takes the NAME of a secret, not its value; store the value with \`plur1bus secret set <name>\` (read from stdin) and give the name here`,
            { reason: "secret-value" });
        }
      } else if (typeof value === "string" && looksLikeToken(value)) {
        throw new RpcError("E_INVALID_PARAMS", `${key} looks like a credential; credentials are stored with \`plur1bus secret set\` and referenced by name`, { reason: "secret-value" });
      }

      const before = d.config();
      const after = structuredClone(before) as unknown as Record<string, any>;
      setPath(after, ["channels", id, ...path], value);
      const checked = validate(after);
      if (!checked.ok) {
        const mine = checked.errors.filter((e) => e.startsWith(`/channels/${id}`)).slice(0, 3);
        throw new RpcError("E_INVALID_PARAMS", `invalid value for ${key}`, { reason: "invalid-value", detail: (mine.length ? mine : checked.errors.slice(0, 1)).join("; ") });
      }
      const normalized = channelConfig(checked.config, id);
      const current = channelConfig(before, id);
      const before1 = JSON.stringify(path.reduce<unknown>((o, s) => (isObj(o) ? o[s] : undefined), current));
      const after1 = JSON.stringify(path.reduce<unknown>((o, s) => (isObj(o) ? o[s] : undefined), normalized));
      const secret = SECRET_KEY.test(leaf);
      const present = await presentSecrets();
      const result = (changed: boolean, restart: { live: string[]; core: boolean; modules: string[] }) => ({
        id, key, changed, restart,
        ...(secret ? { secret: { name: value as string, present: present.has(value as string) } } : { value: structuredClone(path.reduce<unknown>((o, s) => (isObj(o) ? o[s] : undefined), normalized)) }),
      });
      if (before1 === after1) return result(false, { live: [], core: false, modules: [] });
      const restart = await write([{ key: `channels.${id}.${key}`, value }], before, checked.config);
      audit(principal.userId, "channel.set", id, { key, ...(secret ? { secretName: value } : {}) });
      return result(true, restart);
    },

    "channel.test": async (p, ctx) => {
      const principal = authenticatedPrincipal(ctx);
      const params = paramsOf(p);
      const id = idParam(params);
      requireKnown(id);
      const sendOwner = params.sendOwner === true;
      if (params.sendOwner !== undefined && typeof params.sendOwner !== "boolean") throw new RpcError("E_INVALID_PARAMS", "sendOwner must be a boolean", { reason: "invalid-params" });
      // A send reaches a person: it needs the write action even though the method's rule is the read one.
      if (sendOwner && authorize(principal, "channel.write", { kind: "system" }, { now: d.clock() }).effect !== "allow") {
        throw new RpcError("E_DENIED", "not permitted: channel.write", { reason: "role-denied" });
      }
      const registry = d.registry();
      const status = registry?.status(id);
      const state = status?.state ?? "not-registered";
      const probe = await registry?.probe(id);
      const health = probe ?? { ok: false, detail: registry ? "not registered" : "no switchboard host" };
      const out: Record<string, unknown> = { id, ok: health.ok, state, ...(health.detail ? { detail: scrub(health.detail) } : {}), sent: false };
      if (!sendOwner) return out;
      if (!registry || state !== "running") throw new RpcError("E_NOT_AVAILABLE", "the channel is not running", { reason: "channel-not-running" });
      const identity = d.identity();
      if (!identity) throw new RpcError("E_NOT_AVAILABLE", "identity unavailable");
      // The caller's own human record only: the principal id is the human id (identity.link.list does the same).
      const mine = identity.list({}).humans.find((h) => h.id === principal.userId)?.identities.find((l) => l.channel === id && l.revokedAt === null);
      if (!mine) throw new RpcError("E_NOT_FOUND", "you have no linked identity on this channel", { reason: "owner-not-linked" });
      try {
        const delivered = await registry.sendTo(id, { chatId: mine.userId, text: TEST_MESSAGE });
        if (!delivered) throw new RpcError("E_NOT_AVAILABLE", "the channel is not running", { reason: "channel-not-running" });
      } catch (e) {
        if (e instanceof RpcError) throw e;
        throw new RpcError("E_NOT_AVAILABLE", "the test message could not be sent", { reason: "send-failed", detail: scrub(e instanceof Error ? e.message : e) });
      }
      audit(principal.userId, "channel.test.send", id, { linkId: mine.id });
      return { ...out, sent: true, sentTo: { linkId: mine.id } };
    },
  };
}
