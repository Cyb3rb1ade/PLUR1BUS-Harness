import type { AuditPort, Clock, HttpPort, Sensitive, Region } from '../openai-auth/ports.ts';
export type VoiceProvider = 'openai:realtime' | 'openai:gpt-live';
export interface VoiceRequest {
  agent: string; user: string; provider: VoiceProvider;
  parent: { kind: 'api_key' | 'federated_token'; region: Region };
  surface: { authenticated: boolean; trust: 0 | 1 | 2 | 3; kind: 'desktop' | 'web' | 'channel' | 'group' };
  transport: 'webrtc' | 'websocket' | 'sip'; model: string; sdp?: string;
  delegation?: 'client' | 'responses'; instructions?: string;
}
export interface VoiceUsage { seconds: number; costMicros: number; inputTokens: number; outputTokens: number }
/** reserve is atomic for agent/user/installation daily+monthly ceilings, including concurrent session reservations.
 * record is idempotent by eventId, accounts deltas and returns false AT the ceiling, not only after it. */
export interface VoiceBudgetPort {
  reserve(request: { agent: string; user: string; reservation: string; model?: string; provider?: VoiceProvider }): Promise<boolean>;
  record(request: { agent: string; user: string; reservation: string; eventId: string; usage: VoiceUsage }): Promise<boolean>;
  release(reservation: string): Promise<void>;
}
export type VoiceEvent =
  | { type: 'tool.call'; callId: string; name: string; arguments: unknown }
  | { type: 'session.usage.updated' | 'response.done' | 'rate_limits.updated' | 'backend.usage'; eventId: string; seconds?: number; costMicros?: number; inputTokens?: number; outputTokens?: number }
  | { type: 'delegation.request'; requestId: string; payload: unknown }
  | { type: 'session.closed'; eventId?: string; seconds?: number; costMicros?: number; inputTokens?: number; outputTokens?: number };
export interface SidebandConnection { send(value: unknown): Promise<void>; close(): Promise<void> }
export interface VoicePorts {
  http: HttpPort; clock: Clock;
  credentials: { lease(parent: VoiceRequest['parent']): Promise<Sensitive> };
  models: { allowed(provider: VoiceProvider, model: string, parent: VoiceRequest['parent']): Promise<boolean> };
  budget: VoiceBudgetPort;
  policy: {
    authorize(request: { agent: string; user: string; callId: string; name: string; arguments: unknown }): Promise<boolean>;
    tool(request: { agent: string; user: string; name: string; arguments: unknown }): Promise<unknown>;
    /** Returns no implicit permission to overspend. Approval workflow owns once/T3 money.spend separately. */
    spend(request: { effect: 'money.spend'; agent: string; user: string; trust: 3; approval: 'once'; originTrust?: 0 | 1 | 2 | 3 }): Promise<void>;
    delegate?: (request: { agent: string; user: string; event: unknown; sessionId?: string }) => Promise<unknown>;
  };
  sideband: { attach(request: { url: string; authorization: Sensitive; instructions?: string; tracing: false; onEvent: (event: VoiceEvent) => Promise<void> }): Promise<SidebandConnection> };
  websocket?: { start(request: { url: string; authorization: Sensitive; firstMessage: { type: 'session.start'; session: Record<string, unknown> } }): Promise<{ id: string }> };
  sessions: { close(sessionId: string, provider: VoiceProvider, parent: VoiceRequest['parent']): Promise<void | { eventId: string; usage: VoiceUsage }> };
  audit: AuditPort;
  notice(request: { agent: string; user: string; spoken: string; written: string }): Promise<void>;
  /** Installation cap read at setup from vendor tier, never inferred from defaults. */
  capacity: number;
}
