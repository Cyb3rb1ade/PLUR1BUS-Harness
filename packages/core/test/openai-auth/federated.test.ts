import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { FederatedCredential } from '../../src/openai-auth/federated.ts';
test('external file supplier expires, refreshes single-flight and never serializes token',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d110-federated-'));let now=1000000;const file=join(dir,'token.json');
  try{await writeFile(file,JSON.stringify({access_token:'synthetic-federated-token',expires_at:2000}));const credential=new FederatedCredential({file},()=>now);const leases=await Promise.all(Array.from({length:10},()=>credential.lease()));assert.ok(leases.every(v=>v===leases[0]));assert.equal(JSON.stringify(leases).includes('synthetic-federated-token'),false);assert.equal(inspect(leases).includes('synthetic-federated-token'),false);now=2000000;await assert.rejects(credential.lease(),{code:'auth-required'});await writeFile(file,JSON.stringify({access_token:'new-synthetic-token',expires_at:3000}));assert.equal((await credential.lease()).value(),'new-synthetic-token');}finally{await rm(dir,{recursive:true,force:true});}
});
test('external binary uses literal arguments, explicit environment, timeout, sanitized failures',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d110-command-'));const script=join(dir,'supplier.mjs');
  try{
    await writeFile(script,"if(process.env.DENIED_SECRET)throw Error('env leak');if(process.argv[2]!==\"$(touch NEVER)\")throw Error('argument changed');process.stdout.write(JSON.stringify({access_token:process.env.ALLOWED,expires_at:2000}));");
    process.env.DENIED_SECRET='synthetic-secret';
    const credential=new FederatedCredential({command:process.execPath,args:[script,'$(touch NEVER)'],environment:{ALLOWED:'literal-token'}},()=>1000000);assert.equal((await credential.lease()).value(),'literal-token');
    await assert.rejects(new FederatedCredential({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],timeoutMs:10},()=>1000000).lease(),{code:'auth-required'});
  }finally{delete process.env.DENIED_SECRET;await rm(dir,{recursive:true,force:true});}
});
