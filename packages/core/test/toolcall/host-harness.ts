// Safe host-eval rig: real scratch file operations and policy, fake OS service/process ports. Never touches the desktop.
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { ToolDispatcher } from '../../src/tools/dispatcher.ts';
import { createFsTools } from '../../src/tools/fs/tools.ts';
import { canonicalisePath } from '../../src/policy/paths.ts';
import { HOST_TOOLS } from '../../src/host-tools/index.ts';
import { CAPABILITIES } from '../../src/policy/capabilities.ts';
import { classifyHostTool } from '../../src/host-tools/classify.ts';
import { makeCtx, isProg } from '../host-tools/helpers.ts';
import type { HostScenario, HostEvalHarness } from '../../src/toolcall/host-eval.ts';
export async function hostHarness(s: HostScenario): Promise<HostEvalHarness> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'd106-eval-')));
  const root = join(dir,'workspace'), home = join(dir,'home');
  await mkdir(root); await mkdir(join(root,'documents')); await writeFile(join(root,'documents','example.txt'),'example'); await mkdir(join(home,'run'),{recursive:true});
  await writeFile(join(root,'note.txt'),'old note');
  const roots = [{id:'workspace',path:root}], deny = [{name:'.env'}, {name:'.ssh'}, {path:join(root,'run')}, {path:join(home,'run')}];
  const registry = new ToolRegistry();
  for (const t of createFsTools({roots,deny,cwd:root}).tools) registry.register({...t,trust:'first-party',capability:t.effect==='read'?'fs.read':'fs.write',risk:'low',classify:async args=>{
    const raw=(args as {path:string}).path;
    const p=await canonicalisePath(raw,{roots,deny,cwd:root,access:'read',requireRoot:false});
    return p.ok?{flags:{outsideRoots:p.rootId===null,denyListHit:false},targets:[p.canonical]}:{flags:{outsideRoots:true,denyListHit:true}};
  },execute:async(args,ctx)=>{const r=await t.execute(args,ctx);if(r.isError)throw Error('file operation failed');return r.value;}});
  const {ctx,exec}=makeCtx('linux');
  exec.scripts.unshift({match:c=>isProg(c,'xdg-open'),exitCode:0});
  for(const t of HOST_TOOLS) registry.register({name:t.name,description:t.description,inputSchema:t.schema.input,capability:t.capability,effect:CAPABILITIES.get(t.capability)!.intrinsicEffect,risk:t.riskClass,trust:'first-party',classify:args=>classifyHostTool(t,args,{roots,deny}),execute:args=>t.run(args,ctx)});
  registry.register({name:'exec.run',description:'Fixture process port returns JSON result; no host process starts.',inputSchema:{type:'object',additionalProperties:false,required:['program','args','cwd'],properties:{program:{const:'fixture-process'},args:{type:'array',items:{type:'string'}},cwd:{const:'workspace'}}},capability:'shell.exec',effect:'local-write',risk:'medium',trust:'first-party',classify:()=>({flags:{outsideRoots:false}}),execute:async()=>({exitCode:0,stdout:JSON.stringify({result:42})})});
  const dispatcher=new ToolDispatcher({registry,grants:{list:()=>[],get:()=>undefined},approvals:{request:async()=>({approved:s.human==='approve'}),begin:()=>s.human==='approve'},clock:{now:Date.now}});
  return {registry,dispatcher,context:{agentId:'fixture-agent',principal:'fixture-person',sessionId:s.id,turnId:s.id,surface:2,signal:new AbortController().signal},verify: async results => { if(s.id==='edit-notes') return await readFile(join(root,'note.txt'),'utf8')==='new note'; if(s.id==='read-notes') return !results[0]!.isError && (results[0]!.value as {content:string}).content==='old note'; if(s.id==='process-result') return !results[0]!.isError && JSON.parse((results[0]!.value as {stdout:string}).stdout).result===42; return true; },close:()=>rm(dir,{recursive:true,force:true})};
}
