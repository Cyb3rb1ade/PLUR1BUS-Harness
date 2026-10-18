/** ADR-003's four levels. Empty allow sets deny everything; omitted sets impose no additional restriction. */
export interface BehaviourLayer {
  reply?: { policy?: 'always' | 'on-mention' | 'never' };
  memory?: { capture?: 'full' | 'provenance-only' | 'none'; allowedScopes?: ('agent-private' | 'workspace' | 'user')[]; captureOtherSpeakers?: boolean; requireLinkedPrincipalForUserScope?: boolean };
  commands?: { allow?: string[]; deny?: string[] };
  tools?: { allow?: string[]; deny?: string[] };
  capabilities?: { allow?: string[]; deny?: string[] };
  rateLimits?: { repliesPerHour?: number; editsPerMinute?: number; maxReplyChars?: number };
}
export interface BehaviourSet {
  default?: BehaviourLayer;
  direct?: BehaviourLayer;
  group?: BehaviourLayer;
  byChannelKind?: Record<string, BehaviourLayer | undefined>;
  byBotConnection?: Record<string, BehaviourLayer | undefined>;
}
