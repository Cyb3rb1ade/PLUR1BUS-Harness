import type { BehaviourLayer, BehaviourSet } from '../../../config-schema/src/behaviour.ts';
export type { BehaviourLayer, BehaviourSet } from '../../../config-schema/src/behaviour.ts';

export interface EffectiveBehaviour {
  reply: { policy: 'always' | 'on-mention' | 'never' };
  memory: { capture: 'full' | 'provenance-only' | 'none'; allowedScopes: ('agent-private' | 'workspace' | 'user')[]; captureOtherSpeakers: boolean; requireLinkedPrincipalForUserScope: boolean };
  commands: { allow: string[] | null; deny: string[] };
  tools: { allow: string[] | null; deny: string[] };
  capabilities: { allow: string[] | null; deny: string[] };
  rateLimits: { repliesPerHour: number; editsPerMinute: number; maxReplyChars: number };
}
export interface BehaviourContext { channel: string; connection?: string; chatKind: 'direct' | 'dm' | 'group' | 'channel' | 'broadcast'; chatId?: string }
export interface ResolvedBehaviour { profile: EffectiveBehaviour; origins: Record<string, string[]> }
const REPLY = ['always', 'on-mention', 'never'] as const;
const CAPTURE = ['full', 'provenance-only', 'none'] as const;

function initial(): EffectiveBehaviour {
  return {
    reply: { policy: 'always' }, memory: { capture: 'full', allowedScopes: ['agent-private', 'workspace', 'user'], captureOtherSpeakers: true, requireLinkedPrincipalForUserScope: false },
    commands: { allow: null, deny: [] }, tools: { allow: null, deny: [] }, capabilities: { allow: null, deny: [] },
    rateLimits: { repliesPerHour: 3600, editsPerMinute: 60, maxReplyChars: 65536 },
  };
}

/** A meet operation: minima for numeric budgets, union for denies, intersection for allows. Never mutates inputs. */
export function mergeBehaviour(layers: readonly (readonly [string, BehaviourLayer | undefined])[]): ResolvedBehaviour {
  const profile = initial();
  const origins: Record<string, string[]> = {};
  for (const [source, layer] of layers) {
    if (!layer) continue;
    const note = (key: string) => { (origins[key] ??= []).push(source); };
    if (layer.reply?.policy !== undefined) {
      if (REPLY.indexOf(layer.reply.policy) > REPLY.indexOf(profile.reply.policy)) profile.reply.policy = layer.reply.policy;
      note('reply.policy');
    }
    const m = layer.memory;
    if (m?.capture !== undefined) { if (CAPTURE.indexOf(m.capture) > CAPTURE.indexOf(profile.memory.capture)) profile.memory.capture = m.capture; note('memory.capture'); }
    if (m?.allowedScopes !== undefined) { profile.memory.allowedScopes = profile.memory.allowedScopes.filter(s => m.allowedScopes!.includes(s)); note('memory.allowedScopes'); }
    if (m?.captureOtherSpeakers !== undefined) { profile.memory.captureOtherSpeakers &&= m.captureOtherSpeakers; note('memory.captureOtherSpeakers'); }
    if (m?.requireLinkedPrincipalForUserScope !== undefined) { profile.memory.requireLinkedPrincipalForUserScope ||= m.requireLinkedPrincipalForUserScope; note('memory.requireLinkedPrincipalForUserScope'); }
    for (const kind of ['commands', 'tools', 'capabilities'] as const) {
      const l = layer[kind];
      if (l?.deny !== undefined) { profile[kind].deny = [...new Set([...profile[kind].deny, ...l.deny])]; note(`${kind}.deny`); }
      if (l?.allow !== undefined) { const prev = profile[kind].allow; profile[kind].allow = prev === null ? [...new Set(l.allow)] : prev.filter(v => l.allow!.includes(v)); note(`${kind}.allow`); }
    }
    for (const key of ['repliesPerHour', 'editsPerMinute', 'maxReplyChars'] as const) {
      const n = layer.rateLimits?.[key];
      if (n !== undefined) { profile.rateLimits[key] = Number.isSafeInteger(n) && n >= 0 ? Math.min(profile.rateLimits[key], n) : 0; note(`rateLimits.${key}`); }
    }
  }
  for (const section of Object.keys(profile) as (keyof EffectiveBehaviour)[]) for (const key of Object.keys(profile[section])) origins[`${section}.${key}`] ??= ['shipped.direct'];
  return { profile, origins };
}

export function resolveBehaviour(set: BehaviourSet, context: BehaviourContext): ResolvedBehaviour {
  const kind = context.chatKind === 'direct' || context.chatKind === 'dm' ? 'direct' : 'group';
  const group: BehaviourLayer = { reply: { policy: 'on-mention' }, memory: { capture: 'provenance-only', allowedScopes: ['agent-private', 'workspace'], captureOtherSpeakers: false, requireLinkedPrincipalForUserScope: true }, rateLimits: { repliesPerHour: 60, editsPerMinute: 20, maxReplyChars: 8192 } };
  return mergeBehaviour([
    ['shipped.direct', {}], ...(kind === 'group' ? [['shipped.group', group] as const] : []),
    ['default', set.default], [kind, set[kind]], [`byChannelKind.${context.channel}`, own(set.byChannelKind, context.channel)],
    [`byBotConnection.${context.connection ?? context.channel}`, own(set.byBotConnection, context.connection ?? context.channel)],
  ]);
}
function own(map: Record<string, BehaviourLayer | undefined> | undefined, key: string): BehaviourLayer | undefined {
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}

export function permitsMessage(profile: EffectiveBehaviour, input: { chatKind: string; addressed?: boolean; text: string; command?: string }): boolean {
  if (profile.reply.policy === 'never') return false;
  if (profile.reply.policy === 'on-mention' && input.addressed !== true) return false;
  const command = input.command ?? /^\/([a-z0-9_-]+)/i.exec(input.text.trim())?.[1]?.toLowerCase();
  return command === undefined || permitsName(profile.commands, command);
}
/** Literal allow entries deliberately avoid glob intersections; deny globs may only remove rights. */
export function permitsName(rule: { allow: readonly string[] | null; deny: readonly string[] }, name: string): boolean {
  return (rule.allow === null || rule.allow.includes(name)) && !rule.deny.some(pattern => {
    const parts = pattern.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^${parts.join('.*')}$`, 'i').test(name);
  });
}

/** Transport allowlists stay in adapters. All reply/command decisions have this single host-owned implementation. */
export function channelMessageAllowed(host: { behaviour?(input: BehaviourContext): ResolvedBehaviour } | null | undefined, input: BehaviourContext & { text: string; addressed?: boolean; command?: string }, legacy: 'mention' | 'always' | 'allowlist' = 'mention', allowlisted = false): boolean {
  const resolved = host?.behaviour?.(input);
  const profile = resolved?.profile ?? mergeBehaviour([['legacy', { reply: { policy: input.chatKind === 'direct' || input.chatKind === 'dm' || legacy === 'always' ? 'always' : 'on-mention' } }]]).profile;
  return permitsMessage(profile, { ...input, addressed: input.addressed === true || !resolved && legacy === 'allowlist' && allowlisted });
}

/** One output boundary for adapter sends and edits. A refusal never becomes a second message. */
export function channelOutputText(host: { output?(input: { channel: string; chatId: string; kind: 'reply' | 'edit'; text: string }): string | null } | null | undefined, channel: string, chatId: string, kind: 'reply' | 'edit', text: string): string {
  const out = host?.output ? host.output({ channel, chatId, kind, text }) : text;
  if (out === null || text.length > 0 && out.length === 0) throw new Error('channel behaviour output limit');
  return out;
}
