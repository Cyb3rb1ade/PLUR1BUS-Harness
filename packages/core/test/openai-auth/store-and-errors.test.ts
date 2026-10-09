import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secure } from '../secrets/helpers.ts';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { createSecretStore, createMemoryBackend, createFileBackend, createMemoryAuditSink } from '../../src/secrets/index.ts';
import { AuthService, createOpenAIHttp, LoopbackPkce } from '../../src/openai-auth/index.ts';
import { createAuthSecretStore } from '../../src/auth/secret-store.ts';
import { localOpenAI } from './local-server.ts';
const principal={owner:'owner',user:'owner',agentOwner:'owner',deployment:'local' as const};
test('D110 records survive encrypted-file fallback restart; all files secured, no plaintext tokens',async()=>{
  const local=await localOpenAI(),dir=await mkdtemp(join(tmpdir(),'d110-file-')),secured:string[]=[],audit=createMemoryAuditSink();
  const file=createFileBackend({dir,secure:(path,options)=>{secured.push(path);return secure(path,options);}});
  const secrets=createSecretStore({keyring:createMemoryBackend({available:false}),file,fileFallback:()=>true,audit});
  const options={store:createAuthSecretStore(secrets),http:createOpenAIHttp({egress:{decide:async()=>{throw Error('DNS forbidden');}},fetch:local.transport}),clock:{now:()=>local.fake.now},audit:()=>{}};
  const auth=new AuthService(options);let restarted:AuthService|undefined;
  try{
    const login=await auth.startLogin({principal});await local.authorize(login.authorizeUrl);const info=await auth.awaitLogin(login.loginId,principal);await auth.close();
    restarted=new AuthService(options);assert.equal((await restarted.listCredentials(principal))[0]!.id,info.id);await restarted.lease(info.id,principal);
    for(const name of await readdir(dir)){const path=join(dir,name),raw=await readFile(path,'utf8');for(const token of local.fake.secrets)assert.equal(raw.includes(token),false);if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600);}
    assert.ok(secured.length>0);await restarted.logout(info.id,principal);assert.deepEqual(await restarted.listCredentials(principal),[]);
  }finally{await auth.close();await restarted?.close();await local.close();await rm(dir,{recursive:true,force:true});}
});
for(const [flag,code] of [['state','state-mismatch'],['deny','access-denied']] as const)test('loopback '+code+' refuses storage',async()=>{
  const local=await localOpenAI();const {MemorySecrets}=await import('../fixtures/openai/server.ts');const store=new MemorySecrets();const auth=new AuthService({store,http:createOpenAIHttp({egress:{decide:async()=>{throw Error('DNS forbidden');}},fetch:local.transport}),clock:{now:()=>local.fake.now},audit:()=>{}});
  try{const login=await auth.startLogin({principal});await local.authorize(login.authorizeUrl,u=>{if(flag==='state')u.searchParams.set('state','wrong');else{u.searchParams.delete('code');u.searchParams.set('error','access_denied');}});await assert.rejects(auth.awaitLogin(login.loginId,principal),{code});assert.deepEqual(await auth.listCredentials(principal),[]);}finally{await auth.close();await local.close();}
});
test('loopback Origin gate ignores a foreign origin, then cancellation closes its listener',async()=>{
  const local=await localOpenAI();const {MemorySecrets}=await import('../fixtures/openai/server.ts');const auth=new AuthService({store:new MemorySecrets(),http:createOpenAIHttp({egress:{decide:async()=>{throw Error('DNS forbidden');}},fetch:local.transport}),clock:{now:()=>local.fake.now},audit:()=>{}});
  try{const login=await auth.startLogin({principal}),redirect=new URL(login.authorizeUrl.value()).searchParams.get('redirect_uri')!;const response=await fetch(redirect,{headers:{origin:'https://foreign.invalid'}});assert.equal(response.status,404);auth.cancelLogin(login.loginId,principal);await assert.rejects(auth.awaitLogin(login.loginId,principal),{code:'login-cancelled'});await assert.rejects(fetch(redirect));}finally{await auth.close();await local.close();}
});
test('failed native bind reports port-in-use and closes the one-shot listener',async()=>{
  class Occupied extends EventEmitter{closed=false;listen(){queueMicrotask(()=>this.emit('error',Object.assign(new Error(),{code:'EADDRINUSE'})));}closeAllConnections(){}close(cb:()=>void){this.closed=true;cb();}}
  const server=new Occupied(),pkce=new LoopbackPkce(async()=>{},()=>server as unknown as Server);await assert.rejects(pkce.redirect(),{code:'port-in-use'});assert.equal(server.closed,true);
});
