/** M-A7 extension setup and spawn-only secret leases. Installed declarations own the permitted names;
 * callers never select arbitrary secrets, and credential values never enter definitions or setup responses.
 */
import { inspect } from "node:util";
import { createExtensionDataDir, createSecurePath } from "@plur1bus/module-api";
import type { LeasedLaunchEnvironment, McpLaunchEnvironment } from "../mcp/env.ts";
import { isolatedStdioEnv } from "../mcp/env.ts";
import type { McpServerDefinition } from "../mcp/types.ts";
import { RpcError } from "../rpc/errors.ts";
import type { Handler } from "../rpc/server.ts";
import { toRpcError } from "../secrets/rpc.ts";
import { acquireLease } from "../secrets/acquisition.ts";
import type { SecretStore } from "../secrets/store.ts";
import { SecretError, type SecretPrincipal } from "../secrets/types.ts";

const EXTENSION = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SLOT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const core = { kind: "core" } as const;
const MAX_ENV_VARIABLES = 256;
const MAX_ENV_VALUE_BYTES = 64 * 1024;
const LAUNCH_LEASE_TTL_MS = 10_000;

/** Metadata from an authenticated installed manifest and its hashed MCPB wrapper; never from RPC params. */
export interface ExtensionSecretDefinition {
  name: string;
  slots: readonly { slot: string; required: boolean }[];
  env?: Readonly<Record<string, string>>;
  userConfigSlots?: Readonly<Record<string, string>>;
  userConfig?: Readonly<Record<string, unknown>>;
  variables?: Readonly<Record<string, string>>;
}

/** Admin reads metadata only. The Owner principal retains the existing Secret Store surface checks. */
export type ExtensionSetupPrincipal = SecretPrincipal | { kind: "admin"; id?: string };

/** The only information the setup getter returns: declared names and backend availability, never values. */
export interface ExtensionSecretSetup {
  name: string;
  available: boolean;
  slots: { slot: string; secret: string; required: boolean; present: boolean | null }[];
}

/** Trusted ports for extension setup and launch. Missing/invalid installed metadata fails closed. */
export interface ExtensionSecretsOptions {
  home: string;
  store: Pick<SecretStore, "status" | "set" | "lease" | "revokeLease">;
  definition(name: string): Promise<ExtensionSecretDefinition | undefined>;
}

/** The canonical extension secret namespace has bounded, separately validated extension and slot components. */
export function extensionSecretName(name: string, slot: string): string {
  if (typeof name !== "string" || typeof slot !== "string" || !EXTENSION.test(name) || !SLOT.test(slot)) {
    throw new RpcError("E_INVALID_PARAMS", "invalid extension secret slot", { reason: "invalid-slot" });
  }
  return `ext:${name}:${slot}`;
}

function failure(error: unknown): unknown {
  return error instanceof RpcError ? error : error instanceof SecretError ? toRpcError(error) :
    new RpcError("E_STORAGE", "extension secret operation failed", { reason: "secret-storage" });
}

function needSetup(): RpcError {
  return new RpcError("E_NOT_AVAILABLE", "extension secret configuration is incomplete", { reason: "needs-setup" });
}

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RpcError("E_NOT_AVAILABLE", "extension launch aborted", { reason: "aborted" });
}

/** Values are private, non-enumerable, and erased on release; accidental JSON/debug printing exposes metadata only. */
class LaunchEnvironment implements LeasedLaunchEnvironment {
  readonly isolated = true;
  readonly #env: Record<string, string>;
  #release: (() => void) | undefined;
  constructor(env: Record<string, string>, release: () => void) { this.#env = env; this.#release = release; }
  get env(): Record<string, string> { return this.#env; }
  release(): void {
    const release = this.#release;
    this.#release = undefined;
    try { release?.(); } finally { for (const key of Object.keys(this.#env)) delete this.#env[key]; }
  }
  toJSON(): object { return { isolated: true }; }
  [inspect.custom](): object { return this.toJSON(); }
}

function assertNoSecretArgv(server: McpServerDefinition, definition: ExtensionSecretDefinition): void {
  if (server.transport.type !== "stdio") return;
  const slots = new Set(definition.slots.map(item => item.slot));
  for (const value of [server.transport.command, ...server.transport.args]) {
    for (const match of value?.matchAll(/\$\{user_config\.([^}]+)\}/g) ?? []) {
      const slot = definition.userConfigSlots?.[match[1]!] ?? match[1]!;
      if (slots.has(slot)) throw needSetup();
    }
  }
}

function interpolate(template: string, definition: ExtensionSecretDefinition,
  leased: ReadonlyMap<string, string>): string | undefined {
  let missingOptional = false;
  const value = template.replace(/\$\{([^}]+)\}/g, (_whole, key: string) => {
    if (key.startsWith("user_config.")) {
      const name = key.slice("user_config.".length);
      const slot = definition.userConfigSlots?.[name] ?? name;
      if (definition.slots.some(item => item.slot === slot)) {
        const secret = leased.get(slot);
        if (secret === undefined) missingOptional = true;
        return secret ?? "";
      }
      const configured = definition.userConfig && Object.hasOwn(definition.userConfig, name)
        ? definition.userConfig[name] : undefined;
      if (typeof configured === "string" || typeof configured === "number" || typeof configured === "boolean") {
        return String(configured);
      }
      throw needSetup();
    }
    if (definition.variables && Object.hasOwn(definition.variables, key)) return definition.variables[key]!;
    throw needSetup();
  });
  if (Buffer.byteLength(value) > MAX_ENV_VALUE_BYTES || value.includes("\0")) throw needSetup();
  return missingOptional ? undefined : value;
}

/** Builds declared-slot setup and the registry's spawn-only lease hook on the existing Secret Store. */
export function createExtensionSecrets(options: ExtensionSecretsOptions) {
  async function definition(name: string): Promise<ExtensionSecretDefinition> {
    if (typeof name !== "string" || !EXTENSION.test(name)) {
      throw new RpcError("E_INVALID_PARAMS", "invalid extension name");
    }
    const value = await options.definition(name);
    if (!value) throw new RpcError("E_NOT_FOUND", "extension not found", { reason: "extension-unknown" });
    if (value.name !== name || value.slots.length > MAX_ENV_VARIABLES) throw needSetup();
    const seen = new Set<string>();
    for (const item of value.slots) {
      extensionSecretName(name, item.slot);
      if (typeof item.required !== "boolean" || seen.has(item.slot)) throw needSetup();
      seen.add(item.slot);
    }
    return value;
  }

  async function getSetup(name: string, principal: ExtensionSetupPrincipal): Promise<ExtensionSecretSetup> {
    if (principal?.kind !== "owner" && principal?.kind !== "admin") {
      throw new RpcError("E_DENIED", "extension setup metadata is available to Owner and Admin only");
    }
    try {
      const declared = await definition(name);
      const status = await options.store.status(core);
      const names = status.secrets && new Set(status.secrets.map(item => item.name));
      return { name, available: status.backend !== "none", slots: declared.slots.map(item => ({
        slot: item.slot, secret: extensionSecretName(name, item.slot), required: item.required,
        present: names ? names.has(extensionSecretName(name, item.slot)) : null,
      })) };
    } catch (error) { throw failure(error); }
  }

  async function setSecret(name: string, slot: string, value: string, principal: ExtensionSetupPrincipal) {
    if (principal?.kind !== "owner") {
      throw new RpcError("E_DENIED", "extension secrets are available to the Owner only");
    }
    try {
      const declared = await definition(name);
      if (!declared.slots.some(item => item.slot === slot)) {
        throw new RpcError("E_INVALID_PARAMS", "secret slot is not declared by the extension",
          { reason: "undeclared-slot" });
      }
      await options.store.set(principal, extensionSecretName(name, slot), value);
      return { name, slot, stored: true as const };
    } catch (error) { throw failure(error); }
  }

  async function leaseDeclared(declared: ExtensionSecretDefinition, signal?: AbortSignal): Promise<LeasedLaunchEnvironment> {
    const leases: string[] = [];
    const values = new Map<string, string>();
    let environment: LaunchEnvironment | undefined;
    const revoke = (id: string) => {
      try { options.store.revokeLease(core, id); } catch {
        // Other leases must still be revoked; the short TTL bounds an unavailable audit backend.
      }
    };
    const release = () => {
      signal?.removeEventListener("abort", onAbort);
      for (const id of leases.splice(0)) revoke(id);
      values.clear();
    };
    const onAbort = () => environment ? environment.release() : release();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (const item of declared.slots) {
        aborted(signal);
        try {
          const lease = await acquireLease(() => options.store.lease(core, extensionSecretName(declared.name, item.slot),
            { purpose: "extension-spawn", profileId: declared.name, ttlMs: LAUNCH_LEASE_TTL_MS }),
          late => revoke(late.leaseId), signal);
          leases.push(lease.leaseId);
          aborted(signal);
          if (Buffer.byteLength(lease.value) > MAX_ENV_VALUE_BYTES || lease.value.includes("\0")) throw needSetup();
          values.set(item.slot, lease.value);
        } catch (error) {
          const absent = error instanceof SecretError &&
            ["not-found", "no-backend", "backend-unavailable"].includes(error.code);
          if (item.required || !absent) throw needSetup();
        }
      }
      aborted(signal);
      environment = new LaunchEnvironment(Object.assign(Object.create(null) as Record<string, string>,
        Object.fromEntries(values)), release);
      return environment;
    } catch (error) {
      release();
      aborted(signal);
      throw error instanceof RpcError ? error : needSetup();
    }
  }

  async function leaseSlots(name: string, signal?: AbortSignal): Promise<LeasedLaunchEnvironment> {
    aborted(signal);
    return leaseDeclared(await definition(name), signal);
  }

  const launchEnvironment: McpLaunchEnvironment = async (server, signal) => {
    aborted(signal);
    let declared: ExtensionSecretDefinition | undefined;
    try { declared = await options.definition(server.name); } catch { throw needSetup(); }
    if (!declared || server.transport.type !== "stdio") return undefined;
    declared = await definition(server.name);
    assertNoSecretArgv(server, declared);
    let dataDir: string;
    try { dataDir = createExtensionDataDir(options.home, server.name, createSecurePath()); } catch { throw needSetup(); }
    const lease = await leaseDeclared(declared, signal);
    try {
      const values = new Map(Object.entries(lease.env));
      const env: Record<string, string> = Object.create(null) as Record<string, string>;
      const mappedSlots = new Set(Object.values(declared.userConfigSlots ?? {}));
      // MCPB slot identifiers name storage, not environment variables; only its authenticated templates map them.
      for (const [slot, value] of values) if (!mappedSlots.has(slot)) env[slot] = value;
      const templates = Object.entries(declared.env ?? {});
      if (templates.length > MAX_ENV_VARIABLES) throw needSetup();
      for (const [name, template] of templates) {
        if (name.toUpperCase() === "P1X_DATA" || typeof template !== "string") throw needSetup();
        const expanded = interpolate(template, declared, values);
        if (expanded !== undefined) env[name] = expanded;
      }
      env.P1X_DATA = dataDir;
      const isolated = isolatedStdioEnv(env);
      for (const key of Object.keys(env)) delete env[key];
      values.clear();
      return new LaunchEnvironment(isolated, () => lease.release());
    } catch (error) {
      lease.release();
      throw error instanceof RpcError ? error : needSetup();
    }
  };

  return {
    getSetup, setSecret, launchEnvironment, leaseSlots,
    async availableSecretNames(): Promise<ReadonlySet<string> | undefined> {
      const status = await options.store.status(core);
      return status.secrets ? new Set(status.secrets.map(item => item.name)) : undefined;
    },
  };
}

/** The injected setup and spawn service consumed by Core composition. */
export type ExtensionSecrets = ReturnType<typeof createExtensionSecrets>;
/** Administrative methods stay excluded from every model-facing tool surface. */
export type ExtensionSetupMethod = "admin.extensions.setup.get" | "admin.extensions.setup.set";

/** Thin Core RPC adapter. The embedding Core supplies connection-derived principals; params confer no authority. */
export function buildExtensionSetupMethods(options: {
  service: Pick<ExtensionSecrets, "getSetup" | "setSecret">;
  principalOf(ctx: Parameters<Handler>[1], method: ExtensionSetupMethod, params: unknown):
    ExtensionSetupPrincipal | Promise<ExtensionSetupPrincipal>;
}): Record<ExtensionSetupMethod, Handler> {
  return {
    "admin.extensions.setup.get": async (params: { name: string }, ctx) =>
      options.service.getSetup(params.name, await options.principalOf(ctx, "admin.extensions.setup.get", params)),
    "admin.extensions.setup.set": async (params: { name: string; slot: string; value: string }, ctx) =>
      options.service.setSecret(params.name, params.slot, params.value,
        await options.principalOf(ctx, "admin.extensions.setup.set", params)),
  };
}
