/** M-A4/A5 live MCP composition. Owns registrations, never package mutation or secret values.
 * Config and supervisor events revoke authority immediately; each turn receives a stable descriptor snapshot.
 */
import type { McpRegistry } from "./registry.ts";
import type { McpServerDefinition } from "./types.ts";
import { installedMcpExtensions, type InstalledMcpExtension, type McpExtensionDeclaration,
  type McpExtensionRuntime } from "./extension-metadata.ts";
import type { ExtensionCapability } from "../toolcall/extension-feed.ts";

interface Config {
  providers?: { mcp?: { servers?: unknown[] } };
  mcp?: { servers?: Record<string, { enabled?: boolean; agents?: "all" | readonly string[] }> };
}

/** Read-only supervisor overlay port; its existing ext.watch/list consumer supplies this snapshot. */
export interface McpExtensionFeed {
  snapshot(): Promise<ExtensionCapability[]>;
  onChanged?: (() => void) | undefined;
}

/** Composition dependencies. Change subscriptions and uv resolution come only from the trusted host. */
export interface McpExtensionOptions {
  home: string;
  config(): Config;
  registry: Pick<McpRegistry, "register" | "unregister" | "allowCommand">;
  feed?: McpExtensionFeed;
  runtime?: McpExtensionRuntime;
  /** Metadata only; queried lazily when an installed package actually declares secret slots. */
  availableSecretNames?: () => Promise<ReadonlySet<string> | undefined>;
  onConfigChange?: (listener: () => void) => () => void;
  degraded?: (reason: string) => void;
  /** The host opens this only while admitting deferred startup after maintenance. */
  active?: () => boolean;
}

interface Registration {
  generation: number;
  definition: McpServerDefinition;
  signature: string;
  extension?: InstalledMcpExtension;
}

function registrationKey(name: string, raw: unknown): string {
  const scope = raw && typeof raw === "object" && "scope" in raw ? raw.scope : undefined;
  const agent = scope && typeof scope === "object" && "kind" in scope && scope.kind === "agent" &&
    "agentId" in scope && typeof scope.agentId === "string" ? scope.agentId : undefined;
  return agent === undefined ? `installation:${name}` : `agent:${agent}:${name}`;
}

function signature(raw: unknown, extension?: InstalledMcpExtension): string {
  return JSON.stringify([raw, extension?.activeVersion, extension?.manifestSha256, extension?.declaration]);
}

/** Serializes live reconciliation; disabling unregisters and stops the process rather than merely hiding tools. */
export class McpExtensionReconciler {
  readonly #options: McpExtensionOptions;
  readonly #registrations = new Map<string, Registration>();
  readonly #statuses = new Map<string, InstalledMcpExtension>();
  #overlays = new Map<string, ExtensionCapability>();
  #work: Promise<void> = Promise.resolve();
  #closed = false;
  #generation = 0;
  readonly #holds = new Set<string>();
  readonly #runtimeErrors = new Map<string, "auth-required" | "integrity-failed">();
  readonly #unwatch: (() => void) | undefined;

  constructor(options: McpExtensionOptions) {
    this.#options = options;
    this.#unwatch = options.onConfigChange?.(() => { void this.refresh(); });
    if (options.feed) options.feed.onChanged = () => {
      this.#overlays.clear();
      void this.refresh();
    };
  }

  /** Wait for the latest config and overlay snapshot before discovering the next turn's tool descriptors. */
  refresh(): Promise<void> {
    if (this.#closed || this.#options.active?.() === false) return this.#work;
    const config = this.#options.config();
    const revoked = this.#remove([...this.#registrations].filter(([, entry]) =>
      this.#holds.has(entry.definition.name) || (entry.extension &&
      config.mcp?.servers?.[entry.definition.name]?.enabled !== true)).map(([key]) => key));
    this.#work = Promise.all([this.#work, revoked]).then(() => this.#reconcile()).catch(() => {
      this.#options.degraded?.("MCP extension reconciliation failed");
    });
    return this.#work;
  }

  /** Current registered names; callers copy this list when creating a turn's immutable tool view. */
  servers(): readonly string[] {
    return [...new Set([...this.#registrations.values()].map(entry => entry.definition.name))].sort();
  }

  /** Installed declaration, with no credentials or environment values. */
  declaration(name: string): McpExtensionDeclaration | undefined {
    return [...this.#registrations.values()].find(entry => entry.definition.name === name)?.extension?.declaration;
  }

  /** Resolved launch metadata for host diagnostics; never contains a secret value. */
  definition(name: string): McpServerDefinition | undefined {
    return [...this.#registrations.values()].find(entry => entry.definition.name === name)?.definition;
  }

  /** Stable for one registration only; replacements invalidate the previous turn's authority snapshot. */
  revision(name: string, agentId: string): number | undefined {
    return (this.#registrations.get(`agent:${agentId}:${name}`) ??
      this.#registrations.get(`installation:${name}`))?.generation;
  }

  /** Derived setup/error state; does not write installation state or alter an enable flag. */
  status(name: string): InstalledMcpExtension | undefined {
    const status = this.#statuses.get(name);
    if (!status || !this.#runtimeErrors.has(name)) return status;
    const { reason: _reason, ...metadata } = status;
    return { ...metadata, overlay: "error",
      ...(this.#runtimeErrors.get(name) === "auth-required" ? { reason: "auth-required" as const } : {}) };
  }

  /** Stop a named registration before the supervisor moves its code; the hold blocks every concurrent refresh. */
  async hold(name: string): Promise<{ name: string; held: true }> {
    this.#holds.add(name);
    await this.#remove([...this.#registrations].filter(([, entry]) => entry.definition.name === name).map(([key]) => key));
    return { name, held: true };
  }

  /** The supervisor calls this after committing or rolling back its code transaction. */
  async release(name: string): Promise<{ name: string; released: true }> {
    this.#holds.delete(name);
    await this.refresh();
    return { name, released: true };
  }

  /** A setup/auth change explicitly permits a fresh attempt; changing a secret never changes an enable flag. */
  retry(name: string): Promise<void> {
    if (this.#closed || this.#options.active?.() === false) return this.#work;
    this.#runtimeErrors.delete(name);
    const removed = this.#remove([...this.#registrations].filter(([, entry]) =>
      entry.extension && entry.definition.name === name).map(([key]) => key));
    this.#work = Promise.all([this.#work, removed]).then(() => this.#reconcile()).catch(() => {
      this.#options.degraded?.("MCP extension reconciliation failed");
    });
    return this.#work;
  }

  /** Registry observer metadata only. Authentication failures become overlays; a ready connection clears them. */
  runtimeEvent(event: { server: string; state?: string; params?: Record<string, unknown> }): void {
    if (event.state === "ready") this.#runtimeErrors.delete(event.server);
    else if ((event.params?.reason === "auth-required" || event.params?.reason === "integrity-failed") &&
        this.#statuses.has(event.server)) {
      this.#runtimeErrors.set(event.server, event.params.reason);
    }
  }

  /** Exact host-owned registration identity gates spawn leases; a legacy server sharing a name gets no extension slots. */
  isPackagedDefinition(definition: McpServerDefinition): boolean {
    return !this.#closed && !this.#holds.has(definition.name) && [...this.#registrations.values()].some(entry =>
      entry.extension !== undefined && entry.definition === definition);
  }

  /** Live authorization is checked again at execution, independently of the earlier descriptor snapshot (M-A5). */
  visible(name: string, agentId: string): boolean {
    if (this.#closed || this.#options.active?.() === false || this.#holds.has(name) || this.#runtimeErrors.has(name)) return false;
    const registration = this.#registrations.get(`agent:${agentId}:${name}`) ??
      this.#registrations.get(`installation:${name}`);
    if (!registration) return false;
    if (!registration.extension) {
      const scope = registration.definition.scope;
      return scope.kind === "installation" || scope.agentId === agentId;
    }
    const setting = this.#options.config().mcp?.servers?.[name];
    if (setting?.enabled !== true || !(setting.agents === "all" || setting.agents?.includes(agentId))) return false;
    if (!this.#options.feed) return true;
    const overlay = this.#overlays.get(name);
    return overlay?.enabled === true && overlay.overlays.length === 0 &&
      (overlay.agents === "all" || overlay.agents.includes(agentId));
  }

  /** Detach subscriptions and stop every registration this reconciler owns. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#unwatch?.();
    if (this.#options.feed) this.#options.feed.onChanged = undefined;
    await this.#work;
    await this.#remove([...this.#registrations.keys()]);
  }

  async #remove(names: readonly string[]): Promise<void> {
    await Promise.all(names.map(async key => {
      const entry = this.#registrations.get(key);
      if (!entry) return;
      this.#registrations.delete(key);
      const scope = entry.definition.scope;
      await this.#options.registry.unregister(entry.definition.name, scope.kind === "agent" ? { agentId: scope.agentId } : {});
    }));
  }

  async #reconcile(): Promise<void> {
    if (this.#closed) return;
    const config = this.#options.config();
    // Stop disabled extensions before any metadata or supervisor I/O can delay the revocation.
    await this.#remove([...this.#registrations].filter(([, entry]) => entry.extension &&
      config.mcp?.servers?.[entry.definition.name]?.enabled !== true).map(([key]) => key));
    const desired = new Map<string, { raw: unknown; extension?: InstalledMcpExtension }>();
    for (const raw of config.providers?.mcp?.servers ?? []) {
      if (raw && typeof raw === "object" && "name" in raw && typeof raw.name === "string") {
        desired.set(registrationKey(raw.name, raw), { raw });
      }
    }
    try {
      let installed = await installedMcpExtensions(this.#options.home, this.#options.runtime);
      if (this.#options.availableSecretNames && installed.some(item => item.setup?.slots.length)) {
        const names = await this.#options.availableSecretNames();
        installed = await installedMcpExtensions(this.#options.home, this.#options.runtime, names);
      }
      this.#statuses.clear();
      // The supervisor may query runtime.status while serving ext.list; publish this metadata snapshot first.
      for (const extension of installed) this.#statuses.set(extension.name, extension);
      this.#overlays = new Map((await this.#options.feed?.snapshot() ?? []).map(item => [item.name, item]));
      for (const extension of installed) {
        const setting = this.#options.config().mcp?.servers?.[extension.name];
        if (this.#holds.has(extension.name) || setting?.enabled !== true || !extension.definition || [...desired.values()].some(target =>
          target.raw && typeof target.raw === "object" && "name" in target.raw &&
          target.raw.name === extension.name)) continue;
        const overlay = this.#overlays.get(extension.name);
        if (this.#options.feed && (!overlay?.enabled || overlay.overlays.length)) continue;
        desired.set(registrationKey(extension.name, extension.definition), { raw: extension.definition, extension });
      }
    } catch {
      this.#statuses.clear();
      this.#overlays.clear();
      this.#options.degraded?.("MCP extension metadata or supervisor catalogue unavailable");
    }
    if (this.#closed) return;
    await this.#remove([...this.#registrations].filter(([key, entry]) =>
      signature(desired.get(key)?.raw, desired.get(key)?.extension) !== entry.signature).map(([key]) => key));
    for (const [key, target] of desired) {
      if (target.raw && typeof target.raw === "object" && "name" in target.raw &&
          typeof target.raw.name === "string" && this.#holds.has(target.raw.name)) continue;
      if (this.#registrations.has(key)) continue;
      try {
        const command = target.extension?.definition?.transport;
        if (command?.type === "stdio") this.#options.registry.allowCommand(command.command);
        const definition = this.#options.registry.register(target.raw);
        this.#registrations.set(key, { definition, generation: ++this.#generation,
          signature: signature(target.raw, target.extension),
          ...(target.extension ? { extension: target.extension } : {}) });
        this.#runtimeErrors.delete(definition.name);
      } catch { this.#options.degraded?.("MCP server registration refused"); }
    }
  }
}
