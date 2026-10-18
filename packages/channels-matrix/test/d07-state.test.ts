import type { SyncSafetyState } from "../src/sync-safety.ts";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSyncTokenStore } from '../src/sync-store.ts';
import { Rig } from './helpers/rig.ts';
import { FakeMatrix, ROOM, ALICE, BOT, textMessage } from './helpers/fake-matrix.ts';

test('d07: legacy cursor migrates; durable claims and encryption survive a cursor-save gap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm4-sync-'));
  try {
    await writeFile(join(dir, 'matrix-sync.json'), JSON.stringify({ nextBatch: 's1' }));
    const store = new FileSyncTokenStore(dir);
    assert.deepEqual(await store.loadSafety(), { encryptedRooms: [], claimedEventIds: [] });
    await store.saveSafety({ encryptedRooms: [ROOM], claimedEventIds: ['$claimed'] });
    const reopened = new FileSyncTokenStore(dir);
    assert.equal(await reopened.load(), 's1');
    assert.deepEqual(await reopened.loadSafety(), { encryptedRooms: [ROOM], claimedEventIds: ['$claimed'] });
    assert.equal(JSON.parse(await readFile(join(dir, 'matrix-sync.json'), 'utf8')).version, 2);
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'matrix-sync.json'))).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('d07: resumed sync without encryption state refuses plaintext in an encrypted room', async () => {
  const fake = new FakeMatrix(); await fake.listen();
  fake.addRoom(ROOM, { encrypted: true, members: 3 });
  fake.rooms.get(ROOM)!.stateSent = true;
  const dir = await mkdtemp(join(tmpdir(), 'm4-encryption-'));
  const store = new FileSyncTokenStore(dir); await store.save('s1');
  const rig = new Rig(fake, {}, store);
  try {
    await rig.start();
    await fake.deliver(ROOM, [fake.message(ROOM, ALICE, textMessage(`${BOT} plaintext must be dropped`))]);
    await fake.waitIdle();
    assert.equal(rig.received.length, 0);
    assert.ok((await store.loadSafety()).encryptedRooms.includes(ROOM));
    assert.ok(fake.calls.some(c => c.path.includes('/state/m.room.encryption')));
  } finally { await rig.close(); await rm(dir, { recursive: true, force: true }); }
});

test('d07: a durable claim is checked before handlers even when the old cursor redelivers the event', async () => {
  const fake = new FakeMatrix(); await fake.listen(); fake.addRoom(ROOM, { members: 3 });
  const dir = await mkdtemp(join(tmpdir(), 'm4-dedupe-'));
  const store = new FileSyncTokenStore(dir); await store.save('s1');
  const event = fake.message(ROOM, ALICE, textMessage(`${BOT} already handled`));
  const rig = new Rig(fake, {}, store);
  try {
    await store.saveSafety({ encryptedRooms: [], claimedEventIds: [event.event_id!] });
    await rig.start(); await fake.deliver(ROOM, [event]); await fake.waitIdle();
    assert.equal(rig.received.length, 0);
  } finally { await rig.close(); await rm(dir, { recursive: true, force: true }); }
});

test('d07: an encryption transition in the timeline invalidates the cached plaintext state', async () => {
  const fake = new FakeMatrix(); await fake.listen(); fake.addRoom(ROOM, { members: 3 });
  const rig = new Rig(fake);
  try {
    await rig.start();
    await fake.deliver(ROOM, [{ type: 'm.room.encryption', state_key: '', event_id: '$encrypt', sender: ALICE, content: { algorithm: 'm.megolm.v1.aes-sha2' } }, fake.message(ROOM, ALICE, textMessage(`${BOT} no plaintext after encryption`))]);
    await fake.waitIdle(); assert.equal(rig.received.length, 0);
  } finally { await rig.close(); }
});

test('d07: more than 4096 claims from an uncommitted cursor survive restart', async () => {
  const { MemorySyncTokenStore } = await import('../src/sync-store.ts');
  class CursorGap extends MemorySyncTokenStore {
    failCursor = false; parked = false;
    override async save(token: string) { if (this.failCursor) { this.parked = true; throw new Error('cursor write interrupted'); } await super.save(token); }
  }
  const fake = new FakeMatrix(); await fake.listen(); fake.addRoom(ROOM, { members: 3 });
  const store = new CursorGap();
  const rig = new Rig(fake, { sleep: async (_ms, signal) => { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); } }, store);
  const events = Array.from({ length: 4100 }, () => fake.message(ROOM, ALICE, textMessage(`${BOT} one response`)));
  try {
    await rig.start(); store.failCursor = true;
    fake.deliverNoWait(ROOM, events);
    for (let i = 0; i < 20000 && !store.parked; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(store.parked, true); assert.equal(rig.received.length, 4100);
    assert.equal((await store.loadSafety()).claimedEventIds.length, 4100);
    await rig.ch.stop(); store.failCursor = false; rig.received.length = 0; rig.recreate(); await rig.start();
    await fake.deliver(ROOM, events); await fake.waitIdle(); assert.equal(rig.received.length, 0);
  } finally { await rig.close(); }
});

test('d07: a failed safety write parks the old cursor and invokes no handler', async () => {
  const { MemorySyncTokenStore } = await import('../src/sync-store.ts');
  class FailingSafety extends MemorySyncTokenStore {
    fail = false; failed = false;
    override async saveSafety(state: SyncSafetyState) {
      if (this.fail) { this.failed = true; throw new Error('disk unavailable'); }
      await super.saveSafety(state);
    }
  }
  const fake = new FakeMatrix(); await fake.listen(); fake.addRoom(ROOM, { members: 3 });
  const store = new FailingSafety();
  const rig = new Rig(fake, { sleep: async (_ms, signal) => { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); } }, store);
  try {
    await rig.start(); const before = await store.load(); store.fail = true;
    fake.deliverNoWait(ROOM, [fake.message(ROOM, ALICE, textMessage(`${BOT} do not lose the cursor`))]);
    for (let i = 0; i < 1000 && !store.failed; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(store.failed, true); assert.equal(rig.received.length, 0); assert.equal(await store.load(), before);
  } finally { await rig.close(); }
});
