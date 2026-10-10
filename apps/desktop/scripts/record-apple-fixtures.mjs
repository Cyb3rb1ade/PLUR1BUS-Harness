#!/usr/bin/env node
// The Owner supplies an isolated HOME. Never start services or enumerate user objects.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const home = process.env.HOME;
if (!home || !home.includes('p1t-') || process.env.CFFIXED_USER_HOME !== home) throw new Error('Use an isolated p1t- HOME and matching CFFIXED_USER_HOME');
const destination = resolve(process.argv[2] ?? 'apps/desktop/src-tauri/tests/fixtures/apple/recorded');
const cli = '/usr/local/bin/container';
execFileSync('/usr/bin/codesign', ['--verify', '--strict', '-R', 'anchor apple generic and certificate leaf[subject.OU] = "UPBK2H6LZM"', cli], { timeout: 5000, stdio: 'ignore' });
mkdirSync(destination, { recursive: true });
const version = JSON.parse(execFileSync(cli, ['system', 'version', '--format', 'json'], { timeout: 5000, encoding: 'utf8' }));
writeFileSync(`${destination}/version.json`, JSON.stringify(version.map(({ appName, version }) => ({ appName, version })), null, 2) + '\n');
let status;
try { status = JSON.parse(execFileSync(cli, ['system', 'status', '--format', 'json'], { timeout: 5000, encoding: 'utf8' })); }
catch (error) { status = JSON.parse(String(error.stdout)); }
writeFileSync(`${destination}/status.json`, JSON.stringify({ status: status.status }, null, 2) + '\n');
writeFileSync(`${destination}/README.md`, 'Recorded public version/status only under isolated HOME. Image, volume, network, running/exited inspect, exec and reboot durability are not recorded by this script.\n');
