import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./probe.js', import.meta.url), 'utf8');

async function runProbe(kind, base) {
  const websocketTargets = [], httpTargets = [], sseTargets = [];
  let run;
  const context = vm.createContext({
    SPIKE: { kind, base, direct: 'http://127.0.0.1:42000', key: 'ephemeral-test-key' },
    navigator: { userAgent: 'injected-behavior-test' },
    location: { origin: base, href: '' },
    performance, TextDecoder, URL, AbortSignal,
    setTimeout: () => 1, clearTimeout: () => {},
    addEventListener(event, callback) { if (event === 'DOMContentLoaded') run = callback; },
    window: { spikeSelfScript: true, __TAURI_INTERNALS__: { invoke: async () => 'capability-result' } },
    document: {
      cookie: '', createElement: () => ({}), head: { append(node) { node.onload(); } },
    },
    fetch: async target => {
      httpTargets.push(target);
      const body = new TextEncoder().encode('{}').buffer;
      return { ok: true, arrayBuffer: async () => body, json: async () => ({}) };
    },
    EventSource: class {
      constructor(target) {
        sseTargets.push(target);
        queueMicrotask(() => {
          this.onmessage({ data: '0' }); this.onmessage({ data: '1' });
        });
      }
      close() {}
    },
    WebSocket: class {
      constructor(target) {
        websocketTargets.push(target);
        if (!['ws:', 'wss:'].includes(new URL(target).protocol)) {
          throw new SyntaxError('unsupported WebSocket scheme');
        }
        queueMicrotask(() => this.onopen());
      }
      send(data) { queueMicrotask(() => this.onmessage({ data })); }
      close() {}
    },
  });
  vm.runInContext(source, context);
  await run();
  const report = JSON.parse(new URL(context.location.href).searchParams.get('data'));
  return { report, websocketTargets, httpTargets, sseTargets };
}

test('Windows-mapped custom base still measures literal custom URI and mapped WS separately', async () => {
  const observed = await runProbe('custom', 'http://plur1bus-harness.localhost');
  assert.deepEqual(observed.websocketTargets, [
    'plur1bus-harness://localhost/ws?key=ephemeral-test-key',
    'ws://plur1bus-harness.localhost/ws?key=ephemeral-test-key',
  ]);
  assert.equal(observed.report.websocket.outcome, 'constructor-rejected');
  assert.equal(observed.report.mappedWebsocket.outcome, 'echo');
  assert.equal(observed.report.websocket.target, 'plur1bus-harness://localhost/ws');
  assert.equal(observed.report.mappedWebsocket.target, 'ws://plur1bus-harness.localhost/ws');
  assert.ok(observed.httpTargets.every(target => /^http:\/\//.test(target)));
  assert.deepEqual(observed.sseTargets, [
    'http://plur1bus-harness.localhost/events?key=ephemeral-test-key',
    'http://127.0.0.1:42000/events?key=ephemeral-test-key',
  ]);
});

test('WK custom base preserves distinct targets and loopback uses its real proxy WS URL', async () => {
  const custom = await runProbe('custom', 'plur1bus-harness://localhost');
  assert.equal(custom.report.websocket.outcome, 'constructor-rejected');
  assert.equal(custom.report.mappedWebsocket.outcome, 'echo');
  assert.deepEqual(custom.sseTargets, [
    'plur1bus-harness://localhost/events?key=ephemeral-test-key',
    'http://127.0.0.1:42000/events?key=ephemeral-test-key',
  ]);
  const loopback = await runProbe('loopback', 'http://127.0.0.1:42000/proxy');
  assert.deepEqual(loopback.websocketTargets, ['ws://127.0.0.1:42000/proxy/ws?key=ephemeral-test-key']);
  assert.equal(loopback.report.websocket.outcome, 'echo');
  assert.equal(loopback.report.mappedWebsocket, undefined);
  assert.deepEqual(loopback.sseTargets, [
    'http://127.0.0.1:42000/proxy/events?key=ephemeral-test-key',
    'http://127.0.0.1:42000/events?key=ephemeral-test-key',
  ]);
});
