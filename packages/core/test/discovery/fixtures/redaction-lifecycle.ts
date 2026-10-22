import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
    return store;
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
  registry!.register('lifetime-test-before-stop');
  assert.ok(deliveries >= 2, 'both live log sinks receive newly registered secrets');
  await core.stop();
  deliveries = 0;
  registry!.register('lifetime-test-after-stop');
  assert.equal(deliveries, 0, 'closed log sinks must be unsubscribed');
} finally { await core.stop(); rmSync(home, { recursive: true, force: true }); }
