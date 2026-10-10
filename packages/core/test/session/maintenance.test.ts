import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaults } from '../../../config-schema/src/index.ts';
import { sessionMaintenance, sessionRoleFactory } from '../../src/session/maintenance.ts';
import { createTurnProvider } from '../../src/composition/provider.ts';
import { createCallBudget, PriceBook, SHIPPED_PRICE_TABLES } from '../../src/budget/index.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { openSessionService } from '../../src/session/service.ts';
import type { AgentRegistry } from '../../src/agents.ts';
import { createLogger } from '../../src/logger.ts';
import type { ChatRequest as WireRequest } from '../../../providers/src/index.ts';
it('session composition consumes configuration and fake catalogue windows, calibrates usage, then runs background summary', async () => {
  const home = mkdtempSync(join(tmpdir(),'compaction-maintenance-')); const config = defaults(); config.modelRoles.summarize = 'cheap'; config.session.compaction.prune.enabled = false;
  const budget = createCallBudget({ path:join(home,'budget.sqlite'),clock:{now:Date.now},prices:new PriceBook(SHIPPED_PRICE_TABLES) });
  const calls: string[] = []; const identity: boolean[] = [];
  const adapter = { async *stream(req: WireRequest) {
    calls.push(req.model); const text = req.model === 'gpt-4.1-mini' ? 'summary facts' : 'reply '.repeat(70);
    const input = Math.ceil(JSON.stringify(req.messages).length/4) + Math.ceil(JSON.stringify(req.tools ?? []).length/4);
    yield { type:'text_delta' as const,text }; yield { type:'done' as const,result:{ text,toolCalls:[],finishReason:'stop' as const,rawFinishReason:'stop',usage:{inputTokens:input,outputTokens:Math.ceil(text.length/4)},meta:{} } };
  } };
  const provider = sessionRoleFactory(createTurnProvider,config)({ profiles:{default:[{provider:'fixture',model:'gpt-4.1',adapter}],cheap:[{provider:'fixture',model:'gpt-4.1-mini',adapter}]},principal:req => { identity.push(Boolean(req.caller)); return req.principal!; },budget,registry:new ToolRegistry(),approval:{request:async () => ({approved:false})},grants:{get:()=>undefined,list:()=>[]},log:()=>{},resultStore:{put:async ()=>'result:fixture'} });
  const logger = createLogger({file:join(home,'logs','test.log'),level:'info',role:'test'});
  const maintenance = sessionMaintenance(home,config);
  const sessions = openSessionService({ ...maintenance, dbPath:join(home,'sessions.sqlite'),clock:Date.now,logger,agents:{} as AgentRegistry,isStopping:()=>false,provider:()=>provider,notify:()=>{},signal:new AbortController().signal,
    catalog:{read:()=>({models:[{provider:'fixture',id:'gpt-4.1',contextWindow:1000},{provider:'fixture',id:'gpt-4.1-mini',contextWindow:4000}]})},
    memory:{recall:async()=>({text:'',degraded:null}),capture:async()=>{},checkpoint:async()=>{}} });
  try {
    const session = sessions.store.createSession({kind:'direct',agentId:'a',owner:'user:v1:test'});
    for (let i=0;i<5;i++) {
      assert.equal((await sessions.runner.submit({session,caller:{channel:'cli',accountId:'local',userId:'owner'},text:'question '.repeat(45)}).done).state,'completed');
      await sessions.runner.idle();
    }
    assert.equal(sessions.compactor.configFor(session.id).windowTokens,1000);
    assert.ok(calls.includes('gpt-4.1-mini')); assert.ok(identity.every(Boolean),'background summary retains authenticated caller for canonical principal and budget resolution'); assert.ok(sessions.store.tokenCalibration('fixture/gpt-4.1') !== null);
    const summaries = sessions.store.listSummaries(session.id); assert.ok(summaries.length>0); assert.ok(summaries.every(s => s.tokens <= 150));
    assert.equal(sessions.store.listMessages(session.id).length,10);
  } finally { await sessions.close(); budget.close(); await logger.close(); rmSync(home,{recursive:true,force:true}); }
});
