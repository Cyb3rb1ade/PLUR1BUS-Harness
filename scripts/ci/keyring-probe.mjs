#!/usr/bin/env node
// The keyring probe (P4-20 PR 2b): the Rust adapters of crates/plur1bus-core/src/secrets/os_keyring.rs and the
// TypeScript side's @napi-rs/keyring against one real keyring, each reading what the other wrote.
//
//   PLUR1BUS_KEYRING_PROBE=1 node scripts/ci/keyring-probe.mjs
//
// It refuses to run without PLUR1BUS_KEYRING_PROBE=1: this writes to the keyring of the user who runs it, and that is
// for a CI runner, not for a developer's machine. It uses a service name of its own (`plur1bus-keyring-probe:<n>`) and
// deletes what it wrote, also when a step fails.
//
// The steps:
//   1. Rust alone (cargo test --test keyring_probe, phase `own`): a round trip, the keyring backend, and at the end
//      the account `rust-wrote`.
//   2. Node writes the account `node-wrote` and reads it.
//   3. Rust to Node: Node reads `rust-wrote`.
//   4. Node to Rust: Rust (phase `first`) reads `node-wrote` and replaces it; Node reads what Rust replaced.
//   5. Node deletes `node-wrote`; Rust (phase `second`) finds it gone and deletes `rust-wrote`; Node finds that gone.
//
// Every call into a keyring has a time limit, on both sides: the Rust target ends with status 3 when a step gets no
// answer, and every Node call runs in a process of its own (`--entry`). A keyring that asks the user, a prompt nobody
// answers on a runner, never returns. Steps 3 and 4 are tried independently, so that a run says for each direction
// whether it got an answer.
//
// On Linux the Node side is pinned to the Secret Service. Left to itself @napi-rs/keyring falls back to the kernel
// keyring when no Secret Service answers (P4D-34), and the probe would then compare two different stores, or pass
// against none.
//
//   node scripts/ci/keyring-probe.mjs --check-install <directory>
//
// touches no keyring: it compares what `npm install` put into <directory> with pnpm-lock.yaml. The workflow installs
// @napi-rs/keyring alone, from the public registry; every package it got must carry an integrity value the lock file
// of this repository knows, or it is not the package the core runs with.
//
// @napi-rs/keyring is taken from PLUR1BUS_KEYRING_PROBE_MODULES (a directory with a node_modules of its own) or, absent
// that, from packages/core as the core itself loads it. `--rust <command>` replaces the cargo invocation (the tests of
// this script use it).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

export const SERVICE_PREFIX = 'plur1bus-keyring-probe:';
// The values, the same in crates/plur1bus-core/tests/keyring_probe.rs. Plain words; nothing here is a credential.
export const NODE_VALUE = 'written by node: plain words, äöü, 鍵, 🔑';
export const RUST_VALUE = 'written by rust: plain words, ÄÖÜ, 錠, 🗝';
export const RUST_REPLACED = 'replaced by rust';
export const ACCOUNTS = ['node-wrote', 'rust-wrote', 'rust-self'];

/** The options every Node entry of the probe is made with. */
export function entryOptions(platform = process.platform) {
  return platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined;
}

/** A step that got no answer (a keyring that waits for a person), as opposed to a wrong one. */
export class NoAnswer extends Error {}

/** The steps, over an `Entry` constructor and a way to run a Rust phase. Returns nothing; throws at the first step
 *  that does not hold, and at the end when a direction between the two programs got no answer. Whatever happens, the
 *  accounts of the service are deleted at the end. */
export function probe({ Entry, rust, service, platform = process.platform, log = () => {} }) {
  if (!service.startsWith(SERVICE_PREFIX) || service.length === SERVICE_PREFIX.length) throw new Error(`the service must begin with ${SERVICE_PREFIX}`);
  const entry = (account) => new Entry(service, account, entryOptions(platform));
  const expect = (what, got, want) => { if (got !== want) throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); log(`ok   ${what}`); };
  // `getPassword` answers null or undefined for an account that is not there.
  const absent = (v) => v === null || v === undefined;
  // The two directions between the programs: one that gets no answer says nothing about the other.
  const open = [];
  const answered = (what, step) => {
    try { step(); return true; } catch (e) {
      if (!(e instanceof NoAnswer)) throw e;
      open.push(`${what} (${e.message})`);
      log(`OPEN ${what}: ${e.message}`);
      return false;
    }
  };
  try {
    rust('own');
    log('ok   rust alone: a round trip, the keyring backend, and an account for node');
    expect('node: nothing under the service yet', absent(entry('node-wrote').getPassword()), true);
    entry('node-wrote').setPassword(NODE_VALUE);
    expect('node reads what node wrote', entry('node-wrote').getPassword(), NODE_VALUE);
    answered('node reads what rust wrote', () => expect('node reads what rust wrote', entry('rust-wrote').getPassword(), RUST_VALUE));
    if (answered('rust reads and replaces what node wrote', () => rust('first'))) {
      log('ok   rust read what node wrote and replaced it');
      answered('node reads what rust replaced', () => expect('node reads what rust replaced', entry('node-wrote').getPassword(), RUST_REPLACED));
    }
    expect('node deletes its account', entry('node-wrote').deletePassword(), true);
    rust('second');
    log('ok   rust found the account gone and deleted its own');
    expect('node finds what rust deleted gone', absent(entry('rust-wrote').getPassword()), true);
    if (open.length) throw new NoAnswer(`no answer from the keyring: ${open.join('; ')}`);
  } finally {
    for (const account of ACCOUNTS) { try { entry(account).deletePassword(); } catch { /* not there, or the keyring is gone */ } }
    // What the Rust side wrote under its own accounts and under the backend's service, should a phase have failed.
    try { rust('cleanup'); } catch { /* nothing more can be done from here */ }
  }
}

/** An `Entry` whose every call runs in a process of its own (this script, `--entry`) with a time limit. A call into a
 *  keyring that waits for a person never returns and cannot be taken back; a process can be ended. */
export function boundedEntry(command, limitMs = 30_000) {
  return class {
    constructor(service, account) { this.service = service; this.account = account; }
    call(op, value) {
      const r = spawnSync(command[0], [...command.slice(1), '--entry', op, this.service, this.account], { input: value ?? '', encoding: 'utf8', timeout: limitMs });
      if (r.error?.code === 'ETIMEDOUT') throw new NoAnswer(`node ${op} ${this.account}: no answer within ${limitMs / 1000} s`);
      if (r.error) throw r.error;
      if (r.status !== 0) throw new Error(`node ${op} ${this.account} failed (exit ${r.status ?? r.signal}): ${r.stderr.trim()}`);
      return JSON.parse(r.stdout);
    }
    getPassword() { return this.call('get'); }
    setPassword(value) { this.call('set', value); }
    deletePassword() { return this.call('delete'); }
  };
}

/** The packages of an npm `package-lock.json` whose integrity value is not in the text of pnpm-lock.yaml, and how many
 *  packages there were. Every installed package must be one the repository locks, byte for byte. */
export function installAgainstLock(packageLock, pnpmLockText) {
  const installed = Object.entries(packageLock.packages ?? {}).filter(([path]) => path !== '');
  const unknown = installed.filter(([, p]) => typeof p.integrity !== 'string' || !pnpmLockText.includes(p.integrity)).map(([path]) => path);
  return { count: installed.length, unknown };
}

/** The Rust phase as a child process: the probe target of plur1bus-core, asked with its two variables. */
export function cargoPhase(service, command = ['cargo', 'test', '--locked', '-p', 'plur1bus-core', '--test', 'keyring_probe']) {
  return (phase) => {
    const env = { ...process.env, PLUR1BUS_KEYRING_PROBE: phase, PLUR1BUS_KEYRING_PROBE_SERVICE: service };
    // The probe is for the system's keyring: no stand-in may be inherited.
    delete env.PLUR1BUS_SECRETS_KEYRING;
    const r = spawnSync(command[0], command.slice(1), { env, stdio: 'inherit' });
    if (r.error) throw r.error;
    if (r.status === 3) throw new NoAnswer(`the rust phase ${phase} got no answer from the keyring within its limit (exit 3)`);
    if (r.status !== 0) throw new Error(`the rust phase ${phase} failed (exit ${r.status ?? r.signal})`);
  };
}

function loadEntry() {
  const modules = process.env.PLUR1BUS_KEYRING_PROBE_MODULES;
  const from = modules ? pathToFileURL(join(resolve(modules), 'package.json')) : new URL('../../packages/core/package.json', import.meta.url);
  return createRequire(from)('@napi-rs/keyring').Entry;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]) && process.argv[2] === '--check-install') {
  const dir = resolve(process.argv[3] ?? '.');
  const lock = readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8');
  const { count, unknown } = installAgainstLock(JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')), lock);
  const main = Object.keys(JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')).packages).includes('node_modules/@napi-rs/keyring');
  if (!main || count < 2 || unknown.length) {
    console.error(`keyring probe: the installed packages are not the ones pnpm-lock.yaml locks (${count} installed, @napi-rs/keyring ${main ? 'present' : 'missing'}, unknown: ${unknown.join(', ') || 'none'})`);
    process.exit(1);
  }
  console.log(`keyring probe: ${count} installed packages, each with an integrity value of pnpm-lock.yaml`);
} else if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]) && process.argv[2] === '--entry') {
  // One call of one entry, for `boundedEntry`: the value of a write on stdin, the answer as JSON on stdout.
  const [op, service, account] = process.argv.slice(3);
  if (process.env.PLUR1BUS_KEYRING_PROBE !== '1' || !service?.startsWith(SERVICE_PREFIX) || service.length === SERVICE_PREFIX.length || !ACCOUNTS.includes(account)) {
    console.error('keyring probe: --entry is for the probe itself, on a CI runner, under a service and an account of its own');
    process.exit(2);
  }
  const entry = new (loadEntry())(service, account, entryOptions());
  if (op === 'get') console.log(JSON.stringify(entry.getPassword() ?? null));
  else if (op === 'set') { entry.setPassword(readFileSync(0, 'utf8')); console.log('null'); }
  else if (op === 'delete') console.log(JSON.stringify(entry.deletePassword()));
  else { console.error(`keyring probe: unknown --entry ${op}`); process.exit(2); }
} else if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.env.PLUR1BUS_KEYRING_PROBE !== '1') {
    console.error('keyring probe: not asked for. It writes to the keyring of the user who runs it; set PLUR1BUS_KEYRING_PROBE=1 on a CI runner.');
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const at = args.indexOf('--rust');
  const command = at >= 0 ? args.slice(at + 1) : undefined;
  const service = `${SERVICE_PREFIX}${process.pid}-${Date.now()}`;
  console.log(`keyring probe on ${process.platform}: service ${service}`);
  try {
    const Entry = boundedEntry([process.execPath, fileURLToPath(import.meta.url)]);
    probe({ Entry, rust: cargoPhase(service, command), service, log: (line) => console.log(line) });
    console.log('keyring probe: node and rust read and write the same items');
  } catch (e) {
    console.error(`keyring probe FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
