import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCoreLog } from '../../src/logs/bootstrap.ts';
import { validateRecord } from '../../../log-schema/src/index.ts';
it('the D111 bridge writes catalogue-valid compaction events with metadata only', async () => {
  const dir = mkdtempSync(join(tmpdir(),'compaction-events-'));
  const logger = createCoreLog({ dir,role:'core',source:{ kind:'harness',id:'core',version:'0.1.0' },timers:false });
  try {
    logger.info('compaction.summary.created',{ sessionId:'ses_example',fromSeq:1,toSeq:4,tier:1 });
    logger.info('compaction.prune.hidden',{ sessionId:'ses_example',ref:'event:2' });
    logger.info('compaction.prune.restored',{ sessionId:'ses_example',ref:'event:2' });
    await logger.close();
    const records = readFileSync(join(dir,'core.log'),'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s)).filter(r => r.event?.startsWith('compaction.'));
    assert.equal(records.length,3);
    for (const record of records) { assert.equal(validateRecord(record).ok,true); assert.ok(!('text' in record.attrs)); assert.ok(!('reason' in record.attrs)); }
  } finally { await logger.close(); rmSync(dir,{ recursive:true,force:true }); }
});
