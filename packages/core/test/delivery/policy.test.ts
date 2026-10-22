import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessConfig } from '@plur1bus/config-schema';
import { deliveryAllowed } from '../../src/delivery/policy.ts';

const cfg = (channels: Record<string, unknown>) => ({ channels }) as unknown as HarnessConfig;
const tg = { channel: 'telegram', accountId: 'bot', userId: '123456789' };

test('a numeric Telegram allowlist entry admits its destination (ids compare as strings)', () => {
  assert.equal(deliveryAllowed(cfg({ telegram: { enabled: true, allowlist: [123456789] } }), tg), true);
  assert.equal(deliveryAllowed(cfg({ telegram: { enabled: true, allowlist: ['123456789'] } }), tg), true);
  assert.equal(deliveryAllowed(cfg({ telegram: { enabled: true, allowlist: [987654321, '42'] } }), tg), false);
});

test('a disabled channel, a missing list or a non-scalar entry allows nothing', () => {
  assert.equal(deliveryAllowed(cfg({ telegram: { enabled: false, allowlist: [123456789] } }), tg), false);
  assert.equal(deliveryAllowed(cfg({ telegram: { enabled: true } }), tg), false);
  assert.equal(deliveryAllowed(cfg({ telegram: { enabled: true, allowlist: [{ toString: () => '123456789' }] } }), tg), false);
  assert.equal(deliveryAllowed(cfg({}), tg), false);
});

test('direct-message channels read dmAllowlist, not allowlist', () => {
  const slack = { channel: 'slack', accountId: 'T1', userId: 'U1' };
  assert.equal(deliveryAllowed(cfg({ slack: { enabled: true, allowlist: ['U1'], dmAllowlist: [] } }), slack), false);
  assert.equal(deliveryAllowed(cfg({ slack: { enabled: true, dmAllowlist: ['U1'] } }), slack), true);
});
