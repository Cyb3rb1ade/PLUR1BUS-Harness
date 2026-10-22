import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '@plur1bus/config-schema';
import { createHarnessHost } from '../../src/host.ts';
import { buildEngineConfig } from '../../src/engine-config.ts';
import { createAgentRegistry } from '../../src/agents.ts';
import { createLogger } from '../../src/logger.ts';
import { layout } from '../../src/paths.ts';
import { tempDir } from '../helpers/temp-dir.ts';

test('runtime host supplies Engine 1.19 codec capabilities before construction, maps only owned media config', async () => {
 const cfg=defaults();cfg.agents.main={};cfg.memory.mediaEmbedding.video.segmentSec=7;
 const l=layout(tempDir('h2-host-'));const reg=createAgentRegistry(cfg,l);reg.scaffold('main');
 const logger=createLogger({file:l.logFile('core'),level:'info',role:'core'});
 try {
 // Explicit future-contract schema fake: the actual pinned schema is separately regression-tested.
 const mediaSchema={properties:{media:{type:'object'}}};
 const config=buildEngineConfig(cfg,l,mediaSchema) as any;
 assert.equal(config.media.provider,'local-transformers');assert.equal(config.media.segmentMs,7000);
 assert.equal(config.media.cacheDir,l.models);
 cfg.memory.mediaEmbedding.dimensions=2;
 assert.equal((buildEngineConfig(cfg,l,mediaSchema) as any).media.enabled,false);
 cfg.memory.mediaEmbedding.dimensions=768;
 const host=createHarnessHost({layout:l,logger,config:cfg,engineConfig:config,agents:reg,events:()=>{}});
 assert.equal(Object.hasOwn(config,'media'),false,'no media model/config may reach Engine without a bound HostFetch');
 assert.equal(typeof host.capabilities!.mediaBudget,'function');
 assert.equal(host.capabilities!.mediaSourceRoot,join(l.home,'media'));
 assert.equal(await (host.capabilities!.mediaBudget as ()=>Promise<boolean>)(),true);
 } finally {await logger.close();}
});
