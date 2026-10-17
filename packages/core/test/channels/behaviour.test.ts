import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBehaviour, mergeBehaviour, permitsMessage, type BehaviourLayer } from '../../src/channels/behaviour.ts';

const channels = ['telegram', 'discord', 'matrix', 'buzz'];
const kinds = ['direct', 'dm', 'group', 'channel'] as const;
for (const channel of channels) for (const chatKind of kinds) for (let level = 0; level < 4; level++) {
  test(`four-level matrix: ${channel}/${chatKind}/${level}`, () => {
    const restrictive: BehaviourLayer = { tools: { deny: ['exec'], allow: ['read'] }, memory: { allowedScopes: ['agent-private'] } };
    const layers = Array.from({ length: 4 }, (_, n) => n === level ? restrictive : {});
    const set = { default: layers[0]!, [chatKind === 'direct' || chatKind === 'dm' ? 'direct' : 'group']: layers[1]!, byChannelKind: { [channel]: layers[2] }, byBotConnection: { bot: layers[3] } };
    const r = resolveBehaviour(set, { channel, connection: 'bot', chatKind });
    assert.deepEqual(r.profile.tools.deny, ['exec']);
    assert.deepEqual(r.profile.tools.allow, ['read']);
    assert.deepEqual(r.profile.memory.allowedScopes, ['agent-private']);
    assert.ok(r.origins['tools.deny']?.includes(['default', chatKind === 'dm' ? 'direct' : chatKind === 'channel' ? 'group' : chatKind, `byChannelKind.${channel}`, 'byBotConnection.bot'][level]!));
  });
}

test('delivered group defaults and chat aliases are restrictive', () => {
  for (const chatKind of kinds) {
    const p = resolveBehaviour({}, { channel: 'matrix', chatKind }).profile;
    const group = chatKind === 'group' || chatKind === 'channel';
    assert.equal(p.reply.policy, group ? 'on-mention' : 'always');
    assert.equal(p.memory.capture, group ? 'provenance-only' : 'full');
    if (group) assert.equal(p.memory.captureOtherSpeakers, false);
  }
});

test('a narrower layer cannot re-enable replies, capture, tools, commands, scopes or rates', () => {
  const a: BehaviourLayer = { reply: { policy: 'never' }, memory: { capture: 'none', captureOtherSpeakers: false, allowedScopes: [] }, tools: { allow: [], deny: ['shell.*'] }, commands: { allow: [], deny: ['new'] }, capabilities: { allow: ['read'] }, rateLimits: { repliesPerHour: 0 } };
  const b: BehaviourLayer = { reply: { policy: 'always' }, memory: { capture: 'full', captureOtherSpeakers: true, allowedScopes: ['user'] }, tools: { allow: ['exec'], deny: [] }, commands: { allow: ['new'], deny: [] }, capabilities: { allow: ['read', 'write'] }, rateLimits: { repliesPerHour: 100 } };
  const r = mergeBehaviour([['a', a], ['b', b]]).profile;
  assert.equal(r.reply.policy, 'never'); assert.equal(r.memory.capture, 'none');
  assert.equal(r.memory.captureOtherSpeakers, false); assert.deepEqual(r.memory.allowedScopes, []);
  assert.deepEqual(r.tools.allow, []); assert.deepEqual(r.tools.deny, ['shell.*']);
  assert.deepEqual(r.commands.allow, []); assert.deepEqual(r.commands.deny, ['new']);
  assert.deepEqual(r.capabilities.allow, ['read']); assert.equal(r.rateLimits.repliesPerHour, 0);
});

test('property: every prefix has union denies, intersection scopes and never widens a participating layer', () => {
  let seed = 1729;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const universe = ['agent-private', 'workspace', 'user'] as const;
  for (let trial = 0; trial < 1000; trial++) {
    const layers: [string, BehaviourLayer][] = Array.from({ length: 4 }, (_, i) => [`layer${i}`, { tools: { deny: ['read', 'exec', 'write'].filter(() => random() < .5) }, memory: { allowedScopes: universe.filter(() => random() < .5) }, rateLimits: { repliesPerHour: Math.floor(random() * 100) } }]);
    const before = JSON.stringify(layers);
    const result = mergeBehaviour(layers).profile;
    assert.deepEqual(new Set(result.tools.deny), new Set(layers.flatMap(([, l]) => l.tools!.deny!)));
    assert.deepEqual(result.memory.allowedScopes, universe.filter(scope => layers.every(([, l]) => l.memory!.allowedScopes!.includes(scope))));
    for (const [, layer] of layers) assert.ok(result.rateLimits.repliesPerHour <= layer.rateLimits!.repliesPerHour!);
    assert.equal(JSON.stringify(layers), before);
  }
});

test('command and mention decisions use the effective profile', () => {
  const p = resolveBehaviour({ group: { commands: { deny: ['link'] } } }, { channel: 'matrix', chatKind: 'group' }).profile;
  assert.equal(permitsMessage(p, { chatKind: 'group', addressed: false, text: 'hello' }), false);
  assert.equal(permitsMessage(p, { chatKind: 'group', addressed: true, text: 'hello' }), true);
  assert.equal(permitsMessage(p, { chatKind: 'group', addressed: true, text: '/link code' }), false);
});
