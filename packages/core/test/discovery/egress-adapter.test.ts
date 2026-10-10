import { it } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createPinnedClient } from '../../src/discovery/http.ts';
import { createEgress } from '../../src/egress/service.ts';
import { fakeHttp } from './helpers/fake-http.ts';
it('real egress denies before HTTP, pins approved IPs, and rechecks every redirect against live allowlists', async () => {
  let hosts: string[] = [];
  const egress = createEgress({ config: () => ({ allowHosts: hosts, allowPorts: [443], allowLoopback: false }), resolver: async () => [{ address: '93.184.216.34', family: 4 }] });
  const wire = fakeHttp(() => { hosts = []; return { status: 302, headers: { location: '/v1/next' } }; });
  const client = createPinnedClient({ baseUrl: 'https://provider.example/v1', lease: { origin: 'https://provider.example', headerName: 'Authorization', headerValue: 'Bearer synthetic' }, userAgent: 'fixture', egress, request: wire.request });
  await assert.rejects(client.get({ path: '/models' }), /egress_host-not-allowed/);
  assert.equal(wire.calls.length, 0);
  hosts = ['provider.example'];
  await assert.rejects(client.get({ path: '/models' }), /egress_host-not-allowed/);
  assert.equal(wire.calls.length, 1); assert.equal(wire.calls[0]?.address, '93.184.216.34');
  assert.equal(egress.status().decisions.denied, 2);
});
it('egress-backed scanner preserves decompression limits and userinfo redirect rejection', async () => {
  const egress = createEgress({ config: () => ({ allowHosts: ['provider.example'], allowPorts: [443], allowLoopback: false }), resolver: async () => [{ address: '93.184.216.34', family: 4 }] });
  const compressed = fakeHttp(() => ({ raw: gzipSync(Buffer.from('x'.repeat(1000))), headers: { 'content-encoding': 'gzip' } }));
  const options = { baseUrl: 'https://provider.example', lease: null, userAgent: 'fixture', egress };
  await assert.rejects(createPinnedClient({ ...options, request: compressed.request, limits: { maxBodyBytes: 50 } }).get({ path: '/models' }), /response_too_large/);
  const redirect = fakeHttp(() => ({ status: 302, headers: { location: 'https://user:password@provider.example/models' } }));
  await assert.rejects(createPinnedClient({ ...options, request: redirect.request }).get({ path: '/models' }), /bad_redirect/);
  assert.equal(redirect.calls.length, 1);
});
