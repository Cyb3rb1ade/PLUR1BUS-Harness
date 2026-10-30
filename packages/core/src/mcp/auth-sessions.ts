/** M-A8: bounded, person/server-bound OAuth attempts. Only explicit human start opens an interaction.
 * Tokens remain in the private provider; RPC views contain presentation metadata, never callback codes or verifiers.
 */
import { randomUUID } from "node:crypto";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Principal } from "../rbac/types.ts";
import type { PrincipalResolver } from "../rbac/guard.ts";
import type { Handler } from "../rpc/server.ts";
import { RpcError } from "../rpc/errors.ts";
import type { EnvSnapshot } from "../auth/env.ts";
import type { LoginMethod } from "../auth/ladder.ts";
import type { DevicePrompt } from "../auth/login.ts";
import { createMcpAuthInteraction, type McpAuthInteraction } from "./auth-interaction.ts";
import { MCP_AUTH_TIMEOUT_MS, McpAuthRequiredError, PkceAuthProvider, discoverMcpAuthChallenge,
  type McpAuthProvider } from "./auth.ts";

const DEFAULT_ATTEMPTS = 32;
const MAX_BINDINGS = 128;
const MAX_CALLBACK_BYTES = 8192;
const ACTIVE = new Set(["starting", "awaiting-callback", "awaiting-device"]);

/** Verified installed resource; registration metadata comes from host configuration or explicit human setup input. */
export interface McpOAuthBinding { resource: string; clientId?: string; redirectUri?: string }
export interface McpAuthSessionsOptions {
  binding(name: string): McpOAuthBinding | undefined;
  fetch: FetchLike;
  env: EnvSnapshot;
  /** Current authorization from the authenticated Core principal, never a browser-supplied role snapshot. */
  authorize(principal: Principal, action: "read" | "manage"): boolean;
  protect(value: string): void;
  openBrowser?(url: string): Promise<void>;
  onDevice?(prompt: DevicePrompt): Promise<void>;
  changed?(name: string, status: McpAuthAttemptView["status"]): void;
  now?: () => number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  lifetimeMs?: number;
  maxAttempts?: number;
}
export interface McpAuthAttemptView {
  attemptId: string;
  name: string;
  status: "starting" | "awaiting-callback" | "awaiting-device" | "authorized" | "failed" | "cancelled" | "expired";
  expiresAt: number;
  method?: LoginMethod;
  authorizationUrl?: string;
  redirectUri?: string;
  sshHint?: string;
  device?: { userCode: string; verificationUri: string; verificationUriComplete?: string };
}
export interface McpAuthStart {
  name: string;
  clientId?: string;
  redirectUri?: string;
  method?: LoginMethod;
  pasteCallback?: boolean;
}
export interface McpAuthAttempt { name: string; attemptId: string }
interface Attempt {
  person: string;
  view: McpAuthAttemptView;
  controller: AbortController;
  timer: NodeJS.Timeout;
  interaction: McpAuthInteraction;
  callback: Promise<string>;
  submit?: (url: string) => void;
  entry: Entry;
}
interface Entry {
  signature: string;
  binding: Required<McpOAuthBinding>;
  oauth: PkceAuthProvider;
  publicProvider: McpAuthProvider;
  active?: Attempt;
  scope?: string;
}

/** In-process service: transport wrappers supply their resolved principal, never request-supplied authority. */
export class McpAuthSessions {
  readonly #options: McpAuthSessionsOptions;
  readonly #attempts = new Map<string, Attempt>();
  readonly #entries = new Map<string, Entry>();
  readonly #setup = new Map<string, Required<McpOAuthBinding> & { sourceSignature: string }>();
  readonly #now: () => number;
  readonly #lifetime: number;
  readonly #maxAttempts: number;
  #closed = false;

  constructor(options: McpAuthSessionsOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#lifetime = options.lifetimeMs ?? MCP_AUTH_TIMEOUT_MS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_ATTEMPTS;
    if (!Number.isSafeInteger(this.#lifetime) || this.#lifetime < 1 || this.#lifetime > MCP_AUTH_TIMEOUT_MS
      || !Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > MAX_BINDINGS) {
      throw new RpcError("E_INVALID_PARAMS", "invalid MCP authorization limits");
    }
  }

  /** This same configuration gate controls the loader and registry factory; it says nothing about token contents. */
  ready(name: string): boolean { return !this.#closed && this.#binding(name) !== undefined; }

  /** Stable registry factory: discovery may use a prior token but never initiate or join human authorization. */
  provider(name: string): McpAuthProvider | undefined { return this.#entry(name)?.publicProvider; }

  /** Begin once as a person. Explicit client identity is session-local setup metadata; no hosted URL is invented. */
  start(principal: Principal, params: McpAuthStart): McpAuthAttemptView {
    this.#admit(principal);
    this.#prune();
    const active = this.#entries.get(params.name)?.active;
    if (active && ACTIVE.has(active.view.status)) this.#busy();
    if (params.clientId !== undefined || params.redirectUri !== undefined) {
      const source = this.#options.binding(params.name);
      if (!source || typeof params.clientId !== "string" || typeof params.redirectUri !== "string") {
        throw new RpcError("E_INVALID_PARAMS", "MCP client identity and redirect URI are required");
      }
      const configured = this.#validate({ resource: source.resource,
        clientId: params.clientId, redirectUri: params.redirectUri });
      if (this.#setup.size >= MAX_BINDINGS && !this.#setup.has(params.name)) this.#busy();
      this.#setup.set(params.name, { ...configured, sourceSignature: JSON.stringify(source) });
    }
    const entry = this.#entry(params.name);
    if (!entry) {
      throw new RpcError("E_NOT_AVAILABLE", "MCP OAuth client registration is required", { reason: "auth-required" });
    }
    if (entry.active && ACTIVE.has(entry.active.view.status) || this.#attempts.size >= this.#maxAttempts) this.#busy();
    const controller = new AbortController(), id = randomUUID();
    let submit!: (url: string) => void;
    const callback = new Promise<string>((resolve, reject) => {
      submit = resolve;
      controller.signal.addEventListener("abort", () => reject(new McpAuthRequiredError()), { once: true });
    });
    void callback.catch(() => {});
    const view: McpAuthAttemptView = { attemptId: id, name: params.name, status: "starting",
      expiresAt: this.#now() + this.#lifetime };
    const interaction = createMcpAuthInteraction({ env: this.#options.env, now: this.#now,
      ...(params.method ? { method: params.method } : {}),
      ...(params.pasteCallback === undefined ? {} : { pasteCallback: params.pasteCallback }),
      ...(this.#options.sleep ? { sleep: this.#options.sleep } : {}),
      openBrowser: async url => {
        this.#prompt(view, url, entry.binding.redirectUri, "loopback_pkce");
        await this.#options.openBrowser?.(url);
      },
      onAuthorization: async prompt => {
        this.#prompt(view, prompt.authorizationUrl, prompt.redirectUri,
          params.method === "paste_callback" || params.pasteCallback ? "paste_callback" : "loopback_ssh",
          prompt.sshHint);
      },
      readCallback: async () => await callback,
      onDevice: async prompt => {
        view.status = "awaiting-device";
        view.method = "device_code";
        view.device = { userCode: prompt.userCode, verificationUri: prompt.verificationUri,
          ...(prompt.verificationUriComplete ? { verificationUriComplete: prompt.verificationUriComplete } : {}) };
        await this.#options.onDevice?.(prompt);
      },
    });
    const timer = setTimeout(() => this.#finish(attempt, "expired"), this.#lifetime);
    timer.unref();
    const attempt: Attempt = {
      person: principal.userId, view, controller, timer, interaction, callback, submit, entry,
    };
    entry.active = attempt;
    this.#attempts.set(id, attempt);
    void this.#run(attempt);
    return this.#view(attempt);
  }

  /** Only the initiating current person may inspect this attempt, including its explicit UI prompts. */
  status(principal: Principal, params: McpAuthAttempt): McpAuthAttemptView {
    return this.#view(this.#own(principal, params, "read"));
  }

  /** A pasted full callback is write-only and consumed once by the existing interaction adapter. */
  submit(principal: Principal, params: McpAuthAttempt & { callbackUrl: string }): McpAuthAttemptView {
    const attempt = this.#own(principal, params);
    if (attempt.view.status !== "awaiting-callback" || attempt.view.method !== "paste_callback" || !attempt.submit) {
      throw new RpcError("E_CONFLICT", "MCP authorization is not awaiting a pasted callback");
    }
    if (typeof params.callbackUrl !== "string" || Buffer.byteLength(params.callbackUrl) > MAX_CALLBACK_BYTES) {
      throw new RpcError("E_INVALID_PARAMS", "invalid MCP authorization callback");
    }
    const accept = attempt.submit;
    delete attempt.submit;
    accept(params.callbackUrl);
    return this.#view(attempt);
  }

  /** Cancellation never revokes another person's attempt or leaks whether its id exists. */
  cancel(principal: Principal, params: McpAuthAttempt): McpAuthAttemptView {
    const attempt = this.#own(principal, params);
    if (ACTIVE.has(attempt.view.status)) this.#finish(attempt, "cancelled");
    return this.#view(attempt);
  }

  /** End pending interactions and make existing registry wrappers unusable. No credential is persisted here. */
  close(): void {
    this.#closed = true;
    for (const attempt of this.#attempts.values()) this.#finish(attempt, "cancelled");
    this.#attempts.clear(); this.#entries.clear(); this.#setup.clear();
  }

  async #run(attempt: Attempt): Promise<void> {
    try {
      const { entry } = attempt;
      const challenge = await discoverMcpAuthChallenge(entry.binding.resource, this.#options.fetch,
        entry.oauth, this.#options.protect, attempt.controller.signal,
        entry.scope ? { scope: entry.scope } : {});
      await entry.oauth.authorize(challenge, attempt.controller.signal);
      if (!attempt.controller.signal.aborted) this.#finish(attempt, "authorized");
    } catch {
      if (!attempt.controller.signal.aborted) this.#finish(attempt, "failed");
    }
  }

  #entry(name: string): Entry | undefined {
    const binding = this.#binding(name);
    if (!binding || this.#closed) return undefined;
    const signature = JSON.stringify(binding), previous = this.#entries.get(name);
    if (previous?.signature === signature) return previous;
    if (!previous && this.#entries.size >= MAX_BINDINGS) this.#busy();
    if (previous?.active) this.#finish(previous.active, "cancelled");
    let entry!: Entry;
    const current = (): McpAuthInteraction => {
      if (!entry.active || !ACTIVE.has(entry.active.view.status)) throw new McpAuthRequiredError();
      return entry.active.interaction;
    };
    const oauth = new PkceAuthProvider({ clientId: binding.clientId, redirectUri: binding.redirectUri, interaction: {
      plan: metadata => current().plan(metadata),
      authorize: (url, metadata, signal) => current().authorize(url, metadata, signal),
      onDevice: (prompt, signal) => current().onDevice(prompt, signal),
      sleep: (ms, signal) => current().sleep(ms, signal), now: this.#now,
    } });
    entry = { signature, binding, oauth, publicProvider: {
      accessToken: async (resource, signal) => {
        if (this.#closed || this.#binding(name)?.resource !== binding.resource
          || JSON.stringify(this.#binding(name)) !== signature) return undefined;
        return await oauth.accessToken(resource, signal);
      },
      supportsAuthorizationServer: metadata => oauth.supportsAuthorizationServer(metadata),
      authorize: async challenge => {
        if (challenge.resource === binding.resource && typeof challenge.scope === "string") {
          entry.scope = challenge.scope;
        }
        throw new McpAuthRequiredError();
      },
    } };
    this.#entries.set(name, entry);
    return entry;
  }

  #binding(name: string): Required<McpOAuthBinding> | undefined {
    try {
      const source = this.#options.binding(name);
      if (!source) return undefined;
      const setup = this.#setup.get(name);
      if (setup && setup.sourceSignature !== JSON.stringify(source)) this.#setup.delete(name);
      return this.#validate(setup?.sourceSignature === JSON.stringify(source) ? setup : source);
    } catch { return undefined; }
  }

  #validate(binding: McpOAuthBinding): Required<McpOAuthBinding> {
    if (!binding.clientId || !binding.redirectUri || binding.clientId.length > 2048
      || /[\x00-\x20\x7f]/.test(binding.clientId)) {
      throw new RpcError("E_INVALID_PARAMS", "invalid MCP client identity");
    }
    const resource = new URL(binding.resource), redirect = new URL(binding.redirectUri);
    if (resource.username || resource.password || resource.hash
      || redirect.username || redirect.password || redirect.hash
      || redirect.search || !["https:", "http:"].includes(resource.protocol)
      || resource.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(resource.hostname)
      || redirect.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(redirect.hostname) || !redirect.port) {
      throw new RpcError("E_INVALID_PARAMS", "invalid MCP resource or loopback redirect");
    }
    return { resource: resource.href, clientId: binding.clientId, redirectUri: redirect.href };
  }

  #admit(principal: Principal, action: "read" | "manage" = "manage"): void {
    let allowed = false;
    try { allowed = this.#options.authorize(principal, action); } catch { /* authorization fails closed */ }
    if (this.#closed || !principal || principal.kind !== "person" || !principal.userId
      || !["owner", "admin"].includes(principal.role) || !allowed) {
      throw new RpcError("E_DENIED", "MCP authorization denied");
    }
  }

  #own(principal: Principal, params: McpAuthAttempt, action: "read" | "manage" = "manage"): Attempt {
    this.#admit(principal, action);
    const attempt = this.#attempts.get(params.attemptId);
    if (!attempt || attempt.person !== principal.userId || attempt.view.name !== params.name) {
      throw new RpcError("E_NOT_FOUND", "MCP authorization attempt not found");
    }
    if (this.#now() >= attempt.view.expiresAt && ACTIVE.has(attempt.view.status)) this.#finish(attempt, "expired");
    return attempt;
  }

  #finish(attempt: Attempt, status: McpAuthAttemptView["status"]): void {
    attempt.view.status = status;
    delete attempt.view.authorizationUrl; delete attempt.view.redirectUri;
    delete attempt.view.sshHint; delete attempt.view.device; delete attempt.submit;
    clearTimeout(attempt.timer);
    if (status !== "authorized") attempt.controller.abort();
    if (attempt.entry.active === attempt) delete attempt.entry.active;
    try { this.#options.changed?.(attempt.view.name, status); } catch { /* UI observers cannot alter credential state */ }
  }

  #prompt(view: McpAuthAttemptView, url: string, redirect: string, method: LoginMethod, hint?: string): void {
    view.status = "awaiting-callback"; view.method = method;
    view.authorizationUrl = url; view.redirectUri = redirect;
    if (hint) view.sshHint = hint;
  }
  #view(attempt: Attempt): McpAuthAttemptView { return structuredClone(attempt.view); }
  #busy(): never { throw new RpcError("E_CONFLICT", "MCP authorization is busy", { reason: "busy" }); }
  #prune(): void {
    for (const [id, attempt] of this.#attempts) {
      if (this.#now() >= attempt.view.expiresAt) {
        if (ACTIVE.has(attempt.view.status)) this.#finish(attempt, "expired");
        this.#attempts.delete(id);
      }
    }
    if (this.#attempts.size < this.#maxAttempts) return;
    for (const [id, attempt] of this.#attempts) if (!ACTIVE.has(attempt.view.status)) {
      this.#attempts.delete(id);
      if (this.#attempts.size < this.#maxAttempts) break;
    }
  }
}

/** Mount human-only Core methods; the resolver binds identity independently of their closed schema params. */
export function buildMcpAuthSessionMethods(service: McpAuthSessions,
  resolve: PrincipalResolver): Record<string, Handler> {
  const fields: Record<string, readonly string[]> = {
    "admin.extensions.auth.start": ["name", "clientId", "redirectUri", "method", "pasteCallback"],
    "admin.extensions.auth.status": ["name", "attemptId"],
    "admin.extensions.auth.submit": ["name", "attemptId", "callbackUrl"],
    "admin.extensions.auth.cancel": ["name", "attemptId"],
  };
  return Object.fromEntries(Object.keys(fields).map(method => [method, async (raw: unknown, ctx) => {
    const principal = await resolve(ctx, method, raw);
    if (!principal) throw new RpcError("E_UNAUTHORIZED", "authentication required");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || Object.keys(raw).some(key => !fields[method]!.includes(key))) {
      throw new RpcError("E_INVALID_PARAMS", "invalid MCP authorization parameters");
    }
    const params = raw as McpAuthStart & McpAuthAttempt & { callbackUrl: string };
    switch (method) {
      case "admin.extensions.auth.start": return service.start(principal, params);
      case "admin.extensions.auth.status": return service.status(principal, params);
      case "admin.extensions.auth.submit": return service.submit(principal, params);
      default: return service.cancel(principal, params);
    }
  }]));
}
