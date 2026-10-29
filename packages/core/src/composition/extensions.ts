/** M-A7/A8: connect installed extension metadata, spawn-only leases and human setup to the live MCP registry.
 * Package code transactions use a local-token hold/release port; RPC inputs never choose secret names or file paths.
 */
import { apiPrincipal, isClientContext } from "@plur1bus/module-api";
import type { HarnessConfig } from "@plur1bus/config-schema";
import { createExtensionSecrets, buildExtensionSetupMethods, type ExtensionSetupMethod,
  type ExtensionSetupPrincipal } from "../extensions/secret-env.ts";
import { watchExtensionSecretChanges, reconcileNativeExtension } from "../extensions/secret-changes.ts";
import { installedExtensionSecretDefinition, verifyInstalledMcpPayload,
  type McpExtensionRuntime } from "../mcp/extension-metadata.ts";
import { McpExtensionReconciler } from "../mcp/extensions.ts";
import { createMcpRegistry } from "../mcp/index.ts";
import { McpClientError } from "../mcp/errors.ts";
import type { McpAuthProvider } from "../mcp/auth.ts";
import { McpAuthSessions, buildMcpAuthSessionMethods } from "../mcp/auth-sessions.ts";
import { createMcpFetch } from "../mcp/http.ts";
import { snapshotFromProcess } from "../auth/env.ts";
import { authorize } from "../rbac/authorize.ts";
import { ExtensionCapabilityFeed } from "../toolcall/extension-feed.ts";
import { connectionSurface } from "../rbac/connection-surface.ts";
import type { PrincipalResolver } from "../rbac/guard.ts";
import type { Principal } from "../rbac/types.ts";
import type { SurfaceTrustLevel } from "../rbac/surface.ts";
import type { Handler, CallContext } from "../rpc/server.ts";
import { RpcError } from "../rpc/errors.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { Egress } from "../egress/service.ts";
import type { HarnessLogger } from "../logger.ts";
import type { LogWriter } from "../logs/writer.ts";

/** One host-owned truth source supplies both OAuth readiness and the resource-bound provider. */
export interface ExtensionMcpAuth {
  ready(name: string): boolean;
  provider(name: string): McpAuthProvider | undefined;
  methods?: Record<string, Handler>;
  close?(): void | Promise<void>;
}

/** Trusted Core ports. Connection principals and surface attestations come from the actual Core resolver. */
export interface ExtensionCompositionOptions {
  home: string;
  config(): HarnessConfig;
  secrets: SecretStore;
  egress: Egress;
  logger: HarnessLogger;
  output: LogWriter;
  clock(): number;
  supervised?: boolean;
  configChanges?: (listener: () => void) => () => void;
  resolvePrincipal?: PrincipalResolver;
  surfaceOf?: (principal: Principal, ctx: CallContext) => SurfaceTrustLevel;
  runtime?: McpExtensionRuntime;
  auth?: ExtensionMcpAuth;
}

/** Compose the production registry and its RPC surface; construction starts no server and leases no credential value. */
export async function composeExtensions(options: ExtensionCompositionOptions) {
  const secrets = createExtensionSecrets({ home: options.home, store: options.secrets,
    definition: name => installedExtensionSecretDefinition(options.home, name) });
  let controller: McpExtensionReconciler | undefined;
  const ownedAuth = options.auth ? undefined : new McpAuthSessions({
    binding: name => {
      const remote = controller?.status(name)?.remote;
      return remote?.auth === "oauth" ? { resource: remote.url } : undefined;
    },
    fetch: createMcpFetch({ egress: options.egress }), env: snapshotFromProcess(), now: options.clock,
    authorize: (principal, action) => authorize(principal,
      action === "read" ? "extensions.read" : "extensions.manage", { kind: "system" }).effect === "allow",
    protect: value => options.secrets.redaction?.register(value),
    changed: (name, status) => {
      if (status === "authorized") void controller?.retry(name);
      else controller?.runtimeEvent({ server: name, state: "failed", params: { reason: "auth-required" } });
    },
  });
  const auth = options.auth ?? ownedAuth!;
  const registry = createMcpRegistry({ logger: options.logger, output: options.output, secrets: options.secrets,
    egress: options.egress,
    policy: { allowedCommands: (options.config().providers.mcp as { allowedCommands?: string[] } | undefined)
      ?.allowedCommands ?? [] },
    onEvent: event => controller?.runtimeEvent(event),
    auth: definition => controller?.isPackagedDefinition(definition) ? auth.provider(definition.name) : undefined,
    launchEnvironment: async (definition, signal) => {
      if (!controller?.isPackagedDefinition(definition)) return undefined;
      const extension = controller.status(definition.name)!;
      const current = () => {
        if (!controller?.isPackagedDefinition(definition)) {
          throw new McpClientError("not-registered", "MCP extension registration changed before launch");
        }
      };
      const verify = async () => {
        try { await verifyInstalledMcpPayload(options.home, extension, signal); }
        catch {
          if (!signal?.aborted && controller?.isPackagedDefinition(definition)) {
            controller.runtimeEvent({ server: definition.name, state: "failed", params: { reason: "integrity-failed" } });
          }
          throw new McpClientError("not-allowed", "MCP extension payload verification failed");
        }
        current();
      };
      await verify();
      const environment = await secrets.launchEnvironment(definition, signal);
      try {
        await verify();
        current();
        // Preserve the lease object's non-enumerable credential fields and redacted inspection behavior.
        if (environment) Object.defineProperty(environment, "validate", { value: current });
        return environment;
      } catch (error) {
        environment?.release();
        throw error;
      }
    },
  });
  const feed = options.supervised ? new ExtensionCapabilityFeed(options.home, undefined, ["mcp-server"]) : undefined;
  const runtime: McpExtensionRuntime = { ...options.runtime,
    oauthReady: name => auth.ready(name) && auth.provider(name) !== undefined };
  controller = new McpExtensionReconciler({ home: options.home, config: options.config, registry, runtime,
    availableSecretNames: () => secrets.availableSecretNames(),
    ...(feed ? { feed } : {}), ...(options.configChanges ? { onConfigChange: options.configChanges } : {}),
    degraded: reason => options.logger.warn("turn MCP unavailable", { reason }) });
  await controller.refresh();
  const runtimeController = controller;
  const changes = watchExtensionSecretChanges({ store: options.secrets, mcp: name => runtimeController.retry(name),
    deferred: name => options.logger.warn("extension reconciliation deferred", { name, reason: "runtime-unavailable" }),
    ...(options.supervised ? { native: (name: string) => reconcileNativeExtension(options.home, name) } : {}) });
  const unwatchPending = options.configChanges?.(() => changes.retryPending());

  const principalOf = async (ctx: CallContext, method: ExtensionSetupMethod,
    params: unknown): Promise<ExtensionSetupPrincipal> => {
    const principal = await options.resolvePrincipal?.(ctx, method, params);
    if (principal?.kind === "person" && principal.role === "owner") return {
      kind: "owner", id: principal.userId, surface: options.surfaceOf?.(principal, ctx) ??
        connectionSurface({ principal, now: options.clock() }),
    };
    if (principal?.kind === "person" && principal.role === "admin") return { kind: "admin", id: principal.userId };
    return { kind: "agent" };
  };
  const setup = buildExtensionSetupMethods({ service: secrets, principalOf });
  const requireLocalRuntimeOwner = async (ctx: CallContext, method: string, params: unknown) => {
    if (apiPrincipal(ctx) !== undefined || isClientContext(ctx)) {
      throw new RpcError("E_DENIED", "extension runtime control requires the local Core credential", {
        reason: "local-core-only",
      });
    }
    const principal = await options.resolvePrincipal?.(ctx, method, params);
    if (principal?.kind !== "person" || principal.role !== "owner") {
      throw new RpcError("E_DENIED", "extension runtime control requires the local Owner", { reason: "local-core-only" });
    }
  };
  const methods: Record<string, Handler> = {
    ...setup,
    "admin.extensions.setup.set": async (params: { name: string }, ctx) => {
      const result = await setup["admin.extensions.setup.set"](params, ctx);
      await runtimeController.retry(params.name);
      return result;
    },
    "admin.extensions.runtime.hold": async (params: { name: string }, ctx) => {
      await requireLocalRuntimeOwner(ctx, "admin.extensions.runtime.hold", params);
      return runtimeController.hold(params.name);
    },
    "admin.extensions.runtime.release": async (params: { name: string }, ctx) => {
      await requireLocalRuntimeOwner(ctx, "admin.extensions.runtime.release", params);
      return runtimeController.release(params.name);
    },
    "admin.extensions.runtime.status": async (params: { name: string }, ctx) => {
      await requireLocalRuntimeOwner(ctx, "admin.extensions.runtime.status", params);
      const status = runtimeController.status(params.name);
      return { name: params.name, ...(status?.overlay ? { overlay: status.overlay } : {}),
        ...(status?.reason ? { reason: status.reason } : {}) };
    },
    ...(ownedAuth ? buildMcpAuthSessionMethods(ownedAuth, options.resolvePrincipal ?? (() => null)) : options.auth?.methods),
  };
  return { registry, controller: runtimeController, methods, retryPending: () => changes.retryPending(), async close() {
    unwatchPending?.();
    changes.close();
    let failure: unknown;
    for (const close of [() => runtimeController.close(), () => feed?.close(),
      () => registry.shutdown(), () => auth.close?.()]) {
      try { await close(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  } };
}
