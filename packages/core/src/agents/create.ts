import { randomUUID } from "node:crypto";
// Agent creation is serialised per core, with Config Schema as the sole settings validator.
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_SCHEMA, validate, type HarnessConfig } from "@plur1bus/config-schema";
import type { Principal, AgentRight } from "../rbac/types.ts";
import { authorize } from "../rbac/authorize.ts";
import type { Layout } from "../paths.ts";
import type { AuditSink } from "../rbac/audit.ts";
import { RpcError } from "../rpc/errors.ts";
import { AgentCreateSaga, creationDigest, type SagaRecord } from "./saga.ts";
import { cleanImport, readAgentBundle, type AgentFile } from "./import.ts";
export interface WizardError { step: "identity" | "model" | "rights"; field: string; message: string; code: string }
export interface AgentCreationDeps {
  config(): HarnessConfig; layout: Layout; clock(): number; audit: AuditSink;
  /** Config owner commits against its current revision. A lost supervisor must refuse writes. */
  set(id: string, config: HarnessConfig["agents"][string]): Promise<void>;
  people(): string[];
  setRight(id: string, userId: string, right: AgentRight | null): void;
  secrets(): Promise<readonly string[]>;
  requiredSecrets(config: HarnessConfig["agents"][string]): string[];
  importMemory(id: string, cards: unknown[], hash: string, who: Principal): Promise<void>;
  pause(id: string): void;
  /** Reversible runtime reservation; close does not claim engine data erasure. */
  reserve?(id: string): Promise<void>;
  release?(id: string): Promise<void>;
  ready?(id: string): void;
  removeConfig?(id: string, expected: HarnessConfig["agents"][string]): Promise<void>;
  clearRights?(id: string): void;
}
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
/** References are checked against the instance both in the wizard and immediately before the Config-owner commit. */
export function agentReferenceErrors(config: HarnessConfig, settings: Record<string, any>): WizardError[] {
  const errors: WizardError[] = [];
  if (typeof settings.model === "string" && !Object.hasOwn(config.modelProfiles, settings.model)) errors.push({ step: "model", field: "model", message: "unknown model profile", code: "E_INVALID_PARAMS" });
  if (Array.isArray(settings.channels)) for (const [n, channel] of settings.channels.entries()) if (typeof channel === "string" && !Object.hasOwn(config.channels, channel)) errors.push({ step: "identity", field: `channels/${n}`, message: "unknown channel", code: "E_INVALID_PARAMS" });
  return errors;
}
export function agentCreation(d: AgentCreationDeps) {
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const job = chain.then(fn); chain = job.catch(() => {}); return job; };
  const check = (payload: unknown, who: Principal, imported = false) => {
    const p = obj(payload) ? payload : {}, errors: WizardError[] = [];
    const add = (step: WizardError["step"], field: string, message: string, code = "E_INVALID_PARAMS") => errors.push({ step, field, message, code });
    const id = typeof p.name === "string" ? p.name : "";
    // The name is the Config Schema's agents-map key, not a parallel identifier rule.
    const nameSchema = CONFIG_SCHEMA.properties.agents.propertyNames;
    if (!id || !new RegExp(nameSchema.pattern).test(id)) add("identity", "name", "invalid agent name");
    else if (Object.hasOwn(d.config().agents, id) || existsSync(d.layout.agentDir(id))) add("identity", "name", "agent already exists", "E_AGENT_EXISTS");
    // A person ID is a rights recipient; an agent of the same name would make that person ungrantable and ambiguous.
    else if (d.people().includes(id)) add("identity", "name", "name belongs to a person", "E_AGENT_EXISTS");
    const config = Object.fromEntries(Object.entries(p).filter(([k]) => k !== "name" && k !== "rights" && k !== "idempotencyKey"));
    const candidate = { ...d.config(), agents: { wizard: config } };
    const checked = validate(candidate);
    if (!checked.ok) for (const message of checked.errors) {
      const field = message.replace(/^\/agents\/wizard\/?/, "").split(" ")[0] || "identity";
      add(field === "model" || field.startsWith("memory") ? "model" : "identity", field, "invalid agent setting");
    }
    errors.push(...agentReferenceErrors(d.config(), p));
    const rights: Record<string, AgentRight> = {}, discardedRights: string[] = [];
    if (p.rights !== undefined && !obj(p.rights)) add("rights", "rights", "expected a map of existing person IDs to use/manage", "E_AGENT_RIGHTS");
    else for (const [person, right] of Object.entries(p.rights ?? {})) {
      if (!person || person.length > 128 || /[\u0000-\u001f\u007f]/.test(person)) { add("rights", "rights", "invalid person ID", "E_AGENT_RIGHTS"); continue; }
      if (right !== "use" && right !== "manage") { add("rights", "rights", "invalid agent right", "E_AGENT_RIGHTS"); continue; }
      if (!d.people().includes(person) || Object.hasOwn(d.config().agents, person)) { if (imported) discardedRights.push(person); else add("rights", "rights", "recipient must be an existing person", "E_AGENT_RIGHTS"); continue; }
      // Role AND token scopes bound delegation. manage implies use; an imported right may be lowered or dropped.
      const resource = { kind: "agent" as const, agentId: id || "wizard" };
      const manage = authorize(who, "agent.manage", resource).effect === "allow";
      const use = authorize(who, "agent.read", resource).effect === "allow";
      if (right === "manage" && !manage || right === "use" && !use) {
        if (!imported) add("rights", "rights", "requested right exceeds caller", "E_AGENT_RIGHTS");
        else if (right === "manage" && use) rights[person] = "use";
        else discardedRights.push(person);
      } else rights[person] = right;
    }
    return { id, config: checked.ok ? checked.config.agents.wizard! : config as HarnessConfig["agents"][string], rights, discardedRights, errors };
  };
  const commit = async (v: ReturnType<typeof check>, who: Principal, files: AgentFile[] = []) => {
    if (v.errors.length) { const error = v.errors[0]!; throw new RpcError(error.code, error.message, { detail: error.field }); }
    if (Object.hasOwn(d.config().agents, v.id) || existsSync(d.layout.agentDir(v.id))) throw new RpcError("E_AGENT_EXISTS", "agent name or data directory already exists");
    mkdirSync(d.layout.agents, { recursive: true, mode: 0o700 });
    const stage = mkdtempSync(join(d.layout.agents, ".create-")), root = d.layout.agentDir(v.id);
    let moved = false, registered = false;
    try {
      mkdirSync(join(stage, "workspace"), { recursive: true, mode: 0o700 });
      for (const file of files) {
        if (file.path === "config.json" || file.path === "memory/cards.json") continue;
        const dest = join(stage, file.path); mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        writeFileSync(dest, cleanImport(file.text), { mode: 0o600, flag: "wx" });
      }
      if (v.config.persona !== undefined && !existsSync(join(stage, "SOUL.md"))) writeFileSync(join(stage, "SOUL.md"), v.config.persona, { mode: 0o600 });
      // Intent is recorded before writes, completion after registration. Neither contains submitted text/secret values.
      d.audit.append({ at: d.clock(), actor: { user: who.userId, host: "rpc" }, action: "agent.create", target: v.id, detail: {} });
      renameSync(stage, root); moved = true;
      await d.set(v.id, { ...v.config, createdAt: new Date(d.clock()).toISOString() }); registered = true;
      for (const [person, right] of Object.entries(v.rights)) d.setRight(v.id, person, right);
      d.setRight(v.id, who.userId, "manage");
      d.audit.append({ at: d.clock(), actor: { user: who.userId, host: "rpc" }, action: "agent.created", target: v.id, detail: {} });
      return { agentId: v.id };
    } catch (e) {
      // A failed commit call may still have been applied (timeout after the Config owner's write): then the agent is
      // registered and its data directory must survive. Treat it exactly like a failure after registration.
      let applied = registered;
      if (!applied && moved) { try { applied = Object.hasOwn(d.config().agents, v.id); } catch { applied = true; } }
      if (applied) { d.pause(v.id); throw new RpcError("E_STORAGE", "agent registration requires recovery", { ids: { agentId: v.id } }); }
      if (moved) rmSync(root, { recursive: true, force: true });
      if (e instanceof RpcError) throw e;
      throw new RpcError("E_STORAGE", "agent registration unavailable");
    } finally { rmSync(stage, { recursive: true, force: true }); }
  };
  const saga = new AgentCreateSaga(d.layout.state);
  const stepsFor = (record: SagaRecord) => {
    const v = record.payload as { config: HarnessConfig["agents"][string]; rights: Record<string, AgentRight> };
    const id = record.agentId, root = d.layout.agentDir(id);
    if (!new RegExp(CONFIG_SCHEMA.properties.agents.propertyNames.pattern).test(id) || !obj(v) || !obj(v.config) || !obj(v.rights)) throw new RpcError("E_STORAGE", "invalid provisioning intent");
    if (!d.reserve || !d.release || !d.removeConfig || !d.clearRights) throw new RpcError("E_NOT_AVAILABLE", "reversible agent provisioning unavailable");
    return [
      { name: "engine", apply: () => d.reserve!(id), undo: () => d.release!(id) },
      { name: "files", apply: async () => {
        mkdirSync(join(root, "workspace"), { recursive: true, mode: 0o700 });
        if (v.config.persona !== undefined) writeFileSync(join(root, "SOUL.md"), v.config.persona, { mode: 0o600, flag: "wx" });
      }, undo: async () => { rmSync(root, { recursive: true, force: true }); } },
      { name: "config", apply: () => d.set(id, v.config), undo: () => d.removeConfig!(id,v.config) },
      { name: "rights", apply: async () => {
        for (const [user, right] of Object.entries(v.rights)) d.setRight(id, user, right);
        d.setRight(id, record.actor, "manage");
        d.audit.append({ at: d.clock(), actor: { user: record.actor, host: "rpc" }, action: "agent.created", target: id, detail: { idempotency: true } });
      }, undo: async () => { d.clearRights!(id); } },
    ];
  };
  const recover = async () => {
    for (const record of saga.completedUnactivated()) { await d.release?.(record.agentId); d.ready?.(record.agentId); saga.markActivated(record); }
    for (const record of saga.pending()) {
      try { await saga.compensate(record, stepsFor(record)); }
      catch { d.pause(record.agentId); throw new RpcError("E_STORAGE", "agent provisioning recovery incomplete"); }
    }
  };
  const create = (payload: unknown, who: Principal) => serial(async () => {
    if (!obj(payload)) return commit(check(payload, who), who);
    if (payload.idempotencyKey === undefined) {
      if (!d.reserve) return commit(check(payload, who), who);
      payload = { ...payload, idempotencyKey: randomUUID() };
    }
    if (!obj(payload)) throw new RpcError("E_INVALID_PARAMS", "invalid creation request");
    const key = payload.idempotencyKey;
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new RpcError("E_INVALID_PARAMS", "invalid idempotency key");
    await recover();
    const digest = creationDigest(payload), previous = saga.find(key, who.userId);
    if (previous && previous.digest !== digest) throw new RpcError("E_CONFLICT", "idempotency key belongs to another request");
    if (previous?.state === "complete") return { agentId: previous.agentId, replayed: true };
    const v = check(payload, who);
    if (v.errors.length) { const e = v.errors[0]!; throw new RpcError(e.code, e.message, { detail: e.field }); }
    const record: SagaRecord = { version: 1, key, actor: who.userId, digest, agentId: v.id, attempted: 0, state: "running", payload: { config: { ...v.config, createdAt: new Date(d.clock()).toISOString() }, rights: v.rights } };
    const steps = stepsFor(record);
    d.audit.append({ at: d.clock(), actor: { user: who.userId, host: "rpc" }, action: "agent.create", target: v.id, detail: { idempotency: true } });
    try { await saga.provision(record, steps); }
    catch (e) { if (e instanceof RpcError) throw e; throw new RpcError("E_STORAGE", "agent provisioning unavailable"); }
    await d.release!(v.id); d.ready?.(v.id); saga.markActivated(record);
    return { agentId: v.id };
  });
  return {
    validate(payload: unknown, who: Principal) { const { errors } = check(payload, who); return { valid: errors.length === 0, errors }; },
    create, recover: () => serial(recover),
    import: (input: unknown, onConflict: unknown, who: Principal) => serial(async () => {
      // Version, checksums and any signature precede config interpretation and every mutation.
      const bundle = readAgentBundle(input);
      if (onConflict !== undefined && onConflict !== "fail" && onConflict !== "rename") throw new RpcError("E_INVALID_PARAMS", "invalid conflict strategy", { detail: "onConflict" });
      let config: unknown, cards: unknown;
      try { config = cleanImport(JSON.parse(bundle.files.find(f => f.path === "config.json")!.text)); cards = cleanImport(JSON.parse(bundle.files.find(f => f.path === "memory/cards.json")!.text)); }
      catch { throw new RpcError("E_INVALID_PARAMS", "invalid export JSON", { detail: "bundle" }); }
      if (!obj(config) || !Array.isArray(cards) || cards.length > 500 || cards.some(c => !obj(c) || typeof c.text !== "string" || typeof c.id !== "string" || !["agent-private", "workspace", "user"].includes(c.scope))) throw new RpcError("E_INVALID_PARAMS", "invalid export content", { detail: "bundle" });
      let name = bundle.agentId;
      const taken = (id: string) => Object.hasOwn(d.config().agents, id) || existsSync(d.layout.agentDir(id));
      if (taken(name) && onConflict === "rename") { let n = 2; do { name = `${bundle.agentId.slice(0, 58)}-${n++}`; } while (taken(name) && n < 10000); }
      // Strip old creation timestamps; export config is otherwise validated intact, including optional voice/skills settings.
      delete config.createdAt;
      const v = check({ ...config, name, rights: bundle.rights }, who, true);
      if (v.errors.length) { const e = v.errors[0]!; throw new RpcError(e.code, e.message, { detail: e.field }); }
      const required = [...new Set([...bundle.requiredSecrets, ...d.requiredSecrets(v.config)])];
      const available = new Set(required.length ? await d.secrets() : []);
      const missing = required.filter(name => !available.has(name));
      if (missing.length) throw new RpcError("E_AGENT_SECRETS_MISSING", "required secrets are missing", { ids: Object.fromEntries(missing.map(name => [name, name])) });
      const result = await commit(v, who, bundle.files);
      try { await d.importMemory(v.id, cards, bundle.hash, who); }
      catch { d.pause(v.id); throw new RpcError("E_STORAGE", "memory import incomplete; agent paused", { ids: { agentId: v.id } }); }
      return { ...result, discardedRights: v.discardedRights };
    }),
  };
}
