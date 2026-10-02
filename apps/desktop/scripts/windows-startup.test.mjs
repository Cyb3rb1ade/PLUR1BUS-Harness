import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
