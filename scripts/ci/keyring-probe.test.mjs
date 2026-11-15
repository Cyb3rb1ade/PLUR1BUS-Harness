// The steps of the keyring probe (keyring-probe.mjs) over a keyring in memory: what it asks of the two sides, in which
// order, and that it cleans up. The probe itself runs against real keyrings in CI only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACCOUNTS, NODE_VALUE, NoAnswer, RUST_REPLACED, RUST_VALUE, SERVICE_PREFIX, boundedEntry, cargoPhase, entryOptions, installAgainstLock, probe } from './keyring-probe.mjs';

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
  if (phase === 'cleanup') return;
  if (phase === 'own') {
    m.items.set(m.at('rust-wrote'), RUST_VALUE);
  } else if (phase === 'first') {
    assert.equal(m.items.get(m.at('node-wrote')), NODE_VALUE, 'node wrote before the first rust phase');
    m.items.set(m.at('node-wrote'), RUST_REPLACED);
  } else {
    assert.equal(m.items.has(m.at('node-wrote')), false, 'node deleted before the second rust phase');
    m.items.delete(m.at('rust-wrote'));
  }
};

test('the steps hold over one keyring, in order, and nothing is left behind', () => {
  const m = memory(), phases = [], lines = [];
  probe({ Entry: m.Entry, rust: rustOver(m, phases), service: SERVICE, platform: 'darwin', log: (l) => lines.push(l) });
  assert.deepEqual(phases, ['own', 'first', 'second', 'cleanup'], 'the rust side cleans up last, whatever happened');
  assert.equal(m.items.size, 0);
  assert.equal(lines.length, 9);
  assert.ok(lines.every((l) => l.startsWith('ok   ')), 'nothing is open');
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
  assert.throws(() => probe({ Entry: n.Entry, rust: (phase) => { if (phase === 'own') n.items.set(n.at('rust-wrote'), RUST_VALUE); }, service: SERVICE }), /node reads what rust replaced/);
  assert.equal(n.items.size, 0);
  // A Rust phase that fails ends the probe; the second phase is not run.
  const o = memory(), phases = [];
  assert.throws(() => probe({ Entry: o.Entry, rust: (phase) => { phases.push(phase); throw new Error('the rust phase own failed (exit 101)'); }, service: SERVICE }), /exit 101/);
  assert.deepEqual(phases, ['own', 'cleanup'], 'no later phase; the cleanup is asked for all the same, and its own failure is swallowed');
  assert.equal(o.items.size, 0);
  // Something left under the service by an earlier run is not read as the start.
  const p = memory();
  p.items.set(p.at('node-wrote'), 'left behind');
  assert.throws(() => probe({ Entry: p.Entry, rust: rustOver(p), service: SERVICE }), /nothing under the service yet/);
});

test('a direction that gets no answer is reported as open, and the other one is tried all the same', () => {
  // Neither program gets at what the other wrote (a keyring that asks the user, and nobody is there).
  const m = memory(), phases = [], lines = [];
  class Asking extends m.Entry {
    getPassword() { if (this.key === m.at('rust-wrote') && m.items.has(this.key)) throw new NoAnswer('node get rust-wrote: no answer within 30 s'); return super.getPassword(); }
  }
  const rust = (phase) => { if (phase === 'first') { phases.push(phase); throw new NoAnswer('the rust phase first got no answer'); } rustOver(m, phases)(phase); };
  assert.throws(() => probe({ Entry: Asking, rust, service: SERVICE, log: (l) => lines.push(l) }), (e) => e instanceof NoAnswer && /node reads what rust wrote \(.*\); rust reads and replaces what node wrote \(/.test(e.message));
  assert.deepEqual(phases, ['own', 'first', 'second', 'cleanup'], 'both directions were tried, and the rest of the steps ran');
  assert.equal(lines.filter((l) => l.startsWith('OPEN ')).length, 2);
  assert.ok(!lines.some((l) => l.includes('rust replaced')), 'what rust did not replace is not read');
  assert.equal(m.items.size, 0);
  // One direction answers, the other does not: only that one is open.
  const n = memory();
  const oneWay = (phase) => { if (phase === 'first') throw new NoAnswer('the rust phase first got no answer'); rustOver(n)(phase); };
  assert.throws(() => probe({ Entry: n.Entry, rust: oneWay, service: SERVICE }), (e) => e instanceof NoAnswer && !e.message.includes('node reads what rust wrote') && e.message.includes('rust reads and replaces'));
  // No answer outside the two directions is a failure of the step, at once.
  const o = memory(), seen = [];
  assert.throws(() => probe({ Entry: o.Entry, rust: (phase) => { seen.push(phase); if (phase === 'own') throw new NoAnswer('the rust phase own got no answer'); }, service: SERVICE }), /phase own got no answer/);
  assert.deepEqual(seen, ['own', 'cleanup']);
});

test('a rust phase that ends with 3 got no answer; any other status is a failure', () => {
  const ending = (status) => cargoPhase(SERVICE, [process.execPath, '-e', `process.exit(${status})`]);
  assert.throws(() => ending(3)('first'), (e) => e instanceof NoAnswer && /phase first got no answer/.test(e.message));
  assert.throws(() => ending(101)('first'), (e) => !(e instanceof NoAnswer) && /exit 101/.test(e.message));
  ending(0)('first');
});

test('a Node entry call runs in a process of its own, with a limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keyring-probe-test-'));
  try {
    // A stand-in for `keyring-probe.mjs --entry`: echoes what it was asked, fails for one account, never answers for another.
    const script = join(dir, 'entry.mjs');
    writeFileSync(script, `import { readFileSync } from 'node:fs';
const [flag, op, service, account] = process.argv.slice(2);
if (account === 'silent') setInterval(() => {}, 1000);
else if (account === 'broken') { console.error('the keyring said no'); process.exit(1); }
else console.log(JSON.stringify(op === 'set' ? null : op === 'delete' ? true : [flag, service, account, readFileSync(0, 'utf8')]));
`);
    const Entry = boundedEntry([process.execPath, script], 400);
    assert.deepEqual(new Entry(SERVICE, 'node-wrote').getPassword(), ['--entry', SERVICE, 'node-wrote', '']);
    assert.equal(new Entry(SERVICE, 'node-wrote').setPassword(NODE_VALUE), undefined);
    assert.equal(new Entry(SERVICE, 'node-wrote').deletePassword(), true);
    assert.throws(() => new Entry(SERVICE, 'silent').getPassword(), (e) => e instanceof NoAnswer && /node get silent: no answer within 0.4 s/.test(e.message));
    assert.throws(() => new Entry(SERVICE, 'broken').getPassword(), (e) => !(e instanceof NoAnswer) && /the keyring said no/.test(e.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--entry is for the probe only: asked for, under a service and an account of its own', () => {
  const script = fileURLToPath(new URL('./keyring-probe.mjs', import.meta.url));
  const run = (env, ...args) => spawnSync(process.execPath, [script, '--entry', ...args], { env: { ...process.env, ...env }, encoding: 'utf8', input: '' });
  const bare = { ...process.env };
  delete bare.PLUR1BUS_KEYRING_PROBE;
  // Every one of these is refused before a keyring module is loaded.
  for (const r of [
    spawnSync(process.execPath, [script, '--entry', 'get', SERVICE, 'node-wrote'], { env: bare, encoding: 'utf8', input: '' }),
    run({ PLUR1BUS_KEYRING_PROBE: '1' }, 'get', 'plur1bus', 'node-wrote'),
    run({ PLUR1BUS_KEYRING_PROBE: '1' }, 'get', SERVICE_PREFIX, 'node-wrote'),
    run({ PLUR1BUS_KEYRING_PROBE: '1' }, 'get', SERVICE, '__plur1bus_index__'),
    run({ PLUR1BUS_KEYRING_PROBE: '1' }, 'get'),
  ]) {
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--entry is for the probe itself/);
    assert.equal(r.stdout, '');
  }
});

test('the probe only takes a service of its own and the accounts it cleans are the ones it uses', () => {
  const m = memory();
  for (const service of ['plur1bus', 'plur1bus:home', SERVICE_PREFIX, '']) assert.throws(() => probe({ Entry: m.Entry, rust: () => {}, service }), /must begin with/, service);
  assert.deepEqual([...ACCOUNTS].sort(), ['node-wrote', 'rust-self', 'rust-wrote']);
});

test('an install is the locked one only when every package carries an integrity value of the lock file', () => {
  const lock = "  '@napi-rs/keyring@2.1.0':\n    resolution: {integrity: sha512-AAAA==}\n  '@napi-rs/keyring-linux-x64-gnu@2.1.0':\n    resolution: {integrity: sha512-BBBB==}\n";
  const pkg = (integrity) => ({ version: '2.1.0', integrity });
  const good = { packages: { '': { name: 'keyring-node' }, 'node_modules/@napi-rs/keyring': pkg('sha512-AAAA=='), 'node_modules/@napi-rs/keyring-linux-x64-gnu': pkg('sha512-BBBB==') } };
  assert.deepEqual(installAgainstLock(good, lock), { count: 2, unknown: [] });
  // Another build of the same version, a package the lock does not know, and one without a value.
  const other = structuredClone(good);
  other.packages['node_modules/@napi-rs/keyring'].integrity = 'sha512-CCCC==';
  other.packages['node_modules/left-pad'] = pkg('sha512-DDDD==');
  other.packages['node_modules/no-value'] = { version: '1.0.0' };
  assert.deepEqual(installAgainstLock(other, lock), { count: 4, unknown: ['node_modules/@napi-rs/keyring', 'node_modules/left-pad', 'node_modules/no-value'] });
  assert.deepEqual(installAgainstLock({}, lock), { count: 0, unknown: [] });
});

test('without PLUR1BUS_KEYRING_PROBE=1 the script touches nothing and says why', () => {
  const env = { ...process.env };
  delete env.PLUR1BUS_KEYRING_PROBE;
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./keyring-probe.mjs', import.meta.url))], { env, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not asked for/);
  assert.equal(r.stdout, '');
});
