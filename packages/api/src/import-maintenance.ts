/** Temporary authority for one already authorized import, never a general Core role fallback. */
import { validateParams, validateResult } from "@plur1bus/rpc-schema";
import type { ApiPrincipal } from "@plur1bus/module-api";
import type {
  AdminImportAbortResult,
  AdminImportStatusResult,
  ImportProgress,
} from "../../rpc-schema/generated/types.ts";
import { authorize } from "./rbac-bridge.ts";
import { rpcFailure } from "./rpc-route.ts";
import type { Session, SessionStore } from "./session.ts";

export interface ImportMaintenanceIdentity {
  runId: string;
  principal: ApiPrincipal;
  connectionKey: string;
}
/** Native implementations must verify the API credential + exact initiating person + active run before every operation. */
export interface ImportMaintenancePort {
  status(identity: ImportMaintenanceIdentity): Promise<AdminImportStatusResult>;
  abort(identity: ImportMaintenanceIdentity): Promise<AdminImportAbortResult>;
  subscribe?(
    identity: ImportMaintenanceIdentity,
    progress: (value: ImportProgress) => void,
    closed: () => void,
  ): Promise<() => void>;
}
export interface MaintenanceAdmission extends ImportMaintenanceIdentity {
  sessionId: string;
  session: Session;
  credentialVersion: number;
  authVersion: number;
  expiresAt: number;
  status?: AdminImportStatusResult;
  offlineSeen?: boolean;
  deviceProof?: object;
  deviceBinding?: string;
}
const terminal = (state: string): boolean => ["completed", "aborted", "failed"].includes(state);
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const methods = new Set(["admin.import.status", "admin.import.abort", "admin.import.runs"]);
const proofRefused = (error: unknown): boolean =>
  ["E_DENIED", "E_UNAUTHORIZED", "E_NOT_FOUND"].includes((error as { error?: string } | null)?.error ?? "");
/** Only transport loss or the typed Core stopping lifecycle admit a run fallback; authority and trust/storage refusals do not. */
export function coreTransportUnavailable(error: unknown): boolean {
  const value = error as { error?: unknown; reason?: unknown; code?: unknown } | null;
  const transport = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"]);
  if (!value) return false;
  // A typed authority refusal wins even if a nested error also carries an operating-system code.
  if (value.error !== undefined)
    return (
      value.error === "E_CORE_UNAVAILABLE" &&
      [...transport, "closed", "connect-timeout", "call-timeout", "core-stopping"].includes(String(value.reason))
    );
  return transport.has(String(value.code));
}
interface ContextOptions {
  sessions: SessionStore;
  now(): number;
  credentialVersion(userId: string): number | undefined;
  /** Trusted API-private imports-purpose provenance only; object identity must remain valid throughout this run. */
  importSessionProof?(session: Session, principal: ApiPrincipal): object | undefined;
  port: ImportMaintenancePort;
  ttlMs?: number;
}
export class ImportMaintenanceContext {
  readonly #entries = new Map<Session, MaintenanceAdmission>();
  readonly #off: () => void;
  readonly options: ContextOptions;
  constructor(options: ContextOptions) {
    this.options = options;
    this.#off = options.sessions.onEnd((session) => {
      this.#entries.delete(session);
    });
  }
  close(): void {
    this.#off();
    this.#entries.clear();
  }
  remember(input: ImportMaintenanceIdentity & { sessionId: string; session: Session }): void {
    const { session, principal } = input;
    const deviceProof = session.device ? this.options.importSessionProof?.(session, principal) : undefined;
    if (
      (session.device && !deviceProof) ||
      this.options.sessions.peek(input.sessionId) !== session ||
      !idPattern.test(input.runId) ||
      authorize(principal, "imports.manage", { kind: "system" }).effect !== "allow"
    )
      return;
    const credentialVersion = this.options.credentialVersion(principal.userId);
    if (credentialVersion === undefined || !Number.isSafeInteger(credentialVersion)) return;
    // A repeated status/reload cannot extend the original run's authority window.
    const prior = this.#entries.get(session);
    if (prior?.runId === input.runId) return;
    for (const held of this.#entries.values()) this.valid(held);
    if (this.#entries.size >= 32) return;
    this.#entries.set(session, {
      ...input,
      principal: structuredClone(principal),
      credentialVersion,
      authVersion: session.authVersion,
      ...(deviceProof ? { deviceProof, deviceBinding: this.deviceBinding(session) } : {}),
      expiresAt: Math.min(
        session.absoluteExpiresAt,
        this.options.now() + Math.min(4500000, this.options.ttlMs ?? 4500000),
      ),
    });
  }
  private deviceBinding(session: Session): string {
    const device = session.device;
    return JSON.stringify(
      device ? [device.deviceId, device.userId, device.expiresAt, [...device.scopes].sort()] : null,
    );
  }
  valid(entry: MaintenanceAdmission): boolean {
    try {
      if (
        this.#entries.get(entry.session) === entry &&
        this.options.sessions.peek(entry.sessionId) === entry.session &&
        (entry.deviceProof
          ? !!entry.session.device &&
            entry.session.device.userId === entry.principal.userId &&
            entry.session.device.expiresAt > this.options.now() &&
            this.deviceBinding(entry.session) === entry.deviceBinding &&
            this.options.importSessionProof?.(entry.session, entry.principal) === entry.deviceProof
          : !entry.session.device) &&
        !entry.session.mustRotate &&
        entry.session.authVersion === entry.authVersion &&
        this.options.now() < entry.expiresAt &&
        this.options.credentialVersion(entry.principal.userId) === entry.credentialVersion
      )
        return true;
    } catch {
      /* storage failure never grants cached authority */
    }
    this.#entries.delete(entry.session);
    return false;
  }
  revoke(session: Session): void {
    this.#entries.delete(session);
  }
  observe(session: Session, principal: ApiPrincipal, authVersion: number): void {
    const entry = this.#entries.get(session);
    if (
      entry &&
      (entry.offlineSeen ||
        entry.authVersion !== authVersion ||
        entry.principal.userId !== principal.userId ||
        entry.principal.kind !== principal.kind ||
        entry.principal.role !== principal.role ||
        JSON.stringify(entry.principal.tokenScopes) !== JSON.stringify(principal.tokenScopes))
    )
      this.revoke(session);
  }
  async admit(
    sessionId: string | undefined,
    routeId: string,
    body?: unknown,
  ): Promise<MaintenanceAdmission | undefined> {
    const session = this.options.sessions.peek(sessionId),
      entry = session && this.#entries.get(session);
    if (!entry || !this.valid(entry)) return undefined;
    const request = body as
      { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> } | null | undefined;
    if (routeId === "web.rpc") {
      if (
        !request ||
        request.jsonrpc !== "2.0" ||
        !(typeof request.id === "string" || Number.isSafeInteger(request.id)) ||
        typeof request.method !== "string" ||
        !methods.has(request.method) ||
        !validateParams(request.method, request.params ?? {}).ok
      )
        return undefined;
      if (request.method !== "admin.import.runs" && request.params?.runId !== entry.runId) return undefined;
    } else if (!["csrf.issue", "whoami", "web.events", "session.delete", "sessions.revoke-all"].includes(routeId))
      return undefined;
    if (["session.delete", "sessions.revoke-all"].includes(routeId)) return entry; // own logout never depends on native availability
    try {
      const status = await this.options.port.status(entry);
      if (!this.valid(entry) || !validateResult("admin.import.status", status).ok || status.run.runId !== entry.runId) {
        this.revoke(entry.session);
        return undefined;
      }
      if (terminal(status.run.state) && routeId !== "web.rpc") {
        this.revoke(session!);
        return undefined;
      }
      entry.status = status;
      entry.offlineSeen = true;
      return entry;
    } catch (error) {
      if (proofRefused(error)) this.revoke(entry.session);
      return undefined;
    }
  }
  async dispatch(admitted: MaintenanceAdmission, body: unknown): Promise<Record<string, unknown>> {
    // Admit returns a snapshot; validate the original entry against current local credentials again at the write boundary.
    const entry = this.#entries.get(admitted.session),
      request = body as { id: unknown; method: string; params?: Record<string, unknown> };
    if (!entry || !this.valid(entry))
      return rpcFailure(request.id, { error: "E_UNAUTHORIZED", reason: "maintenance-session" });
    try {
      const status = admitted.status ?? (await this.options.port.status(entry));
      let result: unknown;
      if (request.method === "admin.import.status") result = status;
      else if (request.method === "admin.import.runs") result = { runs: [status.run] };
      else if (
        request.method === "admin.import.abort" &&
        request.params?.runId === entry.runId &&
        !terminal(status.run.state)
      ) {
        result = await this.options.port.abort(entry);
        if (
          !validateResult("admin.import.abort", result).ok ||
          (result as AdminImportAbortResult).runId !== entry.runId
        )
          throw new Error("maintenance-result");
      } else return rpcFailure(request.id, { error: "E_DENIED", reason: "maintenance-operation" });
      if (terminal(status.run.state)) this.revoke(entry.session);
      return { jsonrpc: "2.0", id: request.id, result };
    } catch (error) {
      if (proofRefused(error)) this.revoke(entry.session);
      return rpcFailure(request.id, error);
    }
  }
}
