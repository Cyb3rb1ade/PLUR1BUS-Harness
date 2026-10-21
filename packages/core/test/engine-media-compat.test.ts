import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '@plur1bus/config-schema';
import schema from '@cyb3rb1ade/plur1bus-memory/engine/config/engine-config.schema.json' with { type: 'json' };
import { buildEngineConfig } from '../src/engine-config.ts';
import { layout } from '../src/paths.ts';

test('owned media config never injects an unknown key into the actual installed public Engine schema',()=>{
  const cfg=defaults();cfg.memory.mediaEmbedding.enabled=true;
  cfg.engine.media={enabled:true,provider:'raw-must-not-override-owned'};
  const config=buildEngineConfig(cfg,layout('/tmp/h2-media-compat'));
  const supported=Object.hasOwn(schema.properties,'media');
  assert.equal(Object.hasOwn(config,'media'),supported);
  assert.equal(cfg.memory.mediaEmbedding.enabled,true);
  assert.equal((cfg.engine.media as {provider:string}).provider,'raw-must-not-override-owned');
});

// The schema argument is a trusted construction/test seam, never a config or RPC field.
test('public schema projection rejects missing/false media capability and maps a future object schema',()=>{
  const cfg=defaults();cfg.memory.mediaEmbedding.enabled=true;
  const l=layout('/tmp/h2-media-compat');
  for(const candidate of [null,{}, {properties:{}},{properties:{media:false}}]) assert.equal(Object.hasOwn(buildEngineConfig(cfg,l,candidate),'media'),false);
  const config=buildEngineConfig(cfg,l,{properties:{media:{type:'object'}}});
  assert.equal((config.media as {enabled:boolean}).enabled,true);
  assert.equal((config.media as {provider:string}).provider,'local-transformers');
});
