// Exercise actual log sinks while values change, then prove closed sinks receive no push or live-redactor deliveries.
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '@plur1bus/config-schema';
import { flatTestInternals } from '../../helpers/flat-embedder.ts';
const runtime = await import('../../../src/secrets/runtime.ts');
let registry: ReturnType<typeof runtime.createCoreSecretStore>['redaction'];
let deliveries = 0;
mock.module(new URL('../../../src/secrets/runtime.ts', import.meta.url).href, { namedExports: {
  ...runtime,
  createCoreSecretStore(options: Parameters<typeof runtime.createCoreSecretStore>[0]) {
    const store = runtime.createCoreSecretStore(options);
    registry = store.redaction;
    const subscribe = registry.subscribe.bind(registry);
    registry.subscribe = sink => subscribe((value, info) => { deliveries++; sink(value, info); });
    const redactor = registry.redactor.bind(registry);
    registry.redactor = options => {
      const live = redactor(options);
      return {
        text(value: string): string { deliveries++; return live.text(value); },
        value<T>(value: T): T { deliveries++; return live.value(value); },
      };
    };
    return store;
  },
} });
const logging = await import('../../../src/logs/writer.ts');
const writers: ReturnType<typeof logging.createWriter>[] = [];
mock.module(new URL('../../../src/logs/writer.ts', import.meta.url).href, { namedExports: {
  ...logging,
  createWriter(options: Parameters<typeof logging.createWriter>[0]) {
    const writer = logging.createWriter(options); writers.push(writer); return writer;
  },
} });
const { createCore } = await import('../../../src/core.ts');
const home = mkdtempSync(join(tmpdir(), 'p1b-redaction-life-'));
const cfg = defaults(); cfg.agents.main = {}; cfg.models.scan.enabled = false;
cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, reranker: { enabled: false } };
writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
const core = createCore({ home, testInternals: flatTestInternals() });
try {
  await core.start();
  const before = randomUUID(), after = randomUUID(), publicText = 'public lifecycle detail';
  registry!.register(before);
  assert.ok(writers.length >= 2, 'exercise the real diagnostic and discovery/output writers');
  for (const [index, writer] of writers.entries()) { writer.writeLegacy('warn', `${publicText} ${index} ${before}`); writer.flush(); }
  const text = () => readdirSync(join(home, 'logs')).filter(name => name.endsWith('.log'))
    .map(name => readFileSync(join(home, 'logs', name), 'utf8')).join('\n');
  assert.ok(!text().includes(before), 'every live writer masks newly registered values');
  for (const index of writers.keys()) assert.ok(text().includes(`${publicText} ${index}`), 'each writer persisted its own record');
  assert.ok(deliveries >= 2, 'the observer exercises real secret deliveries to active log sinks');
  await core.stop();
  const closed = text();
  deliveries = 0;
  registry!.register(after);
  for (const writer of writers) assert.throws(() => writer.writeLegacy('warn', after), /closed/);
  assert.equal(deliveries, 0, 'closed log sinks release subscriptions and never consult the live redactor');
  assert.equal(text(), closed, 'registration after shutdown writes nothing');
} finally { await core.stop(); rmSync(home, { recursive: true, force: true }); }
