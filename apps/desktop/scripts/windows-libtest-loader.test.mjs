import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectLibtestEvidence, diagnosticEnvironment, generatedManifestFromRc, imageEquivalence, inspectImage, listOnly, selectCachedLibtest } from './windows-libtest-loader.mjs';

function cargoFixture() {
  const desktop = 'C:\\work\\apps\\desktop';
  const id = 'path+file:///C:/work/apps/desktop/src-tauri#plur1bus-desktop@0.1.0';
  const artifact = { reason: 'compiler-artifact', package_id: id, fresh: true,
    target: { name: 'plur1bus_desktop', kind: ['lib'], crate_types: ['lib'], src_path: desktop + '\\src-tauri\\src\\lib.rs' },
    profile: { test: true }, executable: desktop + '\\target\\debug\\deps\\plur1bus_desktop-abcdef.exe' };
  return { desktop, status: 0,
    metadata: { packages: [{ name: 'plur1bus-desktop', id, manifest_path: desktop + '\\src-tauri\\Cargo.toml' }], target_directory: desktop + '\\target' },
    records: [artifact, { ...artifact, target: { name: 'plur1bus-desktop', kind: ['bin'] }, executable: desktop + '\\target\\debug\\deps\\plur1bus_desktop-bbb.exe' },
      { reason: 'build-script-executed', package_id: id, out_dir: desktop + '\\target\\debug\\build\\plur1bus-desktop-aaa\\out' }],
  };
}

test('Cargo libtest selection distinguishes package library from its binary harness', () => {
  const fixture = cargoFixture();
  const selected = selectCachedLibtest(fixture);
  assert.equal(selected.executable, fixture.records[0].executable);
  assert.deepEqual(selected.cargo.target.crateTypes, ['lib']);
  assert.throws(() => selectCachedLibtest({ ...fixture, status: 101 }), /cargo-inventory-failed/);
  fixture.records[0].fresh = false;
  assert.throws(() => selectCachedLibtest(fixture), /cached-libtest/);
});

test('ambiguous Cargo artifacts and build outputs never pick the first executable', () => {
  for (const index of [0, 2]) {
    const fixture = cargoFixture();
    fixture.records.push({ ...fixture.records[index] });
    assert.throws(() => selectCachedLibtest(fixture), /identity-not-unique/);
  }
});

test('wrong package, source, target directory, and example paths never become the libtest', () => {
  for (const change of [
    f => { f.records[0].package_id = 'unrelated-package'; },
    f => { f.records[0].target.kind = ['example']; },
    f => { f.records[0].target.src_path = f.desktop + '\\src-tauri\\src\\main.rs'; },
    f => { f.records[0].executable = 'C:\\other\\plur1bus_desktop-abcdef.exe'; },
    f => { f.metadata.target_directory = 'C:\\other'; },
    f => { f.records[2].out_dir = 'C:\\unrelated\\out'; },
  ]) {
    const fixture = cargoFixture(); change(fixture);
    assert.throws(() => selectCachedLibtest(fixture));
  }
});

const generated = '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">\n'
  + '<dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" /></dependentAssembly></dependency>\n</assembly>\n';
const rc = 'VERSIONINFO\n{\n}\n1 24\n{\n' + generated.trimEnd().split('\n').map(line => '" ' + line.replaceAll('"', '""') + ' "\n').join('') + '}\n';

test('generated manifest comes only from one literal Tauri resource block', () => {
  assert.equal(generatedManifestFromRc(rc), generated);
  assert.throws(() => generatedManifestFromRc(rc + rc), /identity-not-unique/);
  assert.throws(() => generatedManifestFromRc('1 24 "guessed-path.xml"\n'), /identity-not-unique/);
  assert.throws(() => generatedManifestFromRc('1 24\n{\nunknown\n}\n'), /not-literal/);
  assert.throws(() => generatedManifestFromRc('1 24\n{\n" \\z "\n}\n'), /not-literal/);
});

// Independent tiny PE with .text/.idata/.rsrc, an actual named DLL import and
// optionally RT_MANIFEST #1. No compiled executable or Windows host is required.
function imageFixture({ manifest = false, machine = 0x8664 } = {}) {
  const bytes = Buffer.alloc(0x800), pe = 0x80, optional = pe + 24, directories = optional + 112;
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(pe, 0x3c); bytes.writeUInt32LE(0x4550, pe);
  bytes.writeUInt16LE(machine, pe + 4); bytes.writeUInt16LE(3, pe + 6); bytes.writeUInt16LE(240, pe + 20);
  bytes.writeUInt16LE(0x20b, optional); bytes.writeBigUInt64LE(0x140000000n, optional + 24);
  bytes.writeUInt32LE(0x200, optional + 60); bytes.writeUInt32LE(0x1000, optional + 16); bytes.writeUInt16LE(3, optional + 68);
  bytes.writeUInt32LE(16, directories - 4);
  for (const [i, name, flags] of [[0, '.text', 0x60000020], [1, '.idata', 0xc0000040], [2, '.rsrc', 0x40000040]]) {
    const at = optional + 240 + i * 40; bytes.write(name, at, 'ascii');
    bytes.writeUInt32LE(0x200, at + 8); bytes.writeUInt32LE((i + 1) * 0x1000, at + 12);
    bytes.writeUInt32LE(0x200, at + 16); bytes.writeUInt32LE((i + 1) * 0x200, at + 20); bytes.writeUInt32LE(flags, at + 36);
  }
  bytes[0x200] = 0xc3;
  bytes.writeUInt32LE(0x2000, directories + 8); bytes.writeUInt32LE(40, directories + 12);
  bytes.writeUInt32LE(0x2080, 0x400); bytes.writeUInt32LE(0x2060, 0x40c);
  bytes.write('comctl32.dll\0', 0x460); bytes.writeBigUInt64LE(0x2090n, 0x480); bytes.write('TaskDialogIndirect\0', 0x492);
  bytes.writeUInt32LE(0x3000, directories + 16); bytes.writeUInt32LE(0x200, directories + 20);
  if (manifest) {
    for (const relative of [0, 24, 48]) bytes.writeUInt16LE(1, 0x600 + relative + 14);
    bytes.writeUInt32LE(24, 0x610); bytes.writeUInt32LE(0x80000018, 0x614);
    bytes.writeUInt32LE(1, 0x628); bytes.writeUInt32LE(0x80000030, 0x62c);
    bytes.writeUInt32LE(1033, 0x640); bytes.writeUInt32LE(72, 0x644);
    bytes.writeUInt32LE(0x3060, 0x648); bytes.writeUInt32LE(11, 0x64c); bytes.write('<assembly/>', 0x660);
  }
  return bytes;
}

test('PE proof permits only resource edits and detects changed code, imports and process properties', () => {
  const original = inspectImage(imageFixture()), changed = inspectImage(imageFixture({ manifest: true }));
  assert.equal(original.manifests.length, 0); assert.equal(changed.manifests.length, 1);
  assert.deepEqual(original.imports[0].symbols, [{ name: 'TaskDialogIndirect' }]);
  assert.equal(imageEquivalence(original, changed).accepted, true);
  for (const edit of [bytes => { bytes[0x200] = 0x90; }, bytes => { bytes[0x492] = 88; }, bytes => { bytes[0x98 + 68] = 2; }]) {
    const bytes = imageFixture({ manifest: true }); edit(bytes);
    assert.equal(imageEquivalence(original, inspectImage(bytes)).accepted, false);
  }
  assert.throws(() => inspectImage(imageFixture().subarray(0, 520)), /PE|section|resource/);
  const escaped = imageFixture({ manifest: true }); escaped.writeUInt32LE(0x8000ffff, 0x614);
  assert.throws(() => inspectImage(escaped), /resource/);
});

test('resources other than RT_MANIFEST #1 must also remain identical', () => {
  const bytes = imageFixture({ manifest: true });
  bytes.writeUInt32LE(16, 0x610); // Treat the same independent resource as version information.
  const original = inspectImage(bytes), changed = Buffer.from(bytes);
  assert.equal(original.resources[0].type, 16); assert.equal(original.manifests.length, 0);
  changed[0x660] = 88;
  const proof = imageEquivalence(original, inspectImage(changed));
  assert.equal(proof.nonResourceSectionsEqual, true); assert.equal(proof.importsEqual, true);
  assert.equal(proof.otherResourcesEqual, false); assert.equal(proof.accepted, false);
});

// Model SDK insertion before the last .reloc section, with a nonzero directory
// offset so equality must bind the directory range rather than just the section.
function relocationFixture(manifest = false) {
  const base = imageFixture({ manifest }), bytes = Buffer.alloc(manifest ? 0xc00 : 0xa00);
  base.copy(bytes, 0, 0, 0x200); base.copy(bytes, 0x400, 0x200, 0x600);
  const optional = 0x98, directories = optional + 112, sectionTable = optional + 240;
  bytes.writeUInt16LE(manifest ? 4 : 3, 0x86);
  bytes.writeUInt32LE(0x400, optional + 60); bytes.writeUInt32LE(0x1000, optional + 32);
  bytes.writeUInt32LE(0x200, optional + 36); bytes.writeUInt32LE(manifest ? 0x5000 : 0x4000, optional + 56);
  bytes.writeUInt32LE(manifest ? 0x600 : 0x400, optional + 8);
  bytes.writeUInt32LE(0x400, sectionTable + 20); bytes.writeUInt32LE(0x600, sectionTable + 60);
  if (manifest) {
    base.copy(bytes, 0x800, 0x600, 0x800);
    bytes.writeUInt32LE(0x800, sectionTable + 100);
  } else {
    bytes.writeUInt32LE(0, directories + 16); bytes.writeUInt32LE(0, directories + 20);
  }
  const section = sectionTable + (manifest ? 3 : 2) * 40, offset = manifest ? 0xa00 : 0x800;
  const rva = manifest ? 0x4000 : 0x3000;
  bytes.fill(0, section, section + 40); bytes.write('.reloc', section);
  bytes.writeUInt32LE(0x100, section + 8); bytes.writeUInt32LE(rva, section + 12);
  bytes.writeUInt32LE(0x200, section + 16); bytes.writeUInt32LE(offset, section + 20);
  bytes.writeUInt32LE(0x42000040, section + 36);
  bytes.writeUInt32LE(rva + 16, directories + 40); bytes.writeUInt32LE(12, directories + 44);
  bytes.writeUInt32LE(0x1000, offset + 16); bytes.writeUInt32LE(12, offset + 20);
  bytes.writeUInt16LE(0xa008, offset + 24); // DIR64 relocation at unchanged .text RVA + 8.
  return bytes;
}

test('SDK resource insertion can move only the directory-bound unchanged relocation section', () => {
  const before = inspectImage(relocationFixture()), after = inspectImage(relocationFixture(true));
  const proof = imageEquivalence(before, after);
  assert.equal(proof.nonResourceSectionsEqual, false); // The original strict fact remains visible.
  assert.equal(proof.accepted, true);
  assert.equal(proof.relocationSectionMove.relativeOffset, 16);
  assert.equal(proof.relocationSectionMove.size, 12);
  assert.equal(proof.relocationSectionMove.beforeRva, 0x3000);
  assert.equal(proof.relocationSectionMove.afterRva, 0x4000);
});

test('relocation content, targets, directory metadata and unrelated address changes remain rejected', () => {
  const before = inspectImage(relocationFixture()), directories = 0x108, sectionTable = 0x188;
  for (const [reason, change] of [
    ['relocation page target', b => b.writeUInt32LE(0x2000, 0xa10)],
    ['relocation type or target offset', b => b.writeUInt16LE(0xa010, 0xa18)],
    ['relocation padding content', b => { b[0xbff] = 1; }],
    ['stale relocation directory RVA', b => b.writeUInt32LE(0x3010, directories + 40)],
    ['different directory offset', b => b.writeUInt32LE(0x4012, directories + 40)],
    ['different directory size', b => b.writeUInt32LE(10, directories + 44)],
    ['other directory metadata', b => { b.writeUInt32LE(0x1010, directories + 48); b.writeUInt32LE(12, directories + 52); }],
    ['other section address', b => b.writeUInt32LE(0x1100, sectionTable + 12)],
    ['relocation section properties', b => b.writeUInt32LE(0xc2000040, sectionTable + 3 * 40 + 36)],
    ['executable inserted resource', b => b.writeUInt32LE(0x60000060, sectionTable + 2 * 40 + 36)],
    ['unexplained image size', b => b.writeUInt32LE(0x6000, 0x98 + 56)],
    ['incorrect initialized-data normalization', b => b.writeUInt32LE(0x601, 0x98 + 8)],
    ['stack or heap execution property', b => b.writeUInt32LE(0x2000, 0x98 + 72)],
    ['unexplained relocation shift', b => {
      b.writeUInt32LE(0x5000, sectionTable + 3 * 40 + 12); b.writeUInt32LE(0x5010, directories + 40);
      b.writeUInt32LE(0x6000, 0x98 + 56);
    }],
    ['extra non-resource section', b => {
      b.writeUInt16LE(5, 0x86); const at = sectionTable + 4 * 40;
      b.write('.extra', at); b.writeUInt32LE(0x100, at + 8); b.writeUInt32LE(0x6000, at + 12);
      b.writeUInt32LE(0x200, at + 16); b.writeUInt32LE(0xa00, at + 20); b.writeUInt32LE(0x40000040, at + 36);
    }],
  ]) {
    const changed = relocationFixture(true); change(changed);
    assert.equal(imageEquivalence(before, inspectImage(changed)).accepted, false, reason);
  }
});

test('base relocation directory changes fail even without a section move', () => {
  const original = relocationFixture(), changed = Buffer.from(original);
  changed.writeUInt32LE(10, 0x108 + 44);
  assert.equal(imageEquivalence(inspectImage(original), inspectImage(changed)).accepted, false);
});

for (const [field, relative] of [['SizeOfImage', 56], ['SizeOfInitializedData', 8]]) {
  test(`no-move ${field} changes fail even when masked headers and sections match`, () => {
    const original = relocationFixture(true), changed = Buffer.from(original);
    const before = inspectImage(original);
    assert.equal(imageEquivalence(before, inspectImage(changed)).accepted, true);
    const offset = changed.readUInt32LE(0x3c) + 24 + relative;
    changed.writeUInt32LE(changed.readUInt32LE(offset) + 4096, offset);
    const proof = imageEquivalence(before, inspectImage(changed));
    assert.equal(proof.nonResourceSectionsEqual, true);
    assert.equal(proof.relocationSectionMove, null);
    assert.equal(proof.executionHeaderEqual, true);
    assert.equal(proof.accepted, false);
    assert.equal(proof.layoutSizesPreserved, false);
  });
}

test('the movement exception rejects executable sections and other directories referring into the moved range', () => {
  for (const kind of ['executable', 'writable', 'other-directory']) {
    const before = relocationFixture(), after = relocationFixture(true);
    if (kind === 'other-directory') {
      for (const bytes of [before, after]) { bytes.writeUInt32LE(0x3010, 0x108 + 48); bytes.writeUInt32LE(12, 0x108 + 52); }
    } else {
      const characteristics = kind === 'executable' ? 0x62000040 : 0xc2000040;
      before.writeUInt32LE(characteristics, 0x188 + 2 * 40 + 36); after.writeUInt32LE(characteristics, 0x188 + 3 * 40 + 36);
    }
    assert.equal(imageEquivalence(inspectImage(before), inspectImage(after)).accepted, false, kind);
  }
});

test('unbacked, truncated or absent relocation directory ranges fail closed', () => {
  for (const [rva, size] of [[0x4010, 0], [0, 12], [0x8000, 12], [0x41ff, 12]]) {
    const bytes = relocationFixture(true); bytes.writeUInt32LE(rva, 0x108 + 40); bytes.writeUInt32LE(size, 0x108 + 44);
    assert.throws(() => inspectImage(bytes), /invalid-base-relocation-directory/);
  }
});

test('list-only execution has fixed argv, no shell, a 20-second owned-child bound and no inherited credential', () => {
  const env = diagnosticEnvironment({ SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32', GITHUB_TOKEN: 'private-value', HOME: 'C:\\real-user' }, 'C:\\scratch', path.win32);
  assert.equal(env.GITHUB_TOKEN, undefined); assert.equal(env.HOME, 'C:\\scratch');
  assert.equal(env.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  const result = listOnly('C:\\fixture.exe', { env, cwd: 'C:\\scratch' }, (program, args, options) => {
    assert.equal(program, 'C:\\fixture.exe'); assert.deepEqual(args, ['--list']);
    assert.equal(options.timeout, 20_000); assert.equal(options.shell, false); assert.equal(options.killSignal, 'SIGKILL');
    return { status: null, error: { code: 'ETIMEDOUT' } };
  });
  assert.equal(result.error.code, 'ETIMEDOUT');
});

function collectionFixture(t, controls = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wp05-libtest-evidence-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const desktop = path.join(root, 'apps', 'desktop'), output = path.join(root, 'evidence');
  const executable = path.join(desktop, 'target', 'debug', 'deps', 'plur1bus_desktop-abcdef.exe');
  const outDir = path.join(desktop, 'target', 'debug', 'build', 'plur1bus-desktop-aaa', 'out');
  mkdirSync(path.dirname(executable), { recursive: true }); mkdirSync(outDir, { recursive: true });
  writeFileSync(executable, imageFixture({ manifest: !!controls.existing })); writeFileSync(path.join(outDir, 'resource.rc'), rc);
  const sdkRoot = path.join(root, 'sdk'), mt = path.join(sdkRoot, '10', 'x64', 'mt.exe');
  mkdirSync(path.dirname(mt), { recursive: true }); writeFileSync(mt, imageFixture());
  const id = 'fixture-desktop-package';
  const metadata = { target_directory: path.join(desktop, 'target'), packages: [{ id, name: 'plur1bus-desktop', manifest_path: path.join(desktop, 'src-tauri', 'Cargo.toml') }] };
  const records = [{ reason: 'compiler-artifact', package_id: id, target: { name: 'plur1bus_desktop', kind: ['lib'], src_path: path.join(desktop, 'src-tauri', 'src', 'lib.rs') }, profile: { test: true }, fresh: true, executable },
    { reason: 'build-script-executed', package_id: id, out_dir: outDir }];
  if (controls.ambiguous) records.push({ ...records[0] });
  const launches = [], operations = [];
  let copyLists = 0;
  const response = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const deps = {
    spawnSync(program, args, options) {
      if (program === 'cargo') {
        if (args[0] === 'metadata') return response(metadata);
        assert.deepEqual(args, ['test', '--locked', '--workspace', '--no-fail-fast', '--no-run', '--message-format=json']);
        return { status: controls.inventoryExit ?? 0, stdout: records.map(item => JSON.stringify(item)).join('\n') };
      }
      if (program.endsWith('powershell.exe')) {
        const request = JSON.parse(readFileSync(args.at(-1), 'utf8')); operations.push(request.operation);
        if (request.operation === 'discover') return response({ schema: 1, status: 'ready', path: mt, sdkRoot, fileVersion: '10.0.1.0' });
        if (request.operation === 'prepare') {
          if (controls.existing) return response({ schema: 1, status: 'no-experiment', reason: 'original-already-selects-common-controls-v6' });
          copyFileSync(request.generated, request.merged);
          return response({ schema: 1, status: 'prepared', originalPropertiesPreserved: true });
        }
        if (request.operation === 'verify') return response({ schema: 1, status: controls.changedProperties ? 'different' : 'equivalent' });
        assert.fail('Unexpected helper operation');
      }
      if (program === mt) {
        if (args[0].startsWith('-inputresource:')) {
          const isOriginal = args[0] === `-inputresource:${executable};#1`;
          if (isOriginal && !controls.existing) return { status: 1, stdout: 'No RT_MANIFEST #1' };
          writeFileSync(args.find(arg => arg.startsWith('-out:')).slice(5), generated);
          return { status: controls.extractFailure ? 2 : 0 };
        }
        assert.deepEqual(args.slice(0, 2), ['-manifest', path.join(output, 'merged.manifest')]);
        const destination = args[2].slice('-outputresource:'.length, -3);
        assert.equal(destination, path.join(output, 'manifest-copy.exe'));
        const patched = imageFixture({ manifest: true }); if (controls.changedCode) patched[0x200] = 0x90;
        writeFileSync(destination, patched); return { status: controls.embedFailure ? 2 : 0 };
      }
      assert.deepEqual(args, ['--list']); assert.equal(options.timeout, 20_000); assert.equal(options.shell, false);
      assert.equal(options.env.PRIVATE_FIXTURE_VALUE, undefined);
      assert.ok(options.env.HOME.startsWith(root)); launches.push(program);
      if (program !== executable) copyLists++;
      if (controls.changeOriginal && copyLists === 2) writeFileSync(executable, imageFixture({ manifest: true }));
      if (controls.listTimeout) return { status: null, error: { code: 'ETIMEDOUT' } };
      return { status: program === executable ? (controls.originalExit ?? 0xc0000139)
        : copyLists === 1 ? (controls.copyBaselineExit ?? 0xc0000139) : 0, stdout: 'synthetic_case: test\n1 test, 0 benchmarks\n' };
    },
    diagnose({ root: loaderRoot }) {
      writeFileSync(path.join(loaderRoot, 'native-pe-imports.json'), '{"fixture":true}');
      return { child: { mainEntered: false }, diagnostics: { status: 'completed-helper-observations' } };
    },
  };
  const options = { desktop, output, temporaryRoot: root, env: { GITHUB_SHA: 'e'.repeat(40), RUNNER_ARCH: 'X64', SystemRoot: path.join(root, 'Windows'), PRIVATE_FIXTURE_VALUE: 'private-value' } };
  return { run: () => collectLibtestEvidence(options, deps), options, root, output, executable, launches, operations };
}

test('collector seals original identity, actual imports and copy proof while retaining the failed product outcome', t => {
  const fixture = collectionFixture(t), report = fixture.run();
  assert.equal(report.status, 'collected', JSON.stringify(report));
  assert.deepEqual(fixture.launches, [fixture.executable, path.join(fixture.output, 'manifest-copy.exe'), path.join(fixture.output, 'manifest-copy.exe')]);
  assert.equal(report.experiment.equivalence.accepted, true); assert.equal(report.originalUnchanged, true);
  assert.equal(report.originalSha256After, report.stamp.originalSha256);
  assert.equal(report.originalWorkspaceStepOutcome, 'failure'); assert.equal(report.productNativeAcceptance, 'not-run-by-diagnostic');
  assert.equal(report.experiment.list.exit, 0); assert.equal(report.originalList.unsignedExit, 0xc0000139);
  assert.ok(report.artifacts.some(item => item.path === 'original-libtest.exe'));
  assert.ok(report.artifacts.some(item => item.path === 'manifest-copy.exe'));
  const startup = JSON.parse(readFileSync(path.join(fixture.output, 'loader', 'native-startup.json'), 'utf8'));
  assert.equal(startup.child.mainEntered, undefined); assert.match(startup.context, /not-applicable/);
  assert.equal(JSON.stringify(report).includes('private-value'), false);
});

test('ambiguity and failed Cargo inventory never execute any candidate or select another harness', t => {
  for (const controls of [{ ambiguous: true }, { inventoryExit: 101 }]) {
    const fixture = collectionFixture(t, controls), report = fixture.run();
    assert.equal(report.status, 'incomplete'); assert.equal(fixture.launches.length, 0);
    assert.equal(fixture.operations.length, 0); assert.equal(report.identity, undefined);
  }
});

test('an invalid run stamp is explicit and cannot persist arbitrary environment text', t => {
  const fixture = collectionFixture(t);
  fixture.options.env.GITHUB_SHA = 'private-value'; fixture.options.env.RUNNER_ARCH = 'private-value';
  const report = fixture.run();
  assert.equal(report.status, 'incomplete'); assert.equal(report.failure, 'ci-run-stamp-unavailable');
  assert.equal(report.stamp.githubSha, null); assert.equal(report.stamp.runnerArch, null);
  assert.deepEqual(fixture.launches, []); assert.equal(JSON.stringify(report).includes('private-value'), false);
});

test('an existing v6 manifest, non-loader outcome or timeout explicitly forbids the manifest experiment', t => {
  for (const controls of [{ existing: true }, { originalExit: 0 }, { listTimeout: true }]) {
    const fixture = collectionFixture(t, controls), report = fixture.run();
    assert.equal(report.status, 'collected', JSON.stringify(report));
    assert.equal(report.experiment.status, 'not-attempted'); assert.ok(report.experiment.reason);
    assert.deepEqual(fixture.launches, [fixture.executable]); assert.equal(report.originalUnchanged, true);
  }
});

test('moving an unchanged PE that already lists successfully cannot become manifest causal evidence', t => {
  const fixture = collectionFixture(t, { copyBaselineExit: 0 }), report = fixture.run();
  assert.equal(report.status, 'collected'); assert.equal(report.experiment.status, 'not-attempted');
  assert.equal(report.experiment.reason, 'unmodified-copy-did-not-reproduce-entrypoint-failure');
  assert.deepEqual(fixture.launches, [fixture.executable, path.join(fixture.output, 'manifest-copy.exe')]);
  assert.equal(report.commands.some(command => command.name === 'embed-copy-manifest'), false);
});

test('code edits, manifest property changes and extraction/embedding failures cannot start the modified copy', t => {
  for (const controls of [{ changedCode: true }, { changedProperties: true }, { existing: true, extractFailure: true }, { embedFailure: true }]) {
    const fixture = collectionFixture(t, controls), report = fixture.run();
    assert.equal(report.status, 'incomplete', JSON.stringify(report));
    assert.deepEqual(fixture.launches, controls.existing ? [fixture.executable] : [fixture.executable, path.join(fixture.output, 'manifest-copy.exe')]);
    assert.equal(report.originalUnchanged, true);
  }
});

test('a changed original invalidates the whole observation even after a successful scratch --list', t => {
  const fixture = collectionFixture(t, { changeOriginal: true }), report = fixture.run();
  assert.equal(report.status, 'incomplete'); assert.equal(report.failure, 'original-binary-changed');
  assert.equal(report.originalUnchanged, false);
});
