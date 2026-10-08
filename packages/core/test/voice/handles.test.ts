import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveHandles } from '../../src/voice/handles.ts';
import { Sensitive } from '../../src/openai-auth/ports.ts';
test('Live handle binds caller, expires, refuses replay and revokes both relay sides', async () => {
  let now = 1000, closed = 0; const audit: unknown[] = [];
  const binding = { person: 'owner', session: 'chat', model: 'gpt-live-1', surface: 'desktop:paired' };
  const handles = new LiveHandles({ clock: () => now, ttlSeconds: 60, audit: e => { audit.push(e); } });
  const issued = handles.issue(binding, async () => ({ send: async () => {}, close: async () => { closed++; } }));
  assert.equal(JSON.stringify(issued.handle).includes(issued.handle.value()), false);
  await assert.rejects(handles.redeem(issued.handle, { ...binding, person: 'other' }), { code: 'handle-binding' });
  await assert.rejects(handles.redeem(issued.handle, { ...binding, session: 'other' }), { code: 'handle-binding' });
  const channel = await handles.redeem(issued.handle, binding);
  await assert.rejects(handles.redeem(issued.handle, binding), { code: 'handle-replay' });
  await handles.revokeSession('chat', 'owner'); assert.equal(closed, 1);
  await assert.rejects(channel.send(new Uint8Array()), { code: 'handle-revoked' });
  const expired = handles.issue(binding, async () => channel); now += 60000;
  await assert.rejects(handles.redeem(expired.handle, binding), { code: 'handle-expired' });
  await assert.rejects(handles.redeem(new Sensitive('unknown'), binding), { code: 'handle-unknown' });
  assert.ok(audit.length >= 5);
});
test('revocation during asynchronous relay opening closes the resulting channel',async()=>{
  const binding={person:'owner',session:'s',model:'gpt-live-1',surface:'desktop:paired'};let release!:(c:{send:()=>Promise<void>;close:()=>Promise<void>})=>void,closed=0;
  const h=new LiveHandles({clock:()=>1000,ttlSeconds:60,audit:()=>{}});const issued=h.issue(binding,()=>new Promise(resolve=>{release=resolve;}));
  const opening=h.redeem(issued.handle,binding);await h.revokeSession('s','owner');release({send:async()=>{},close:async()=>{closed++;}});await assert.rejects(opening,{code:'handle-revoked'});assert.equal(closed,1);
});
