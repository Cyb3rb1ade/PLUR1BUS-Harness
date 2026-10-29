// B8: actual HTTP API → delegated supervisor → bounded package worker → active MCP configuration.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createApiServer } from '../../src/server.ts';
import { createCoreLink } from '../../src/core-link.ts';

const [home, packagePath] = process.argv.slice(2);
if (!home || !packagePath || process.env.PLUR1BUS_ALLOW_TEST_INTERNALS !== '1') throw new Error('test fixture arguments required');
const link = createCoreLink(home);
const ownerToken = randomBytes(32).toString('hex');
const api = createApiServer({ home, core: link, ownerToken });
const { url } = await api.listen();
const responses = [];
try {
  const login = await fetch(url + '/api/v1/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: ownerToken }) });
  assert.equal(login.status, 200);
  await login.text();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const write = async (path, body) => {
    const csrf = await fetch(url + '/api/v1/csrf', { headers: { cookie } });
    assert.equal(csrf.status, 200);
    const { token } = await csrf.json();
    return fetch(url + path, { method: 'POST', headers: { cookie, 'x-csrf-token': token,
      ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) },
    body: body instanceof FormData ? body : JSON.stringify(body) });
  };
  const rpc = async (method, params) => {
    const response = await write('/rpc', { jsonrpc: '2.0', id: 'fixture', method, params });
    assert.equal(response.status, 200);
    const reply = await response.json(); responses.push(reply);
    assert.ok(reply.result, `actual ${method} must succeed`);
    return reply.result;
  };
  const bytes = await readFile(packagePath);
  const form = new FormData(); form.append('file', new Blob([bytes]), '../../ignored-browser-name.p1x');
  const uploaded = await write('/api/v1/extensions/upload', form);
  assert.equal(uploaded.status, 200);
  const upload = await uploaded.json(); responses.push(upload);
  assert.match(upload.uploadId, /^[A-Za-z0-9_-]{43}$/);
  const inspected = await write('/api/v1/extensions/inspect', { source: { upload: upload.uploadId } });
  assert.equal(inspected.status, 200);
  const inspection = await inspected.json(); responses.push(inspection);
  assert.equal(inspection.manifest.name, 'web-mcp');
  assert.equal(inspection.trust.tier, 'first-party');
  assert.deepEqual(await rpc('ext.inspection.get', { inspectionId: inspection.inspectionId }), inspection);
  const installed = await rpc('ext.install', { inspectionId: inspection.inspectionId,
    acknowledge: ['capabilities'], enable: { agents: 'all' } });
  assert.equal(installed.name, 'web-mcp'); assert.equal(installed.state, 'enabled');
  await rpc('ext.enable', { name: 'web-mcp', agents: 'all', acknowledge: ['capabilities'] });
  const shown = await rpc('ext.show', { name: 'web-mcp' });
  assert.equal(shown.item.kind, 'mcp-server');
  const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
  assert.deepEqual(config.mcp.servers['web-mcp'], { enabled: true, agents: 'all' });
  const state = JSON.parse(await readFile(join(home, 'extensions', 'state.json'), 'utf8'));
  assert.equal(state.items['web-mcp'].activeVersion, '1.0.0');
  assert.ok((await readFile(join(home, 'mcp', 'web-mcp', '1.0.0', 'p1x.json'), 'utf8')).includes('web-mcp'));
  assert.deepEqual(await readdir(join(home, 'run', 'uploads')), []);
  const output = JSON.stringify(responses);
  assert.ok(!output.includes(home) && !output.includes(ownerToken), 'responses must contain no private paths or credentials');
  assert.ok(!output.includes('sourcePath'));
  process.stdout.write(JSON.stringify({ upload: true, inspect: true, confirmation: true, install: true, enabled: true }) + '\n');
} finally { await api.close(); await link.close(); }
