import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, win32 } from 'node:path';
import { parsePe, isApiSet } from './windows-pe.mjs';
import { diagnoseWindowsStartup, MAIN_MARKER, startupResult } from './windows-startup.mjs';

// Hand-authored PE fixtures with independent header/import/export layouts. No
// compiler, Windows installation, or user DLL is needed for these parser tests.
function peFixture({ wide = true, machine = wide ? 0x8664 : 0x14c, imports = [], exports = [], delayVa = false } = {}) {
  const bytes = Buffer.alloc(0x6200), pe = 0x80, optional = pe + 24;
  const optionalSize = wide ? 240 : 224, dirs = optional + (wide ? 112 : 96);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(pe, 0x3c);
  bytes.writeUInt32LE(0x4550, pe); bytes.writeUInt16LE(machine, pe + 4);
  bytes.writeUInt16LE(1, pe + 6); bytes.writeUInt16LE(optionalSize, pe + 20);
  bytes.writeUInt16LE(wide ? 0x20b : 0x10b, optional);
  const imageBase = wide ? 0x140000000n : 0x400000n;
  if (wide) bytes.writeBigUInt64LE(imageBase, optional + 24); else bytes.writeUInt32LE(Number(imageBase), optional + 28);
  bytes.writeUInt32LE(0x200, optional + 60); bytes.writeUInt32LE(16, dirs - 4);
  const section = optional + optionalSize;
  bytes.writeUInt32LE(0x6000, section + 8); bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x6000, section + 16); bytes.writeUInt32LE(0x200, section + 20);
  let next = 0x1000;
  const at = rva => 0x200 + rva - 0x1000;
  const allocate = size => { const start = next; next = (next + size + 7) & ~7; return start; };
  const string = value => { const start = allocate(value.length + 1); bytes.write(value, at(start), 'ascii'); return start; };
  for (const delayed of [false, true]) {
    const entries = imports.filter(item => !!item.delayed === delayed);
    if (!entries.length) continue;
    const stride = delayed ? 32 : 20, directory = allocate((entries.length + 1) * stride);
    bytes.writeUInt32LE(directory, dirs + (delayed ? 13 : 1) * 8);
    bytes.writeUInt32LE((entries.length + 1) * stride, dirs + (delayed ? 13 : 1) * 8 + 4);
    const va = delayed && delayVa;
    const ptr = value => value + (va ? Number(imageBase) : 0);
    entries.forEach((entry, index) => {
      const descriptor = at(directory + index * stride), name = string(entry.dll);
      const thunks = allocate((entry.symbols.length + 1) * (wide ? 8 : 4));
      if (delayed) {
        bytes.writeUInt32LE(va ? 0 : 1, descriptor); bytes.writeUInt32LE(ptr(name), descriptor + 4);
        bytes.writeUInt32LE(ptr(thunks), descriptor + 16);
      } else { bytes.writeUInt32LE(name, descriptor + 12); bytes.writeUInt32LE(thunks, descriptor); }
      entry.symbols.forEach((symbol, i) => {
        let value;
        if (symbol.ordinal != null) value = (1n << (wide ? 63n : 31n)) | BigInt(symbol.ordinal);
        else { const hintName = allocate(symbol.name.length + 3); bytes.write(symbol.name, at(hintName) + 2, 'ascii'); value = BigInt(ptr(hintName)); }
        if (wide) bytes.writeBigUInt64LE(value, at(thunks + i * 8)); else bytes.writeUInt32LE(Number(value), at(thunks + i * 4));
      });
    });
  }
  if (exports.length) {
    const directory = allocate(40), count = Math.max(...exports.map(item => item.ordinal));
    const named = exports.filter(item => item.name), functions = allocate(count * 4), names = allocate(named.length * 4), ordinals = allocate(named.length * 2);
    bytes.writeUInt32LE(1, at(directory) + 16); bytes.writeUInt32LE(count, at(directory) + 20);
    bytes.writeUInt32LE(named.length, at(directory) + 24); bytes.writeUInt32LE(functions, at(directory) + 28);
    bytes.writeUInt32LE(names, at(directory) + 32); bytes.writeUInt32LE(ordinals, at(directory) + 36);
    exports.forEach(item => bytes.writeUInt32LE(item.forwarder ? string(item.forwarder) : 0x5f00, at(functions + (item.ordinal - 1) * 4)));
    named.forEach((item, i) => { bytes.writeUInt32LE(string(item.name), at(names + i * 4)); bytes.writeUInt16LE(item.ordinal - 1, at(ordinals + i * 2)); });
    bytes.writeUInt32LE(directory, dirs); bytes.writeUInt32LE(next - directory, dirs + 4);
  }
  return bytes;
}

test('PE32 and PE32+ decode named/ordinal regular and delayed imports without executing a file', () => {
  for (const wide of [false, true]) {
    const image = parsePe(peFixture({ wide, imports: [
      { dll: 'KERNEL32.dll', symbols: [{ name: 'GetCurrentProcess' }, { ordinal: 12 }] },
      { dll: 'api-ms-win-core-file-l1-1-0.dll', delayed: true, symbols: [{ name: 'CreateFileW' }] },
    ] }));
    assert.equal(image.format, wide ? 'PE32+' : 'PE32');
    assert.deepEqual(image.imports, [
      { dll: 'KERNEL32.dll', apiSet: false, delayed: false, symbols: [{ name: 'GetCurrentProcess' }, { ordinal: 12 }] },
      { dll: 'api-ms-win-core-file-l1-1-0.dll', apiSet: true, delayed: true, symbols: [{ name: 'CreateFileW' }] },
    ]);
  }
  const legacy = parsePe(peFixture({ wide: false, delayVa: true, imports: [{ dll: 'legacy.dll', delayed: true, symbols: [{ name: 'LegacyEntry' }] }] }));
  assert.deepEqual(legacy.imports[0].symbols, [{ name: 'LegacyEntry' }]);
});

test('ARM64 architecture, ordinal-only exports and forwarded exports remain distinct metadata', () => {
  const image = parsePe(peFixture({ machine: 0xaa64, exports: [
    { ordinal: 1, name: 'Forwarded', forwarder: 'api-ms-win-example-l1-1-0.Target' }, { ordinal: 7 },
  ] }));
  assert.equal(image.architecture, 'arm64');
  assert.deepEqual(image.exports, [
    { ordinal: 1, names: ['Forwarded'], forwarder: 'api-ms-win-example-l1-1-0.Target' },
    { ordinal: 7, names: [], forwarder: null },
  ]);
  assert.equal(isApiSet('EXT-MS-WIN-NTUSER-WINDOW-L1-1-0.DLL'), true);
  assert.equal(isApiSet('kernel32.dll'), false);
});

test('truncated headers/tables and unbacked or unterminated imports fail boundedly', () => {
  const valid = peFixture({ imports: [{ dll: 'kernel32.dll', symbols: [{ name: 'Entry' }] }] });
  for (const length of [0, 63, 128, 180, 400, 520, 570]) assert.throws(() => parsePe(valid.subarray(0, length)), /Invalid PE/);
  const badRva = Buffer.from(valid); badRva.writeUInt32LE(0xfffff000, 0x98 + 112 + 8);
  assert.throws(() => parsePe(badRva), /unbacked RVA/);
  const badModule = peFixture({ imports: [{ dll: '../evil.dll', symbols: [{ ordinal: 2 }] }] });
  assert.throws(() => parsePe(badModule), /module name/);
  const noTerminator = Buffer.from(valid); noTerminator.writeUInt32LE(20, 0x98 + 112 + 12);
  assert.throws(() => parsePe(noTerminator), /unterminated descriptor/);
  const badOrdinal = Buffer.from(valid); badOrdinal.writeBigUInt64LE(0x8000000000010001n, 0x200 + 0x1038 - 0x1000);
  assert.throws(() => parsePe(badOrdinal), /Invalid PE/);
});

function diagnosticFixture(t, imports) {
  const root = mkdtempSync(join(tmpdir(), 'plur1bus-startup-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = 'C:\\fixture\\transport_spike.exe';
  const env = { SystemRoot: 'C:\\Windows', HOME: root, TEMP: root, PRIVATE_TEST_SECRET: 'do-not-persist-this-value' };
  const files = new Map([[executable.toLowerCase(), peFixture({ imports })]]);
  const options = { root, executable, cwd: root, env,
    child: { status: 3221225785, stdout: '', stderr: '', error: { message: env.PRIVATE_TEST_SECRET } } };
  const deps = { readFileVersions: paths => paths.map(path => ({ path, fileVersion: '10.0.1.0', status: 'read' })), readPeBytes: path => { const bytes = files.get(path.toLowerCase()); if (!bytes) throw Error('Unknown fixture'); return bytes; } };
  return { root, options, deps, files, artifact: name => JSON.parse(readFileSync(join(root, `native-${name}.json`), 'utf8')) };
}

test('API-set resolver results drive recursive missing-procedure/ordinal provenance without a physical API-set file', t => {
  const fixture = diagnosticFixture(t, [{ dll: 'api-ms-win-example-l1-1-0.dll', symbols: [{ name: 'Entry' }] }]);
  fixture.files.set('c:\\windows\\system32\\host.dll', peFixture({ imports: [{ dll: 'child.dll', symbols: [{ name: 'Missing' }, { ordinal: 7 }] }], exports: [{ ordinal: 1, name: 'Entry' }] }));
  fixture.files.set('c:\\windows\\system32\\child.dll', peFixture({ exports: [{ ordinal: 1, name: 'Unrelated' }] }));
  let calls = 0;
  fixture.deps.spawnSync = (program, args, options) => {
    calls++;
    assert.equal(program, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.ok(args.includes('-NoProfile')); assert.ok(args.includes('-NonInteractive'));
    assert.equal(options.env, fixture.options.env); assert.equal(options.cwd, fixture.root);
    assert.ok(options.timeout > 0 && options.timeout <= 12000);
    const request = JSON.parse(readFileSync(args.at(-1), 'utf8'));
    return { status: 0, stdout: JSON.stringify({ schema: 1, machine: 0x8664, modules: request.modules.map(item => ({
      dll: item.dll, resolvedPath: item.dll.startsWith('api-') ? 'C:\\Windows\\System32\\host.dll' : 'C:\\Windows\\System32\\child.dll',
      fileVersion: '10.0.1.0', symbols: item.symbols.map(symbol => ({ ...symbol, found: calls === 1, error: calls === 1 ? null : 127 })),
    })) }) };
  };
  const report = diagnoseWindowsStartup(fixture.options, fixture.deps);
  assert.equal(calls, 2); assert.equal(report.child.hexStatus, '0xC0000139');
  assert.equal(report.diagnostics.status, 'completed-helper-observations');
  const loader = fixture.artifact('loader-exports');
  assert.equal(loader.batches[0].modules[0].apiSet, true);
  assert.equal(loader.batches[0].modules[0].resolvedPath, 'C:\\Windows\\System32\\host.dll');
  assert.deepEqual(loader.findings.map(item => [item.dll, item.name ?? item.ordinal, item.error]), [['child.dll', 'Missing', 127], ['child.dll', 7, 127]]);
  assert.ok(loader.findings.every(item => item.architecture === 'x64' && item.declaredExport === false && item.fileVersion === '10.0.1.0'));
  assert.equal(fixture.artifact('pe-imports').length, 3);
});

test('helper architecture mismatch is a limitation, not a missing DLL/procedure finding', t => {
  const fixture = diagnosticFixture(t, [{ dll: 'kernel32.dll', symbols: [{ name: 'Entry' }] }]);
  fixture.deps.spawnSync = () => ({ status: 0, stdout: JSON.stringify({ schema: 1, machine: 0xaa64, modules: [] }) });
  const report = diagnoseWindowsStartup(fixture.options, fixture.deps);
  assert.equal(report.diagnostics.status, 'partial-helper-architecture-mismatch');
  assert.deepEqual(fixture.artifact('loader-exports').findings, []);
  assert.equal(report.child.unsignedStatus, 3221225785);
});

test('failed module initialization retains load error while mapped metadata follows a transitive export forwarder', t => {
  const fixture = diagnosticFixture(t, [{ dll: 'outer.dll', symbols: [{ name: 'Entry' }] }]);
  fixture.files.set('c:\\windows\\system32\\outer.dll', peFixture({ exports: [{ ordinal: 1, name: 'Entry', forwarder: 'api-ms-win-example-l1-1-0.#9' }] }));
  fixture.files.set('c:\\windows\\system32\\inner.dll', peFixture({ exports: [{ ordinal: 1, name: 'Existing' }] }));
  fixture.deps.spawnSync = (_, args) => {
    const query = JSON.parse(readFileSync(args.at(-1), 'utf8')).modules[0];
    const outer = query.dll === 'outer.dll';
    return { status: 0, stdout: JSON.stringify({ schema: 1, machine: 0x8664, modules: [{ dll: query.dll,
      resolvedPath: `C:\\Windows\\System32\\${outer ? 'outer' : 'inner'}.dll`, loadError: outer ? 127 : null,
      symbols: query.symbols.map(symbol => ({ ...symbol, found: outer ? null : false, error: outer ? null : 127 })),
    }] }) };
  };
  const report = diagnoseWindowsStartup(fixture.options, fixture.deps);
  assert.equal(report.child.hexStatus, '0xC0000139');
  const facts = fixture.artifact('loader-exports');
  assert.equal(facts.batches.length, 2);
  assert.equal(facts.batches[0].modules[0].symbols[0].found, null);
  assert.equal(facts.batches[0].modules[0].symbols[0].forwarder, 'api-ms-win-example-l1-1-0.#9');
  assert.equal(facts.findings[0].kind, 'module-load-failed-metadata-mapped');
  assert.equal(facts.findings[1].ordinal, 9); assert.equal(facts.findings[1].declaredExport, false);
});

test('non-null ordinal lookup cannot hide an export-table hole', t => {
  const fixture = diagnosticFixture(t, [{ dll: 'hole.dll', symbols: [{ ordinal: 2 }] }]);
  fixture.files.set('c:\\windows\\system32\\hole.dll', peFixture({ exports: [{ ordinal: 1 }, { ordinal: 3 }] }));
  fixture.deps.spawnSync = () => ({ status: 0, stdout: JSON.stringify({ schema: 1, machine: 0x8664, modules: [{ dll: 'hole.dll',
    resolvedPath: 'C:\\Windows\\System32\\hole.dll', symbols: [{ ordinal: 2, found: true }],
  }] }) });
  diagnoseWindowsStartup(fixture.options, fixture.deps);
  assert.equal(fixture.artifact('loader-exports').findings[0].kind, 'import-export-table-mismatch');
});

test('bounded helper timeout and arbitrary error output retain native failure and redact private input', t => {
  const fixture = diagnosticFixture(t, [{ dll: 'kernel32.dll', symbols: [{ name: 'Entry' }] }]);
  fixture.deps.spawnSync = () => ({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT', message: fixture.options.env.PRIVATE_TEST_SECRET }, stdout: fixture.options.env.PRIVATE_TEST_SECRET, stderr: fixture.options.env.PRIVATE_TEST_SECRET });
  const report = diagnoseWindowsStartup(fixture.options, fixture.deps);
  assert.equal(report.diagnostics.status, 'partial-helper-failed');
  assert.equal(report.child.status, 3221225785);
  assert.equal(fixture.artifact('loader-exports').batches[0].errorCode, 'ETIMEDOUT');
  for (const file of readdirSync(fixture.root)) assert.equal(readFileSync(join(fixture.root, file), 'utf8').includes(fixture.options.env.PRIVATE_TEST_SECRET), false);
});

test('exact first-line marker and unsigned status distinguish entry; successful child never triggers loader diagnosis', t => {
  assert.equal(startupResult({ status: -1073741511, stderr: `${MAIN_MARKER}\r\n` }).hexStatus, '0xC0000139');
  assert.equal(startupResult({ status: 2, stderr: `${MAIN_MARKER}\n` }).mainEntered, true);
  assert.equal(startupResult({ status: 2, stderr: `unrelated ${MAIN_MARKER}` }).mainEntered, false);
  const fixture = diagnosticFixture(t, []); fixture.options.child.status = 0;
  fixture.deps.spawnSync = () => { throw Error('Successful child must not run resolver'); };
  const report = diagnoseWindowsStartup(fixture.options, fixture.deps);
  assert.equal(report.child.status, 0); assert.equal(report.diagnostics.status, 'not-required-child-succeeded');
  assert.equal(report.executable.architecture, 'x64'); assert.equal(report.executable.sha256.length, 64);
});

test('diagnostic budget and malformed PE preserve the original startup failure without starting extra processes', t => {
  const fixture = diagnosticFixture(t, [{ dll: 'kernel32.dll', symbols: [{ name: 'Entry' }] }]);
  let times = 0;
  fixture.deps.now = () => times++ === 0 ? 0 : 46000;
  fixture.deps.spawnSync = () => { throw Error('Budget exhausted; no process allowed'); };
  assert.equal(diagnoseWindowsStartup(fixture.options, fixture.deps).diagnostics.status, 'partial-budget-limit');
  fixture.files.set(fixture.options.executable.toLowerCase(), Buffer.from('malformed diagnostic PE'));
  const failed = diagnoseWindowsStartup(fixture.options, fixture.deps);
  assert.equal(failed.child.hexStatus, '0xC0000139');
  assert.equal(failed.diagnostics.status, 'partial-diagnostic-error');
  assert.equal(failed.executable.sha256.length, 64);
});

test('missing named and ordinal helper facts survive unreadable and outside-scope metadata', t => {
  for (const outside of [false, true]) {
    const fixture = diagnosticFixture(t, [{ dll: 'probe.dll', symbols: [{ name: 'KnownMissing' }, { ordinal: 9 }] }]);
    const path = outside ? 'C:\\outside\\probe.dll' : 'C:\\Windows\\System32\\probe.dll';
    const reads = [], versionReads = [];
    const originalRead = fixture.deps.readPeBytes;
    fixture.deps.readPeBytes = path => { reads.push(path); return originalRead(path); };
    fixture.deps.readFileVersions = paths => { versionReads.push(...paths); return []; };
    fixture.deps.spawnSync = () => ({ status: 0, stdout: JSON.stringify({ schema: 1, machine: 0x8664, modules: [{ dll: 'probe.dll',
      resolvedPath: path, symbols: [{ name: 'KnownMissing', found: false, error: 127 }, { ordinal: 9, found: false, error: 127 }],
    }] }) });
    const result = diagnoseWindowsStartup(fixture.options, fixture.deps);
    assert.equal(result.diagnostics.status, 'partial-metadata');
    assert.equal(result.child.hexStatus, '0xC0000139');
    const facts = fixture.artifact('loader-exports');
    assert.deepEqual(facts.findings.map(f => [f.name ?? f.ordinal, f.found, f.error]), [['KnownMissing', false, 127], [9, false, 127]]);
    assert.ok(facts.findings.every(f => !('architecture' in f) && !('declaredExport' in f)));
    assert.equal(facts.batches[0].modules[0].symbols.length, 2);
    assert.equal(facts.batches[0].modules[0].metadataStatus, outside ? 'resolved-path-outside-fixture-system-runtime-scope' : 'PE-metadata-unavailable');
    assert.deepEqual(versionReads, outside ? [] : [path]);
    assert.deepEqual(reads, outside ? [fixture.options.executable] : [fixture.options.executable, path]);
  }
});

test('module budget retains already observed procedures beyond the static parsing limit', t => {
  const imports = Array.from({ length: 193 }, (_, i) => ({ dll: `probe${i}.dll`, symbols: [{ name: 'Missing' }] }));
  const fixture = diagnosticFixture(t, imports);
  const image = peFixture({ exports: [{ ordinal: 1, name: 'Existing' }] });
  for (const item of imports) fixture.files.set(`c:\\windows\\system32\\${item.dll}`, image);
  let reads = 0;
  const originalRead = fixture.deps.readPeBytes;
  fixture.deps.readPeBytes = path => { reads++; return originalRead(path); };
  fixture.deps.spawnSync = (_, args) => {
    const request = JSON.parse(readFileSync(args.at(-1), 'utf8'));
    return { status: 0, stdout: JSON.stringify({ schema: 1, machine: 0x8664, modules: request.modules.map(item => ({ dll: item.dll,
      resolvedPath: `C:\\Windows\\System32\\${item.dll}`, symbols: [{ name: 'Missing', found: false, error: 127 }],
    })) }) };
  };
  const result = diagnoseWindowsStartup(fixture.options, fixture.deps);
  assert.equal(result.diagnostics.status, 'partial-budget-limit');
  assert.equal(reads, 192); // Executable plus 191 DLL metadata reads.
  const facts = fixture.artifact('loader-exports');
  assert.equal(facts.findings.length, 193);
  assert.equal(facts.findings.at(-1).name, 'Missing');
  assert.equal(facts.findings.at(-1).error, 127);
  assert.equal('declaredExport' in facts.findings.at(-1), false);
  assert.equal(facts.batches[0].modules.at(-1).metadataStatus, 'module-budget-limit');
});

test('authorized version batch excludes outside roots and optional read failures preserve every loader fact', t => {
  const fixture = diagnosticFixture(t, ['allowed', 'unreadable', 'outside'].map(name => ({ dll: `${name}.dll`, symbols: [{ name: 'Missing' }] })));
  fixture.files.set('c:\\windows\\system32\\allowed.dll', peFixture());
  fixture.files.set('c:\\windows\\system32\\unreadable.dll', peFixture());
  delete fixture.deps.readFileVersions; // Exercise the real version-query scheduling boundary.
  let versionCalls = 0;
  fixture.deps.spawnSync = (_, args) => {
    const request = JSON.parse(readFileSync(args.at(-1), 'utf8'));
    if (request.operation === 'file-versions') {
      versionCalls++;
      assert.deepEqual(request.paths, ['C:\\Windows\\System32\\allowed.dll', 'C:\\Windows\\System32\\unreadable.dll']);
      const saved = fixture.artifact('loader-exports');
      assert.equal(saved.findings.length, 3); // Persisted before optional version subprocess.
      return { status: 0, stdout: JSON.stringify({ schema: 1, versions: [
        { path: request.paths[0], fileVersion: '1.2.3.4', status: 'read' },
        { path: request.paths[1], fileVersion: null, status: 'version-metadata-unavailable' },
      ] }) };
    }
    return { status: 0, stdout: JSON.stringify({ schema: 1, machine: 0x8664, modules: request.modules.map(item => ({ dll: item.dll,
      resolvedPath: `C:\\${item.dll === 'outside.dll' ? 'outside' : 'Windows\\System32'}\\${item.dll}`,
      symbols: [{ name: 'Missing', found: false, error: 127 }],
    })) }) };
  };
  assert.equal(diagnoseWindowsStartup(fixture.options, fixture.deps).diagnostics.status, 'partial-metadata');
  assert.equal(versionCalls, 1);
  const facts = fixture.artifact('loader-exports');
  assert.equal(facts.findings.length, 3);
  assert.equal(facts.batches[0].modules[0].fileVersion, '1.2.3.4');
  assert.equal(facts.batches[0].modules[1].versionStatus, 'version-metadata-unavailable');
  assert.equal(facts.batches[0].modules[2].fileVersion, null);
});

test('optional version subprocess failure cannot discard the completed helper batch', t => {
  const fixture = diagnosticFixture(t, [{ dll: 'probe.dll', symbols: [{ ordinal: 9 }] }]);
  fixture.files.set('c:\\windows\\system32\\probe.dll', peFixture());
  delete fixture.deps.readFileVersions;
  fixture.deps.spawnSync = (_, args) => {
    const request = JSON.parse(readFileSync(args.at(-1), 'utf8'));
    if (request.operation === 'file-versions') return { status: null, error: { code: 'ETIMEDOUT' } };
    return { status: 0, stdout: JSON.stringify({ schema: 1, machine: 0x8664, modules: [{ dll: 'probe.dll',
      resolvedPath: 'C:\\Windows\\System32\\probe.dll', symbols: [{ ordinal: 9, found: false, error: 127 }],
    }] }) };
  };
  const result = diagnoseWindowsStartup(fixture.options, fixture.deps);
  assert.equal(result.diagnostics.status, 'partial-metadata');
  assert.equal(result.child.hexStatus, '0xC0000139');
  const facts = fixture.artifact('loader-exports');
  assert.equal(facts.batches[0].modules[0].versionStatus, 'version-metadata-unavailable');
  assert.equal(facts.findings[0].ordinal, 9);
  assert.equal(facts.findings[0].error, 127);
});

const progressRecord = (type, fields = {}) => ({ schema: 1, type, ...fields });
function stalledHelper(fixture, records, tail = '') {
  fixture.deps.spawnSync = (_, args) => {
    const progress = args[args.indexOf('-ProgressPath') + 1];
    assert.ok(args.includes('-ProgressPath'));
    writeFileSync(progress, records.map(record => JSON.stringify(record) + '\n').join('') + tail);
    return { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' };
  };
}
const phase = (phase, fields) => progressRecord('phase', { phase, ...fields });
const moduleObservation = (dll, fields = {}) => progressRecord('module', { dll, resolvedPath: `C:\\Windows\\System32\\${dll}`,
  lookup: dll, previouslyLoadedPath: null, executableMapping: true, loadError: null, mappingError: null, ...fields });
const symbolObservation = (dll, symbol, found = false) => progressRecord('symbol', { dll, ...symbol, found, error: found ? null : 127 });

test('helper timeouts retain the last public phase before compile and during a module, with no invented facts', t => {
  for (const checkpoint of [phase('script-entry'), phase('compile-begin'), phase('load-begin', { dll: 'probe.dll' })]) {
    const fixture = diagnosticFixture(t, [{ dll: 'probe.dll', symbols: [{ name: 'Entry' }] }]);
    stalledHelper(fixture, [phase('script-entry'), checkpoint]);
    const report = diagnoseWindowsStartup(fixture.options, fixture.deps);
    assert.equal(report.diagnostics.status, 'partial-helper-failed');
    assert.equal(report.child.hexStatus, '0xC0000139'); assert.equal(report.child.mainEntered, false);
    const batch = fixture.artifact('loader-exports').batches[0];
    assert.equal(batch.helperPhase, checkpoint.phase);
    assert.equal(batch.lastPublicModule, checkpoint.dll ?? null);
    assert.deepEqual(batch.modules, []); assert.deepEqual(fixture.artifact('loader-exports').findings, []);
  }
});

test('completed named and ordinal facts survive a later symbol stall and optional metadata failure', t => {
  const fixture = diagnosticFixture(t, [{ dll: 'probe.dll', symbols: [{ name: 'Missing' }, { ordinal: 9 }, { name: 'Stalls' }] }]);
  stalledHelper(fixture, [phase('architecture-end', { machine: 0x8664 }), moduleObservation('probe.dll'),
    symbolObservation('probe.dll', { name: 'Missing' }), symbolObservation('probe.dll', { ordinal: 9 }),
    phase('symbol-begin', { dll: 'probe.dll', name: 'Stalls' })]);
  const report = diagnoseWindowsStartup(fixture.options, fixture.deps);
  const batch = fixture.artifact('loader-exports').batches[0];
  assert.equal(report.diagnostics.status, 'partial-helper-failed'); assert.equal(batch.machine, 0x8664);
  assert.equal(batch.helperPhase, 'symbol-begin'); assert.equal(batch.lastPublicModule, 'probe.dll');
  assert.deepEqual(batch.modules[0].symbols.map(f => f.name ?? f.ordinal), ['Missing', 9]);
  assert.equal(batch.modules[0].observationComplete, false);
  assert.equal(batch.modules[0].metadataStatus, 'PE-metadata-unavailable');
  assert.deepEqual(fixture.artifact('loader-exports').findings.map(f => f.name ?? f.ordinal), ['Missing', 9]);
});

test('a completed module survives a later module load stall and only authorized paths receive version reads', t => {
  const fixture = diagnosticFixture(t, ['allowed', 'outside', 'stalls'].map(dll => ({ dll: `${dll}.dll`, symbols: [{ ordinal: 9 }] })));
  const versionReads = [];
  fixture.deps.readFileVersions = paths => { versionReads.push(...paths); return []; };
  stalledHelper(fixture, [phase('architecture-end', { machine: 0x8664 }), moduleObservation('allowed.dll'),
    symbolObservation('allowed.dll', { ordinal: 9 }), phase('module-end', { dll: 'allowed.dll' }),
    moduleObservation('outside.dll', { resolvedPath: 'C:\\outside\\outside.dll' }), symbolObservation('outside.dll', { ordinal: 9 }),
    phase('module-end', { dll: 'outside.dll' }), phase('load-begin', { dll: 'stalls.dll' })]);
  const report = diagnoseWindowsStartup(fixture.options, fixture.deps);
  const facts = fixture.artifact('loader-exports');
  assert.equal(report.diagnostics.status, 'partial-helper-failed'); assert.equal(facts.batches[0].modules.length, 2);
  assert.ok(facts.batches[0].modules.every(m => m.observationComplete));
  assert.equal(facts.batches[0].lastPublicModule, 'stalls.dll');
  assert.deepEqual(versionReads, ['C:\\Windows\\System32\\allowed.dll']);
  assert.equal(facts.findings.length, 2); assert.equal(report.child.unsignedStatus, 3221225785);
});

test('truncated and malformed progress retain only earlier complete validated records', t => {
  for (const tail of ['{"schema":1,"type":"symbol","dll":"probe.dll"', '{bad-json}\n', JSON.stringify(symbolObservation('probe.dll', { ordinal: 9 }))]) {
    const fixture = diagnosticFixture(t, [{ dll: 'probe.dll', symbols: [{ name: 'Missing' }, { ordinal: 9 }] }]);
    stalledHelper(fixture, [phase('architecture-end', { machine: 0x8664 }), moduleObservation('probe.dll'), symbolObservation('probe.dll', { name: 'Missing' })], tail);
    diagnoseWindowsStartup(fixture.options, fixture.deps);
    const batch = fixture.artifact('loader-exports').batches[0];
    assert.equal(batch.progressStatus, 'partial-invalid-record');
    assert.deepEqual(batch.modules[0].symbols.map(f => f.name ?? f.ordinal), ['Missing']);
  }
});

test('unexpected modules, symbols, phases and arbitrary fields are rejected without persisting private values', t => {
  for (const bad of [moduleObservation('unexpected.dll'), symbolObservation('probe.dll', { name: 'Unrequested' }),
    phase('load-begin', { dll: 'unexpected.dll' }), phase('compile-begin', { secret: 'do-not-persist-this-value' }),
    moduleObservation('probe.dll', { loadError: 'not-an-error-number' })]) {
    const fixture = diagnosticFixture(t, [{ dll: 'probe.dll', symbols: [{ name: 'Missing' }] }]);
    stalledHelper(fixture, [phase('architecture-end', { machine: 0x8664 }), bad]);
    diagnoseWindowsStartup(fixture.options, fixture.deps);
    const batch = fixture.artifact('loader-exports').batches[0];
    assert.equal(batch.progressStatus, 'partial-invalid-record'); assert.deepEqual(batch.modules, []);
    for (const file of readdirSync(fixture.root)) assert.equal(readFileSync(join(fixture.root, file), 'utf8').includes('do-not-persist-this-value'), false);
  }
});

test('oversized progress, missing progress and mismatched machine preserve failure without observations', t => {
  for (const kind of ['oversized', 'missing', 'machine']) {
    const fixture = diagnosticFixture(t, [{ dll: 'probe.dll', symbols: [{ name: 'Missing' }] }]);
    if (kind === 'missing') fixture.deps.spawnSync = () => ({ status: null, error: { code: 'ETIMEDOUT' } });
    else stalledHelper(fixture, kind === 'machine' ? [phase('architecture-end', { machine: 0xaa64 }), moduleObservation('probe.dll')]
      : [], kind === 'oversized' ? 'x'.repeat(4 * 1024 * 1024 + 1) : '');
    const report = diagnoseWindowsStartup(fixture.options, fixture.deps);
    const batch = fixture.artifact('loader-exports').batches[0];
    assert.equal(batch.progressStatus, kind === 'oversized' ? 'oversized' : kind === 'missing' ? 'unavailable' : 'partial-invalid-record');
    assert.equal(report.child.hexStatus, '0xC0000139'); assert.deepEqual(batch.modules, []);
  }
});

test('timeout after a zero-symbol failed load retains genuine module evidence, and diagnosis never exceeds its scheduling budget', t => {
  const fixture = diagnosticFixture(t, [{ dll: 'missing.dll', symbols: [{ name: 'Missing' }] }]);
  let clock = 0; fixture.deps.now = () => clock;
  stalledHelper(fixture, [phase('architecture-end', { machine: 0x8664 }), moduleObservation('missing.dll', {
    resolvedPath: null, executableMapping: false, loadError: 126, mappingError: 126 }), phase('module-end', { dll: 'missing.dll' })]);
  const run = fixture.deps.spawnSync;
  fixture.deps.spawnSync = (...args) => { assert.equal(args[2].timeout, 12000); const result = run(...args); clock = 46000; return result; };
  const report = diagnoseWindowsStartup(fixture.options, fixture.deps);
  const facts = fixture.artifact('loader-exports');
  assert.equal(report.diagnostics.status, 'partial-helper-failed'); assert.equal(facts.findings[0].kind, 'module-unresolved-by-helper');
  assert.equal(facts.findings[0].loadError, 126); assert.deepEqual(facts.batches[0].modules[0].symbols, []);
});


test('load and map answers persist before path/symbol boundaries without inventing an unresolved module', t => {
  for (const loaded of [true, false]) {
    const fixture = diagnosticFixture(t, [{ dll: 'probe.dll', symbols: [{ name: 'Entry' }] }]);
    stalledHelper(fixture, [phase('architecture-end', { machine: 0x8664 }), moduleObservation('probe.dll', {
      resolvedPath: null, executableMapping: loaded, loadError: loaded ? null : 127 }),
    phase(loaded ? 'path-begin' : 'map-begin', { dll: 'probe.dll' })]);
    diagnoseWindowsStartup(fixture.options, fixture.deps);
    const saved = fixture.artifact('loader-exports');
    assert.equal(saved.batches[0].modules[0].loadError, loaded ? null : 127);
    assert.deepEqual(saved.batches[0].modules[0].symbols, []);
    assert.deepEqual(saved.findings.map(f => f.kind), loaded ? [] : ['module-load-failed-metadata-unavailable']);
  }
});

test('incremental load, map and path updates retain one module and nullable mapped symbol evidence', t => {
  const fixture = diagnosticFixture(t, [{ dll: 'probe.dll', symbols: [{ name: 'Entry' }] }]);
  const load = { resolvedPath: null, executableMapping: false, loadError: 127 };
  stalledHelper(fixture, [phase('architecture-end', { machine: 0x8664 }), moduleObservation('probe.dll', load),
    phase('map-end', { dll: 'probe.dll' }), moduleObservation('probe.dll', load),
    moduleObservation('probe.dll', { executableMapping: false, loadError: 127 }),
    progressRecord('symbol', { dll: 'probe.dll', name: 'Entry', found: null, error: null }), phase('module-end', { dll: 'probe.dll' })]);
  diagnoseWindowsStartup(fixture.options, fixture.deps);
  const saved = fixture.artifact('loader-exports');
  assert.equal(saved.batches[0].progressStatus, 'validated'); assert.equal(saved.batches[0].modules.length, 1);
  assert.equal(saved.batches[0].modules[0].observationComplete, true);
  assert.equal(saved.batches[0].modules[0].symbols[0].found, null);
  assert.equal(saved.findings[0].kind, 'module-load-failed-metadata-mapped');
});

test('Windows helper executes real compile/load/name phases with isolated profile and preserves failure artifacts',
  { skip: process.platform !== 'win32' ? 'Windows runtime unavailable on this host' : false }, t => {
    const root = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'plur1bus-native-spike-run-helper-'));
    let success = false;
    t.after(() => { if (success) rmSync(root, { recursive: true, force: true }); });
    const executable = join(root, 'transport_spike.exe');
    const machine = process.arch === 'arm64' ? 0xaa64 : process.arch === 'ia32' ? 0x14c : 0x8664;
    const bytes = peFixture({ machine, wide: machine !== 0x14c, imports: [{ dll: 'kernel32.dll', symbols: [{ name: 'GetCurrentProcess' }] }] });
    writeFileSync(executable, bytes);
    let helperResult;
    const env = { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
      HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root,
      PSModuleAnalysisCachePath: join(root, 'module-cache'),
      PSModulePath: win32.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') };
    const report = diagnoseWindowsStartup({ root, executable, cwd: root, env,
      child: { status: 3221225785, stdout: '', stderr: '' } }, {
      spawnSync: (...args) => { helperResult = spawnSync(...args); return helperResult; },
      readPeBytes: path => { if (path === executable) return bytes; throw Error('Optional static DLL read omitted in runtime test'); },
      readFileVersions: () => [],
    });
    const saved = JSON.parse(readFileSync(join(root, 'native-loader-exports.json'), 'utf8'));
    assert.equal(helperResult?.status, 0, `Public helper artifacts retained at ${root}`);
    assert.equal(saved.batches[0].progressStatus, 'validated');
    assert.equal(saved.batches[0].helperPhase, 'complete');
    assert.equal(saved.batches[0].architectureMatches, true);
    assert.equal(saved.batches[0].modules[0].symbols[0].found, true);
    assert.equal(report.child.hexStatus, '0xC0000139'); assert.equal(report.child.mainEntered, false);
    const phases = readFileSync(join(root, 'native-loader-progress-0.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(phases[0].phase, 'script-entry');
    assert.ok(phases.some(record => record.phase === 'compile-end'));
    assert.ok(phases.some(record => record.type === 'symbol' && record.name === 'GetCurrentProcess' && record.found === true));
    success = true;
  });


test('invalid observation ordering, conflicting updates and incomplete module endings retain a safe prefix', t => {
  const cases = [
    [moduleObservation('probe.dll')],
    [phase('architecture-end', { machine: 0x8664 }), moduleObservation('probe.dll'), phase('module-end', { dll: 'probe.dll' })],
    [phase('architecture-end', { machine: 0x8664 }), moduleObservation('probe.dll'), moduleObservation('probe.dll', { executableMapping: false, loadError: 127 })],
    [phase('architecture-end', { machine: 0x8664 }), moduleObservation('probe.dll'), symbolObservation('probe.dll', { name: 'Entry' }), symbolObservation('probe.dll', { name: 'Entry' }, true)],
    [phase('architecture-end', { machine: 0x8664 }), phase('architecture-end', { machine: 0xaa64 })],
  ];
  for (const records of cases) {
    const fixture = diagnosticFixture(t, [{ dll: 'probe.dll', symbols: [{ name: 'Entry' }] }]);
    stalledHelper(fixture, records); diagnoseWindowsStartup(fixture.options, fixture.deps);
    const batch = fixture.artifact('loader-exports').batches[0];
    assert.equal(batch.progressStatus, 'partial-invalid-record');
    assert.ok(batch.modules.every(module => !module.observationComplete));
    assert.ok(batch.modules.every(module => module.executableMapping && module.loadError === null));
    assert.ok(batch.modules.every(module => module.symbols.every(symbol => symbol.found === false)));
  }
});

test('an oversized record discards its tail and out-of-scope paths are redacted while completed symbol facts survive', t => {
  const fixture = diagnosticFixture(t, [{ dll: 'probe.dll', symbols: [{ name: 'Entry' }] }]);
  stalledHelper(fixture, [phase('architecture-end', { machine: 0x8664 }), moduleObservation('probe.dll', {
    resolvedPath: 'C:\\outside-private-profile\\probe.dll', previouslyLoadedPath: 'C:\\outside-private-profile\\probe.dll' }),
  symbolObservation('probe.dll', { name: 'Entry' })], JSON.stringify(phase('compile-begin', { padding: 'x'.repeat(65536) })) + '\n');
  diagnoseWindowsStartup(fixture.options, fixture.deps);
  const batch = fixture.artifact('loader-exports').batches[0];
  assert.equal(batch.progressStatus, 'partial-invalid-record'); assert.equal(batch.modules[0].symbols[0].found, false);
  assert.equal(batch.modules[0].metadataStatus, 'resolved-path-outside-fixture-system-runtime-scope');
  for (const file of readdirSync(fixture.root)) assert.equal(readFileSync(join(fixture.root, file), 'utf8').includes('outside-private-profile'), false);
});

test('a named #9 answer is rejected for an ordinal 9 request while the valid prefix survives', t => {
  const fixture = diagnosticFixture(t, [{ dll: 'probe.dll', symbols: [{ name: 'Prefix' }, { ordinal: 9 }] }]);
  stalledHelper(fixture, [phase('architecture-end', { machine: 0x8664 }), moduleObservation('probe.dll'),
    symbolObservation('probe.dll', { name: 'Prefix' }, true), symbolObservation('probe.dll', { name: '#9' })]);
  const report = diagnoseWindowsStartup(fixture.options, fixture.deps);
  const saved = fixture.artifact('loader-exports');
  assert.equal(saved.batches[0].progressStatus, 'partial-invalid-record');
  assert.deepEqual(saved.batches[0].modules[0].symbols, [{ name: 'Prefix', found: true, error: null }]);
  assert.deepEqual(saved.findings, []);
  const progress = readFileSync(join(fixture.root, 'native-loader-progress-0.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(progress.filter(record => record.type === 'symbol').map(record => record.name), ['Prefix']);
  assert.equal(report.diagnostics.status, 'partial-helper-failed');
  assert.equal(report.child.hexStatus, '0xC0000139'); assert.equal(report.child.mainEntered, false);
});

test('an ordinal 9 answer is rejected for a named #9 request while the valid prefix survives', t => {
  const fixture = diagnosticFixture(t, [{ dll: 'probe.dll', symbols: [{ name: 'Prefix' }, { name: '#9' }] }]);
  stalledHelper(fixture, [phase('architecture-end', { machine: 0x8664 }), moduleObservation('probe.dll'),
    symbolObservation('probe.dll', { name: 'Prefix' }, true), symbolObservation('probe.dll', { ordinal: 9 })]);
  const report = diagnoseWindowsStartup(fixture.options, fixture.deps);
  const saved = fixture.artifact('loader-exports');
  assert.equal(saved.batches[0].progressStatus, 'partial-invalid-record');
  assert.deepEqual(saved.batches[0].modules[0].symbols, [{ name: 'Prefix', found: true, error: null }]);
  assert.deepEqual(saved.findings, []);
  const progress = readFileSync(join(fixture.root, 'native-loader-progress-0.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(progress.filter(record => record.type === 'symbol').map(record => record.name), ['Prefix']);
  assert.equal(report.diagnostics.status, 'partial-helper-failed');
  assert.equal(report.child.hexStatus, '0xC0000139'); assert.equal(report.child.mainEntered, false);
});

test('name #9 and ordinal 9 coexist through query deduplication, progress duplicate checks and answer lookup', t => {
  for (const nameFound of [true, false]) {
    const symbols = [{ name: '#9' }, { ordinal: 9 }, { name: '#9' }, { ordinal: 9 }];
    const fixture = diagnosticFixture(t, [{ dll: 'probe.dll', symbols }, { dll: 'probe.dll', symbols }]);
    stalledHelper(fixture, [phase('architecture-end', { machine: 0x8664 }), moduleObservation('probe.dll'),
      symbolObservation('probe.dll', { ordinal: 9 }, !nameFound), symbolObservation('probe.dll', { name: '#9' }, nameFound),
      phase('module-end', { dll: 'probe.dll' })]);
    const run = fixture.deps.spawnSync;
    let query;
    fixture.deps.spawnSync = (...args) => {
      query = JSON.parse(readFileSync(args[1].at(-1), 'utf8'));
      return run(...args);
    };
    const report = diagnoseWindowsStartup(fixture.options, fixture.deps);
    assert.equal(query.modules.length, 1);
    assert.deepEqual(query.modules[0].symbols, [{ name: '#9' }, { ordinal: 9 }]);
    assert.equal(query.modules[0].importers.length, 2);
    const saved = fixture.artifact('loader-exports');
    assert.equal(saved.batches[0].progressStatus, 'validated');
    assert.equal(saved.batches[0].modules[0].observationComplete, true);
    assert.deepEqual(saved.batches[0].modules[0].symbols, [
      { name: '#9', found: nameFound, error: nameFound ? null : 127 },
      { ordinal: 9, found: !nameFound, error: nameFound ? 127 : null },
    ]);
    assert.deepEqual(saved.findings.map(fact => ({ name: fact.name, ordinal: fact.ordinal, found: fact.found })),
      [nameFound ? { name: undefined, ordinal: 9, found: false } : { name: '#9', ordinal: undefined, found: false }]);
    assert.equal(report.diagnostics.status, 'partial-helper-failed');
    assert.equal(report.child.hexStatus, '0xC0000139'); assert.equal(report.child.mainEntered, false);
  }
});

test('completed helper answers match name #9 and ordinal 9 separately in either success direction', t => {
  for (const nameFound of [true, false]) {
    const fixture = diagnosticFixture(t, [{ dll: 'probe.dll', symbols: [{ name: '#9' }, { ordinal: 9 }] }]);
    let query;
    fixture.deps.spawnSync = (_, args) => {
      query = JSON.parse(readFileSync(args.at(-1), 'utf8'));
      return { status: 0, stdout: JSON.stringify({ schema: 1, machine: 0x8664, modules: [{ dll: 'probe.dll',
        resolvedPath: 'C:\\Windows\\System32\\probe.dll', symbols: [
          { ordinal: 9, found: !nameFound, error: nameFound ? 127 : null },
          { name: '#9', found: nameFound, error: nameFound ? null : 127 },
        ] }] }) };
    };
    const report = diagnoseWindowsStartup(fixture.options, fixture.deps);
    assert.deepEqual(query.modules[0].symbols, [{ name: '#9' }, { ordinal: 9 }]);
    const saved = fixture.artifact('loader-exports');
    assert.deepEqual(saved.batches[0].modules[0].symbols, [
      { name: '#9', found: nameFound, error: nameFound ? null : 127 },
      { ordinal: 9, found: !nameFound, error: nameFound ? 127 : null },
    ]);
    assert.equal(saved.findings.length, 1);
    assert.equal(saved.findings[0].name, nameFound ? undefined : '#9');
    assert.equal(saved.findings[0].ordinal, nameFound ? 9 : undefined);
    assert.equal(report.child.hexStatus, '0xC0000139'); assert.equal(report.child.mainEntered, false);
  }
});

test('pre-autoload input and serialization checkpoints survive timeout without invented loader observations', t => {
  for (const checkpoint of ['input-read-begin', 'input-read-end', 'input-parse-begin', 'serialization-begin', 'serialization-end']) {
    const fixture = diagnosticFixture(t, [{ dll: 'kernel32.dll', symbols: [{ name: 'GetCurrentProcess' }] }]);
    stalledHelper(fixture, [phase('script-entry'), phase(checkpoint)]);
    const report = diagnoseWindowsStartup(fixture.options, fixture.deps);
    const saved = fixture.artifact('loader-exports');
    assert.equal(saved.batches[0].progressStatus, 'validated');
    assert.equal(saved.batches[0].helperPhase, checkpoint);
    assert.equal(saved.batches[0].lastPublicModule, null);
    assert.deepEqual(saved.batches[0].modules, []); assert.deepEqual(saved.findings, []);
    assert.equal(report.diagnostics.status, 'partial-helper-failed');
    assert.equal(report.child.hexStatus, '0xC0000139'); assert.equal(report.child.mainEntered, false);
  }
});


test('Windows helper records entry/input/serialization before injected cmdlet faults and preserves unexpected failures',
  { skip: process.platform !== 'win32' ? 'Windows runtime unavailable on this host' : false }, t => {
    const root = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'plur1bus-native-spike-run-boundary-'));
    let success = false;
    t.after(() => { if (success) rmSync(root, { recursive: true, force: true }); });
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helper = join(dirname(fileURLToPath(import.meta.url)), 'windows-loader.ps1');
    const queryPath = join(root, 'native-loader-query-boundary.json');
    const machine = process.arch === 'arm64' ? 0xaa64 : process.arch === 'ia32' ? 0x14c : 0x8664;
    writeFileSync(queryPath, JSON.stringify({ machine, executableDirectory: root,
      modules: [{ dll: 'kernel32.dll', symbols: [{ name: 'GetCurrentProcess' }] }] }));
    const env = { SystemRoot: systemRoot, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root,
      PSModulePath: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
      PSModuleAnalysisCachePath: join(root, 'module-cache') };
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const deadline = Date.now() + 45000;
    for (const command of ['New-Object', 'ConvertFrom-Json', 'ConvertTo-Json']) {
      const progressPath = join(root, `native-loader-progress-${command}.jsonl`);
      const wrapper = `function ${command} { throw 'public-test-command-blocked' }; & ([ScriptBlock]::Create([IO.File]::ReadAllText(${quote(helper)}))) -InputPath ${quote(queryPath)} -ProgressPath ${quote(progressPath)}`;
      assert.ok(Date.now() < deadline, `Public boundary artifacts retained at ${root}`);
      const child = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(wrapper, 'utf16le').toString('base64')],
        { cwd: root, env, encoding: 'utf8', timeout: Math.max(1, Math.min(12000, deadline - Date.now())), maxBuffer: 1024 * 1024, windowsHide: true });
      writeFileSync(join(root, `native-helper-boundary-${command}.json`), JSON.stringify({ schema: 1,
        context: 'separate-helper-injected-command-fault', command, ...startupResult(child), stderrBytes: Buffer.byteLength(child.stderr ?? '') }));
      assert.notEqual(child.status, null, `Public boundary artifacts retained at ${root}`);
      assert.equal(child.error, undefined, `Public boundary artifacts retained at ${root}`);
      const progress = readFileSync(progressPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(progress[0].phase, 'script-entry');
      assert.ok(progress.every(record => record.schema === 1));
      const phases = progress.filter(record => record.type === 'phase').map(record => record.phase);
      assert.ok(phases.includes('input-read-begin')); assert.ok(phases.includes('input-read-end'));
      assert.ok(phases.includes('input-parse-begin'));
      if (command === 'New-Object') {
        assert.equal(child.status, 0); assert.equal(phases.at(-1), 'complete');
        assert.ok(phases.includes('serialization-end'));
        assert.ok(progress.some(record => record.type === 'symbol' && record.name === 'GetCurrentProcess' && record.found === true));
      } else {
        assert.notEqual(child.status, 0);
        assert.equal(phases.at(-1), command === 'ConvertFrom-Json' ? 'input-parse-begin' : 'serialization-begin');
        assert.equal(progress.some(record => record.type === 'symbol' || record.type === 'module'), false);
      }
    }
    success = true;
  });
