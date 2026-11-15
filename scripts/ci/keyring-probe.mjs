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
//   1. Node writes the account `node-wrote`.
//   2. Rust (cargo test --test keyring_probe, phase `first`) reads it, replaces it and writes `rust-wrote`.
//   3. Node reads both and deletes `node-wrote`.
//   4. Rust (phase `second`) finds it gone and deletes `rust-wrote`.
//   5. Node finds `rust-wrote` gone.
//
// On Linux the Node side is pinned to the Secret Service. Left to itself @napi-rs/keyring falls back to the kernel
// keyring when no Secret Service answers (P4D-34), and the probe would then compare two different stores, or pass
// against none.
//
// @napi-rs/keyring is taken from PLUR1BUS_KEYRING_PROBE_MODULES (a directory with a node_modules of its own) or, absent
// that, from packages/core as the core itself loads it. `--rust <command>` replaces the cargo invocation (the tests of
// this script use it).
import { spawnSync } from 'node:child_process';
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

/** The steps, over an `Entry` constructor and a way to run a Rust phase. Returns the lines of its report; throws at
 *  the first step that does not hold. Whatever happens, the accounts of the service are deleted at the end. */
export function probe({ Entry, rust, service, platform = process.platform, log = () => {} }) {
  if (!service.startsWith(SERVICE_PREFIX) || service.length === SERVICE_PREFIX.length) throw new Error(`the service must begin with ${SERVICE_PREFIX}`);
  const entry = (account) => new Entry(service, account, entryOptions(platform));
  const expect = (what, got, want) => { if (got !== want) throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); log(`ok   ${what}`); };
  // `getPassword` answers null or undefined for an account that is not there.
  const absent = (v) => v === null || v === undefined;
  try {
    expect('node: nothing under the service yet', absent(entry('node-wrote').getPassword()), true);
    entry('node-wrote').setPassword(NODE_VALUE);
    expect('node reads what node wrote', entry('node-wrote').getPassword(), NODE_VALUE);
    rust('first');
    log('ok   rust read what node wrote, replaced it and wrote its own');
    expect('node reads what rust wrote', entry('rust-wrote').getPassword(), RUST_VALUE);
    expect('node reads what rust replaced', entry('node-wrote').getPassword(), RUST_REPLACED);
    expect('node deletes its account', entry('node-wrote').deletePassword(), true);
    rust('second');
    log('ok   rust found the account gone and deleted its own');
    expect('node finds what rust deleted gone', absent(entry('rust-wrote').getPassword()), true);
  } finally {
    for (const account of ACCOUNTS) { try { entry(account).deletePassword(); } catch { /* not there, or the keyring is gone */ } }
  }
}

/** The Rust phase as a child process: the probe target of plur1bus-core, asked with its two variables. */
export function cargoPhase(service, command = ['cargo', 'test', '--locked', '-p', 'plur1bus-core', '--test', 'keyring_probe']) {
  return (phase) => {
    const env = { ...process.env, PLUR1BUS_KEYRING_PROBE: phase, PLUR1BUS_KEYRING_PROBE_SERVICE: service };
    // The probe is for the system's keyring: no stand-in may be inherited.
    delete env.PLUR1BUS_SECRETS_KEYRING;
    const r = spawnSync(command[0], command.slice(1), { env, stdio: 'inherit' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`the rust phase ${phase} failed (exit ${r.status ?? r.signal})`);
  };
}

function loadEntry() {
  const modules = process.env.PLUR1BUS_KEYRING_PROBE_MODULES;
  const from = modules ? pathToFileURL(join(resolve(modules), 'package.json')) : new URL('../../packages/core/package.json', import.meta.url);
  return createRequire(from)('@napi-rs/keyring').Entry;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
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
    probe({ Entry: loadEntry(), rust: cargoPhase(service, command), service, log: (line) => console.log(line) });
    console.log('keyring probe: node and rust read and write the same items');
  } catch (e) {
    console.error(`keyring probe FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
