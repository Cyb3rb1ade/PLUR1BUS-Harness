// The steps of the keyring probe (keyring-probe.mjs) over a keyring in memory: what it asks of the two sides, in which
// order, and that it cleans up. The probe itself runs against real keyrings in CI only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACCOUNTS, NODE_VALUE, RUST_REPLACED, RUST_VALUE, SERVICE_PREFIX, entryOptions, probe } from './keyring-probe.mjs';

const SERVICE = `${SERVICE_PREFIX}test`;

/** An `Entry` class over one map, and a record of the options every entry was made with. */
function memory() {
  const items = new Map(), options = [];
  class Entry {
    constructor(service, account, o) { this.key = `${service}\u0000${account}`; options.push(o); }
    getPassword() { return items.get(this.key) ?? null; }
    setPassword(v) { items.set(this.key, v); }
    deletePassword() { return items.delete(this.key); }
  }
  const at = (account) => `${SERVICE}\u0000${account}`;
  return { Entry, items, options, at };
}

/** The Rust side as the probe target behaves. */
const rustOver = (m, log = []) => (phase) => {
  log.push(phase);
  if (phase === 'first') {
    assert.equal(m.items.get(m.at('node-wrote')), NODE_VALUE, 'node wrote before the first rust phase');
    m.items.set(m.at('node-wrote'), RUST_REPLACED);
    m.items.set(m.at('rust-wrote'), RUST_VALUE);
  } else {
    assert.equal(m.items.has(m.at('node-wrote')), false, 'node deleted before the second rust phase');
    m.items.delete(m.at('rust-wrote'));
  }
};

test('the steps hold over one keyring, in order, and nothing is left behind', () => {
  const m = memory(), phases = [], lines = [];
  probe({ Entry: m.Entry, rust: rustOver(m, phases), service: SERVICE, platform: 'darwin', log: (l) => lines.push(l) });
  assert.deepEqual(phases, ['first', 'second']);
  assert.equal(m.items.size, 0);
  assert.equal(lines.length, 8);
  assert.ok(m.options.every((o) => o === undefined), 'no options outside Linux');
});

test('on Linux every Node entry is pinned to the Secret Service', () => {
  assert.deepEqual(entryOptions('linux'), { linux: { store: 'secret-service' } });
  assert.equal(entryOptions('darwin'), undefined);
  assert.equal(entryOptions('win32'), undefined);
  const m = memory();
  probe({ Entry: m.Entry, rust: rustOver(m), service: SERVICE, platform: 'linux' });
  assert.ok(m.options.length > 0 && m.options.every((o) => o?.linux?.store === 'secret-service'));
});

test('two sides that do not share a keyring fail, and the accounts are deleted all the same', () => {
  // Rust writes somewhere else: Node does not find `rust-wrote`.
  const m = memory();
  const elsewhere = () => {};
  assert.throws(() => probe({ Entry: m.Entry, rust: elsewhere, service: SERVICE }), /node reads what rust wrote: expected/);
  assert.equal(m.items.size, 0, 'what node wrote is gone');
  // Rust does not replace what Node wrote.
  const n = memory();
  assert.throws(() => probe({ Entry: n.Entry, rust: (phase) => { if (phase === 'first') n.items.set(n.at('rust-wrote'), RUST_VALUE); }, service: SERVICE }), /node reads what rust replaced/);
  assert.equal(n.items.size, 0);
  // A Rust phase that fails ends the probe; the second phase is not run.
  const o = memory(), phases = [];
  assert.throws(() => probe({ Entry: o.Entry, rust: (phase) => { phases.push(phase); throw new Error('the rust phase first failed (exit 101)'); }, service: SERVICE }), /exit 101/);
  assert.deepEqual(phases, ['first']);
  assert.equal(o.items.size, 0);
  // Something left under the service by an earlier run is not read as the start.
  const p = memory();
  p.items.set(p.at('node-wrote'), 'left behind');
  assert.throws(() => probe({ Entry: p.Entry, rust: rustOver(p), service: SERVICE }), /nothing under the service yet/);
});

test('the probe only takes a service of its own and the accounts it cleans are the ones it uses', () => {
  const m = memory();
  for (const service of ['plur1bus', 'plur1bus:home', SERVICE_PREFIX, '']) assert.throws(() => probe({ Entry: m.Entry, rust: () => {}, service }), /must begin with/, service);
  assert.deepEqual([...ACCOUNTS].sort(), ['node-wrote', 'rust-self', 'rust-wrote']);
});

test('without PLUR1BUS_KEYRING_PROBE=1 the script touches nothing and says why', () => {
  const env = { ...process.env };
  delete env.PLUR1BUS_KEYRING_PROBE;
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./keyring-probe.mjs', import.meta.url))], { env, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not asked for/);
  assert.equal(r.stdout, '');
});
