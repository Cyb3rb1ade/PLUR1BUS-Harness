import type { HarnessConfig } from "@plur1bus/config-schema";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import type { Principal } from "../rbac/types.ts";
import type { AuditSink } from "../rbac/audit.ts";
import type { VoiceBroker } from "../voice/broker.ts";
import type { VoiceRequest } from "../voice/ports.ts";
import { OpenAIError } from "../openai-auth/ports.ts";
import { RpcError } from "./errors.ts";
import type { CallContext, Handler } from "./server.ts";

export interface VoiceSessionParams {
  agentId: string; provider: VoiceRequest["provider"]; model: string;
  transport: VoiceRequest["transport"]; sdp?: string;
}

/** All authority comes from the guarded connection and installation config, never RPC text.
 * This surface deliberately returns only the broker result. Ephemeral delivery needs a separate
 * authenticated direct-media boundary with provider-authenticated call-id attachment.
 */
export function buildVoiceSessionMethods(d: {
  config(): HarnessConfig; broker(): Pick<VoiceBroker, "create" | "close"> | undefined;
  hasAgent(id: string): boolean; clock(): number; audit: AuditSink;
  surface(principal: Principal, ctx: CallContext): 0 | 1 | 2 | 3;
}): Record<string, Handler> {
  return { "voice.session.create": async (p: VoiceSessionParams, ctx) => {
    const who = authenticatedPrincipal(ctx);
    if (who.kind !== "person") throw new RpcError("E_DENIED", "Voice sessions require a person");
    const trust = d.surface(who, ctx);
    if (trust < 2) throw new RpcError("E_DENIED", "Voice sessions require an authenticated T2+ surface", { reason: "surface-denied" });
    if (!d.hasAgent(p.agentId)) throw new RpcError("E_AGENT_UNKNOWN", "Unknown agent");
    const profile = d.config().providers.openaiVoice as Record<string, unknown> | undefined;
    if (!profile || !["api_key", "federated_token"].includes(String(profile.kind))) throw new RpcError("E_NOT_AVAILABLE", "Configure an explicit OpenAI voice parent profile", { reason: "voice-parent-required" });
    const kind = profile.kind as VoiceRequest["parent"]["kind"];
    if (profile.billing_path !== (kind === "api_key" ? "api_key" : "workload")) throw new RpcError("E_DENIED", "Voice parent billing path does not match its credential kind", { reason: "voice-billing-path" });
    if (!["global", "us", "eu"].includes(String(profile.region))) throw new RpcError("E_INVALID_PARAMS", "Voice parent region must be global, us or eu");
    if (profile.licenceAccepted !== true) throw new RpcError("E_VOICE_LICENSE", "Confirm voice provider terms in the parent profile", { reason: "confirmation-required" });
    const broker = d.broker();
    if (!broker) throw new RpcError("E_VOICE_UNAVAILABLE", "Voice runtime is unavailable");
    if (ctx.signal.aborted) throw new RpcError("E_VOICE_UNAVAILABLE", "Voice request was cancelled");
    let created: string | undefined;
    try {
      const result = await broker.create({ agent: p.agentId, user: who.userId, provider: p.provider,
        model: p.model, transport: p.transport, ...(p.sdp === undefined ? {} : { sdp: p.sdp }),
        parent: { kind, region: profile.region as VoiceRequest["parent"]["region"] },
        surface: { authenticated: true, trust, kind: "web" }, delegation: "client" });
      created = result.sessionId;
      if (ctx.signal.aborted) throw new RpcError("E_VOICE_UNAVAILABLE", "Voice request was cancelled");
      d.audit.append({ at: d.clock(), actor: { user: who.userId, host: "core" }, action: "voice.session.created", target: p.agentId,
        detail: { provider: p.provider, billing_path: profile.billing_path, region: profile.region } });
      // Project fields even if a future broker adds diagnostic or sensitive members.
      return { sessionId: result.sessionId, ...(result.sdpAnswer === undefined ? {} : { sdpAnswer: result.sdpAnswer }) };
    } catch (e) {
      if (created) await broker.close(created).catch(() => {});
      if (e instanceof RpcError) throw e;
      const budget = e instanceof OpenAIError && e.code === "budget-exceeded";
      throw new RpcError(budget ? "E_VOICE_BUDGET" : "E_VOICE_UNAVAILABLE", budget ? "Voice budget exhausted" : "Voice session could not be created");
    }
  } };
}
