import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { CallBudget } from "../budget/calls.ts";
import type { PeerCallBudget, PeerBudgetLimits } from "../budget/peer.ts";
import type { Egress } from "../egress/index.ts";
import type { Context, SurfaceTrust } from "../policy/index.ts";
import type { AuditSink } from "../rbac/audit.ts";
import { ToolDispatcher, type ToolDispatcherDeps } from "./dispatcher.ts";
import { ToolRegistry } from "./registry.ts";
import { canonical, inCidr, parseAddress, parseCidr } from "./web/ip.ts";
import type { StoredA2aPeer } from "../a2a/peer-store.ts";
import { peerUrl } from "../a2a/peer-store.ts";
import { A2aPeerError } from "../a2a/peer-error.ts";

export interface A2aExecution {
  person: string; agent: string; session: string; turn: string; project: string;
  surface: SurfaceTrust; task?: string; policy: Partial<Context>;
}
export interface A2aTransportSettings extends PeerBudgetLimits {
  enabled: boolean; timeoutMs: number; maxCardBytes: number; maxRequestBytes: number; maxReplyBytes: number;
}
export interface PeerHttpResult { status: number; body: string; location?: string; contentType: string }
export interface PeerTransportDeps {
  settings(): A2aTransportSettings;
  localOnly(agentId: string): boolean;
  egress: Pick<Egress, "decide">;
  peerBudget: PeerCallBudget;
  budget: Pick<CallBudget, "checkBeforeCall" | "settle" | "releaseUnused">;
  audit: AuditSink;
  now(): number;
  dispatch: Omit<ToolDispatcherDeps, "registry" | "clock">;
  beforeDispatch?(): Promise<unknown>;
  credential?(name: string, peerId: string): Promise<{ value: string; release(): void }>;
}
const LOCAL = ["127.0.0.0/8", "::1/128", "100.64.0.0/10", "fd7a:115c:a1e0::/48"].map(c => parseCidr(c)!);
export function localA2aAddress(raw: string): boolean {
  const parsed = parseAddress(raw);
  if (!parsed) return false;
  const address = canonical(parsed);
  return !(address.family === 4 && Array.from(address.bytes).join(".") === "100.100.100.200") && LOCAL.some(c => inCidr(address, c));
}
const hash = (s: string): string => createHash("sha256").update(s).digest("hex");

/** One dispatcher admission, pinned connection, budget reservation and content-free audit per HTTP hop. */
export class A2aPeerTransport {
  readonly #d: PeerTransportDeps;
  constructor(d: PeerTransportDeps) { this.#d = d; }

  async request(peer: StoredA2aPeer, o: { url: string; method: "GET" | "POST"; body?: string; purpose: "card" | "message"; execution: A2aExecution; signal: AbortSignal; current(): boolean; captureCredential?(value: string): void }): Promise<PeerHttpResult> {
    const d = this.#d;
    let url = peerUrl(o.url);
    const origin = peerUrl(peer.cardUrl).origin;
    if (url.origin !== origin) throw new A2aPeerError("egress-denied");
    const inputBytes = Buffer.byteLength(o.body ?? "");
    if (inputBytes > d.settings().maxRequestBytes) throw new A2aPeerError("too-large");
    let deadline: number | undefined;
    for (let hop = 0; hop <= 3; hop++) {
      if (o.signal.aborted) throw new A2aPeerError("aborted");
      const settings = d.settings();
      if (!settings.enabled) throw new A2aPeerError("unavailable");
      const maxBytes = o.purpose === "card" ? settings.maxCardBytes : settings.maxReplyBytes;
      const thisUrl = url.toString();
      const registry = new ToolRegistry();
      registry.register({
        name: "peer.a2a_http", description: "Contact an explicitly registered A2A peer", capability: "network.a2a", effect: "network.a2a", risk: "medium", trust: "untrusted",
        inputSchema: { type: "object", additionalProperties: false, properties: { peer: { type: "string" }, method: { enum: ["GET", "POST"] }, urlHash: { type: "string" }, payloadHash: { type: "string" }, payloadBytes: { type: "integer" }, revision: { type: "string" } }, required: ["peer", "method", "urlHash", "payloadHash", "payloadBytes", "revision"] },
        limits: { timeoutMs: settings.timeoutMs, maxResultBytes: 1024 * 1024 },
        classify: () => ({ targets: [`a2a:${peer.id}`], flags: { outsideRoots: true, denyListHit: false } }),
        execute: async (_args, ctx): Promise<PeerHttpResult> => {
          if (!o.current()) throw new A2aPeerError("peer-revoked");
          if (!d.settings().enabled) throw new A2aPeerError("unavailable");
          deadline ??= d.now() + settings.timeoutMs;
          const remaining = Math.floor(deadline - d.now());
          if (remaining <= 0) throw new A2aPeerError("request-failed");
          const signal = AbortSignal.any([ctx.signal, o.signal, AbortSignal.timeout(remaining)]);
          // Discovery has no message tokens; every HTTP hop still consumes a call.
          const capacity = o.purpose === "card" ? 0 : inputBytes + maxBytes;
          const identity = { person: o.execution.person, agent: o.execution.agent, session: o.execution.session, turn: o.execution.turn, peer: peer.id };
          const allowance = d.peerBudget.reserve(identity, capacity, settings);
          if (allowance.kind !== "allow") throw new A2aPeerError("budget-exceeded");
          let reservation: string | undefined, written = false, finished = false;
          let lease: { value: string; release(): void } | undefined;
          try {
            const budget = d.budget.checkBeforeCall({ principal: identity.person, agent: identity.agent, project: o.execution.project, session: identity.session, turn: identity.turn, model: `a2a:${peer.id}`, provider: "a2a", estimatedInputTokens: o.purpose === "card" ? 0 : inputBytes, maxOutputTokens: o.purpose === "card" ? 0 : maxBytes });
            if (budget.kind !== "allow") throw new A2aPeerError("budget-exceeded");
            reservation = budget.reservationId;
            const pin = await d.egress.decide(thisUrl, { purpose: "a2a" });
            if (!pin.allowed) throw new A2aPeerError("egress-denied");
            if (d.localOnly(identity.agent) && !localA2aAddress(pin.address)) throw new A2aPeerError("local-only");
            if (peer.credentialSecret) {
              if (!d.credential) throw new A2aPeerError("unavailable");
              lease = await d.credential(peer.credentialSecret, peer.id);
              if (!lease.value || lease.value.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/.test(lease.value)) throw new A2aPeerError("unavailable");
              o.captureCredential?.(lease.value);
            }
            if (!o.current() || !d.settings().enabled) throw new A2aPeerError("peer-revoked");
            if (signal.aborted) throw new A2aPeerError("aborted");
            d.audit.append({ at: d.now(), actor: { user: identity.person, host: "core" }, action: "a2a.call", target: `a2a:${peer.id}`, detail: { origin: "a2a", kind: o.purpose, method: o.method, inputBytes } });
            const result = await pinnedRequest(url, pin, { method: o.method, ...(o.body !== undefined ? { body: o.body } : {}), ...(lease ? { token: lease.value } : {}), maxBytes, signal, onWrite: () => { written = true; } });
            const consumed = o.purpose === "card" ? 0 : inputBytes + Buffer.byteLength(result.body);
            d.peerBudget.finish(allowance.id, consumed);
            finished = true;
            d.budget.settle(reservation, { inputTokens: o.purpose === "card" ? 0 : inputBytes, outputTokens: o.purpose === "card" ? 0 : Buffer.byteLength(result.body) });
            return result;
          } catch (error) {
            // After a write the peer may have accepted the request; charge the
            // reserved bound, never refund unknown usage on timeout/disconnect.
            if (written && !finished) {
              d.peerBudget.finish(allowance.id, capacity);
              if (reservation) d.budget.settle(reservation, { inputTokens: o.purpose === "card" ? 0 : inputBytes, outputTokens: o.purpose === "card" ? 0 : maxBytes });
            } else if (!written) {
              d.peerBudget.cancel(allowance.id);
              if (reservation) d.budget.releaseUnused(reservation);
            }
            throw error instanceof A2aPeerError ? error : new A2aPeerError(signal.aborted ? "aborted" : "request-failed");
          } finally { try { lease?.release(); } catch { /* no peer data in diagnostics */ } }
        },
      });
      await d.beforeDispatch?.();
      const dispatcher = new ToolDispatcher({ ...d.dispatch, registry, clock: { now: d.now }, policyContext: ctx => ({ ...o.execution.policy, ...(d.dispatch.policyContext?.(ctx) ?? {}) }) });
      const reply = await dispatcher.call({ id: randomUUID(), name: "peer.a2a_http", args: { peer: peer.id, method: o.method, urlHash: hash(thisUrl), payloadHash: hash(o.body ?? ""), payloadBytes: inputBytes, revision: peer.revision } }, {
        agentId: o.execution.agent, principal: o.execution.person, sessionId: o.execution.session, turnId: o.execution.turn, ...(o.execution.task ? { taskId: o.execution.task } : {}), surface: o.execution.surface, signal: o.signal,
      });
      if (reply.isError) {
        const code = reply.error.sourceCode;
        if (code && ["peer-revoked", "egress-denied", "local-only", "budget-exceeded", "too-large", "aborted", "unavailable"].includes(code)) throw new A2aPeerError(code as import('../a2a/peer-error.ts').A2aPeerFailure);
        throw new A2aPeerError(reply.error.code === "tool-denied" || reply.error.code === "tool-not-approved" ? "approval-required" : o.signal.aborted ? "aborted" : "request-failed");
      }
      const result = reply.value as PeerHttpResult;
      if (result.status >= 300 && result.status < 400) {
        if (o.method !== "GET" || hop === 3 || !result.location) throw new A2aPeerError("request-failed");
        try { url = peerUrl(new URL(result.location, url).toString()); } catch { throw new A2aPeerError("egress-denied"); }
        if (url.origin !== origin) throw new A2aPeerError("egress-denied");
        continue;
      }
      if (result.status !== 200 || !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(result.contentType)) throw new A2aPeerError("request-failed");
      return result;
    }
    throw new A2aPeerError("request-failed");
  }
}

function pinnedRequest(url: URL, pin: { address: string; family: 4 | 6 }, o: { method: string; body?: string; token?: string; maxBytes: number; signal: AbortSignal; onWrite(): void }): Promise<PeerHttpResult> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request({
      hostname: url.hostname.replace(/^\[|\]$/g, ""), port: url.port || (url.protocol === "https:" ? 443 : 80), path: url.pathname, method: o.method, agent: false, signal: o.signal,
      maxHeaderSize: 16 * 1024,
      headers: { accept: "application/json", "accept-encoding": "identity", ...(o.body !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(o.body) } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => options.all ? callback(null, [{ address: pin.address, family: pin.family }]) : callback(null, pin.address, pin.family)) as never,
    }, response => {
      const chunks: Buffer[] = []; let size = 0;
      const fail = (code: "too-large" | "request-failed") => { response.destroy(); request.destroy(); reject(new A2aPeerError(code)); };
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { fail("request-failed"); return; }
      if (Number(response.headers['content-length'] ?? 0) > o.maxBytes) { fail("too-large"); return; }
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > o.maxBytes) fail("too-large"); else chunks.push(chunk); });
      response.on("error", () => reject(new A2aPeerError("request-failed")));
      response.on("end", () => {
        try {
          const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          resolve({ status: response.statusCode ?? 500, body, contentType: response.headers['content-type'] ?? "", ...(response.headers.location ? { location: response.headers.location } : {}) });
        } catch { reject(new A2aPeerError("request-failed")); }
      });
    });
    request.on("error", () => reject(new A2aPeerError(o.signal.aborted ? "aborted" : "request-failed")));
    // Once end is invoked usage is uncertain even if a socket error follows.
    o.onWrite();
    request.end(o.body);
  });
}
