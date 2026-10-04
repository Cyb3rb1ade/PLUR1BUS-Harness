// Failure-only CI evidence; never a product loader or test replacement.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path, { dirname, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePe } from './windows-pe.mjs';
import { diagnoseWindowsStartup } from './windows-startup.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = reason => { throw Error(reason); };
const unique = (items, reason) => items.length === 1 ? items[0] : fail(reason);
const samePath = (left, right, paths) => typeof left === 'string' && paths.normalize(left).toLowerCase() === paths.normalize(right).toLowerCase();
const within = (file, root, paths) => typeof file === 'string' && paths.isAbsolute(file)
  && !paths.relative(root, file).startsWith('..') && !paths.isAbsolute(paths.relative(root, file));
const readBounded = (file, limit = 256 * 1024 * 1024) => {
  if (!statSync(file).isFile() || statSync(file).size > limit) fail('file-size-or-type-invalid');
  return readFileSync(file);
};

/** Select the package's unit-library harness from Cargo's structured inventory. */
export function selectCachedLibtest({ metadata, records, status, desktop }, paths = win32) {
  if (status !== 0) throw Error('cargo-inventory-failed');
  const manifest = paths.join(desktop, 'src-tauri', 'Cargo.toml');
  const pkg = unique(metadata.packages.filter(item => item.name === 'plur1bus-desktop'
    && samePath(item.manifest_path, manifest, paths)), 'package-identity-not-unique');
  const artifact = unique(records.filter(item => item.reason === 'compiler-artifact' && item.package_id === pkg.id
    && item.target?.name === 'plur1bus_desktop' && item.target.kind?.length === 1 && item.target.kind[0] === 'lib'
    && item.profile?.test === true && item.executable), 'libtest-identity-not-unique');
  if (artifact.fresh !== true) fail('cached-libtest-unavailable');
  const target = paths.join(desktop, 'target');
  if (!samePath(metadata.target_directory, target, paths)
    || !samePath(artifact.target.src_path, paths.join(desktop, 'src-tauri', 'src', 'lib.rs'), paths)
    || !samePath(paths.dirname(artifact.executable), paths.join(target, 'debug', 'deps'), paths)
    || !/^plur1bus_desktop-[a-f0-9]+\.exe$/.test(paths.basename(artifact.executable))) fail('libtest-path-identity-mismatch');
  const build = unique(records.filter(item => item.reason === 'build-script-executed' && item.package_id === pkg.id), 'build-output-identity-not-unique');
  if (!within(build.out_dir, paths.join(target, 'debug', 'build'), paths) || paths.basename(build.out_dir) !== 'out') fail('build-output-outside-target');
  return { packageId: pkg.id, executable: artifact.executable, outDir: build.out_dir,
    cargo: { fresh: artifact.fresh, target: { name: artifact.target.name, kind: artifact.target.kind,
      crateTypes: artifact.target.crate_types, source: artifact.target.src_path },
    testProfile: artifact.profile.test, features: artifact.features } };
}

/** Recover only Tauri's literal RT_MANIFEST #1 block, never a guessed external file. */
export function generatedManifestFromRc(rc) {
  const block = unique([...rc.matchAll(/^1 24\r?\n\{\r?\n([\s\S]*?)^\}/gm)], 'generated-manifest-identity-not-unique')[1];
  return block.trimEnd().split(/\r?\n/).map(line => {
    const literal = /^" (.*) "$/.exec(line)?.[1];
    if (literal === undefined || /\\(?!['\\ntr])/.test(literal)) fail('generated-manifest-not-literal');
    return literal.replace(/""|\\['\\ntr]/g, escape => ({ '""': '"', "\\'": "'", '\\\\': '\\', '\\n': '\n', '\\t': '\t', '\\r': '\r' })[escape]);
  }).join('\n') + '\n';
}

/** Read immutable code/import evidence plus manifest resource identity without loading a PE. */
export function inspectImage(bytes) {
  const parsed = parsePe(bytes);
  const checked = (offset, size) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || offset + size > bytes.length) fail('invalid-pe-section-or-resource');
    return offset;
  };
  const u16 = n => bytes.readUInt16LE(checked(n, 2)), u32 = n => bytes.readUInt32LE(checked(n, 4));
  const pe = u32(0x3c), optional = pe + 24, sectionTable = optional + u16(pe + 20);
  const directories = optional + (parsed.format === 'PE32+' ? 112 : 96);
  // parsePe already bounds the directory count against the optional header.
  const dataDirectories = Array.from({ length: u32(directories - 4) }, (_, i) => ({ rva: u32(directories + i * 8), size: u32(directories + i * 8 + 4) }));
  const { rva: resourceRva, size: resourceSize } = dataDirectories[2] ?? { rva: 0, size: 0 };
  const sections = [];
  for (let i = 0; i < u16(pe + 6); i++) {
    const start = checked(sectionTable + i * 40, 40), offset = u32(start + 20), rawSize = u32(start + 16);
    const rva = u32(start + 12), virtualSize = u32(start + 8), characteristics = u32(start + 36);
    const name = bytes.subarray(start, start + 8).toString('hex');
    sections.push({ name, rva, virtualSize, rawSize, offset, characteristics,
      code: !!(characteristics & 0x20), resource: !!resourceRva && resourceRva >= rva && resourceRva < rva + Math.max(rawSize, virtualSize),
      sha256: sha256(bytes.subarray(checked(offset, rawSize), offset + rawSize)) });
  }
  const offsetOf = (rva, size) => {
    const section = unique(sections.filter(item => rva >= item.rva && rva + size <= item.rva + item.rawSize), 'invalid-resource-rva');
    return checked(section.offset + rva - section.rva, size);
  };
  let relocationDirectory = null;
  const relocation = dataDirectories[5];
  if (relocation && (relocation.rva || relocation.size)) {
    if (!relocation.rva || !relocation.size) fail('invalid-base-relocation-directory');
    const section = unique(sections.filter(s => relocation.rva >= s.rva && relocation.rva + relocation.size <= s.rva + s.rawSize), 'invalid-base-relocation-directory');
    const relativeOffset = relocation.rva - section.rva, offset = checked(section.offset + relativeOffset, relocation.size);
    relocationDirectory = { ...relocation, section: section.name, relativeOffset,
      sha256: sha256(bytes.subarray(offset, offset + relocation.size)) };
  }
  const resources = [];
  if (resourceRva || resourceSize) {
    if (!resourceRva || resourceSize < 16) fail('invalid-resource-directory');
    const entries = relative => {
      if (relative < 0 || relative + 16 > resourceSize) fail('invalid-resource-directory');
      const base = offsetOf(resourceRva + relative, 16), count = u16(base + 12) + u16(base + 14);
      if (count > 4096 || relative + 16 + count * 8 > resourceSize) fail('invalid-resource-directory');
      return Array.from({ length: count }, (_, i) => {
        const entry = offsetOf(resourceRva + relative + 16 + i * 8, 8), name = u32(entry), value = u32(entry + 4);
        let id = name;
        if (name >= 0x80000000) {
          const relativeName = name & 0x7fffffff;
          if (relativeName + 2 > resourceSize) fail('invalid-resource-name');
          const length = u16(offsetOf(resourceRva + relativeName, 2));
          if (length > 1024 || relativeName + 2 + length * 2 > resourceSize) fail('invalid-resource-name');
          const offset = offsetOf(resourceRva + relativeName + 2, length * 2);
          id = bytes.subarray(offset, offset + length * 2).toString('utf16le');
        }
        return { id, directory: !!(value & 0x80000000), relative: value & 0x7fffffff };
      });
    };
    const resourceKeys = new Set();
    for (const type of entries(0)) {
      if (!type.directory) fail('invalid-resource-tree');
      for (const id of entries(type.relative)) {
        if (!id.directory) fail('invalid-resource-tree');
        for (const language of entries(id.relative)) {
          if (language.directory || language.relative + 16 > resourceSize || resources.length >= 4096) fail('invalid-resource-tree');
          const data = offsetOf(resourceRva + language.relative, 16), size = u32(data + 4);
          const manifest = type.id === 24 && id.id === 1;
          if (manifest && size > 256 * 1024) fail('manifest-resource-too-large');
          const offset = offsetOf(u32(data), size);
          const key = JSON.stringify([type.id, id.id, language.id]);
          if (resourceKeys.has(key)) fail('duplicate-resource-identity');
          resourceKeys.add(key);
          resources.push({ type: type.id, id: id.id, language: language.id, size, codePage: u32(data + 8),
            manifest, sha256: sha256(bytes.subarray(offset, offset + size)) });
        }
      }
    }
  }
  resources.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'));
  const publicSections = sections.map(({ offset: _offset, ...item }) => item);
  if (!publicSections.some(section => section.code)) fail('no-code-section');
  // Bind all other DOS/COFF/optional-header bytes, including stack/heap sizes
  // and loader flags. These excluded fields have resource/layout checks below;
  // the SDK also recomputes the file checksum when updating resources.
  const unchangedHeader = Buffer.from(bytes.subarray(0, sectionTable));
  for (const [offset, size] of [[pe + 6, 2], [optional + 8, 4], [optional + 56, 4], [optional + 64, 4]]) unchangedHeader.fill(0, offset, offset + size);
  for (const index of [2, 5]) if (index < dataDirectories.length) unchangedHeader.fill(0, directories + index * 8, directories + index * 8 + 8);
  return { sha256: sha256(bytes), size: bytes.length, machine: parsed.machine, architecture: parsed.architecture,
    imports: parsed.imports, exports: parsed.exports, resources, dataDirectories, relocationDirectory,
    sizeOfImage: u32(optional + 56), initializedDataSize: u32(optional + 8),
    manifests: resources.filter(resource => resource.manifest), sections: publicSections,
    executionHeader: { entryPoint: u32(optional + 16), subsystem: u16(optional + 68), dllCharacteristics: u16(optional + 70),
      unchangedFieldsSha256: sha256(unchangedHeader),
      format: parsed.format, characteristics: u16(pe + 22), sectionAlignment: u32(optional + 32), fileAlignment: u32(optional + 36),
      imageBase: parsed.format === 'PE32+' ? bytes.readBigUInt64LE(optional + 24).toString() : String(u32(optional + 28)) } };
}

// The SDK may insert .rsrc immediately before the last relocation section. Its
// directory must still name the same bytes at the same offset within that one
// section. No other section address, property, content or ordering may change.
function relocationResourceInsertion(before, after, equal) {
  const previous = before.sections.at(-1), moved = after.sections.at(-1), resource = after.sections.at(-2);
  const oldDirectory = before.relocationDirectory, newDirectory = after.relocationDirectory;
  const alignment = before.executionHeader.sectionAlignment;
  if (!oldDirectory || !newDirectory || !previous || !moved || !resource || !alignment
    || before.sections.some(s => s.resource) || before.resources.length
    || before.dataDirectories[2]?.rva !== 0 || before.dataDirectories[2]?.size !== 0
    || after.sections.length !== before.sections.length + 1
    || new Set(before.sections.map(s => s.name)).size !== before.sections.length
    || new Set(after.sections.map(s => s.name)).size !== after.sections.length
    || !resource.resource || resource.characteristics !== 0x40000040 || resource.code
    || previous.characteristics !== 0x42000040 || previous.resource || previous.code || moved.resource || moved.code
    || oldDirectory.section !== previous.name || newDirectory.section !== moved.name
    || !equal(before.sections.slice(0, -1), after.sections.slice(0, -2))
    || !equal(previous, { ...moved, rva: previous.rva })
    || resource.rva !== previous.rva || after.dataDirectories[2]?.rva !== resource.rva
    || after.dataDirectories[2]?.size !== resource.virtualSize
    || after.manifests.length !== 1 || after.resources.length !== 1) return null;
  // An unchanged pointer from another directory must not acquire a different
  // meaning when .rsrc occupies the old relocation address. Directory 4 uses
  // file offsets, so its metadata is checked separately with every other entry.
  if (before.dataDirectories.some((d, i) => i !== 4 && i !== 5 && d.rva
    && d.rva < previous.rva + Math.max(previous.rawSize, previous.virtualSize)
    && d.rva + Math.max(d.size, 1) > previous.rva)) return null;
  const span = Math.ceil(Math.max(resource.rawSize, resource.virtualSize) / alignment) * alignment;
  const initializedDataSize = after.sections.filter(s => s.characteristics & 0x40).reduce((total, s) => total + s.rawSize, 0);
  if (!span || resource.rva % alignment || moved.rva !== previous.rva + span
    || after.sizeOfImage !== before.sizeOfImage + span
    || after.initializedDataSize !== initializedDataSize
    || !equal(oldDirectory, { ...newDirectory, rva: oldDirectory.rva })) return null;
  return { beforeRva: previous.rva, afterRva: moved.rva, insertedResourceSpan: span,
    initializedDataSizeBefore: before.initializedDataSize, initializedDataSizeAfter: initializedDataSize,
    relativeOffset: oldDirectory.relativeOffset, size: oldDirectory.size,
    directorySha256: oldDirectory.sha256, sectionSha256: previous.sha256 };
}

/** Permit only manifest resources and the directory-proven SDK relocation move. */
export function imageEquivalence(before, after) {
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const codeSectionsEqual = equal(before.sections.filter(s => s.code), after.sections.filter(s => s.code));
  const nonResourceSectionsEqual = equal(before.sections.filter(s => !s.resource), after.sections.filter(s => !s.resource));
  const relocationSectionMove = nonResourceSectionsEqual ? null : relocationResourceInsertion(before, after, equal);
  const layoutSizesPreserved = relocationSectionMove !== null
    || (before.sizeOfImage === after.sizeOfImage && before.initializedDataSize === after.initializedDataSize);
  const relocationDirectoryPreserved = equal(before.relocationDirectory, after.relocationDirectory) || relocationSectionMove !== null;
  const dataDirectoriesPreserved = before.dataDirectories.length === after.dataDirectories.length
    && before.dataDirectories.every((directory, i) => i === 2 || (i === 5 && relocationSectionMove !== null) || equal(directory, after.dataDirectories[i]));
  const importsEqual = equal(before.imports, after.imports), exportsEqual = equal(before.exports, after.exports);
  const otherResourcesEqual = equal(before.resources.filter(r => !r.manifest), after.resources.filter(r => !r.manifest));
  const executionHeaderEqual = before.machine === after.machine && equal(before.executionHeader, after.executionHeader);
  return { codeSectionsEqual, nonResourceSectionsEqual, relocationSectionMove, layoutSizesPreserved, relocationDirectoryPreserved, dataDirectoriesPreserved,
    importsEqual, exportsEqual, otherResourcesEqual, executionHeaderEqual,
    accepted: codeSectionsEqual && (nonResourceSectionsEqual || relocationSectionMove !== null) && relocationDirectoryPreserved
      && layoutSizesPreserved && dataDirectoriesPreserved && importsEqual && exportsEqual && otherResourcesEqual && executionHeaderEqual };
}

/** Preserve loader search inputs, but provide no credentials or real runtime profile. */
export function diagnosticEnvironment(env, scratch, paths = path) {
  const result = {};
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)']) {
    if (typeof env[name] === 'string') result[name] = env[name];
  }
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) result[name] = scratch;
  result.PSModuleAnalysisCachePath = paths.join(scratch, 'powershell-module-cache');
  result.PSModulePath = paths.join(result.SystemRoot ?? result.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  return result;
}

/** Run a list-only process with a fixed vector and an owned-child 20-second limit. */
export function listOnly(executable, options, run = spawnSync) {
  return run(executable, ['--list'], { ...options, encoding: 'utf8', shell: false, windowsHide: true,
    timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
}

/** Collect failure evidence. Success here never changes the original failed Cargo step. */
export function collectLibtestEvidence({ desktop, output, temporaryRoot, env = process.env }, dependencies = {}) {
  const run = dependencies.spawnSync ?? spawnSync, paths = dependencies.paths ?? path;
  const loader = dependencies.diagnose ?? diagnoseWindowsStartup;
  const now = dependencies.now ?? Date.now, started = now(), deadline = started + 480_000;
  const report = { schema: 1, purpose: 'failure-only-libtest-loader-diagnostic', status: 'incomplete',
    productNativeAcceptance: 'not-run-by-diagnostic', originalWorkspaceStepOutcome: 'failure',
    stamp: { githubSha: /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ? env.GITHUB_SHA : null,
      runnerArch: ['X64', 'ARM64'].includes(env.RUNNER_ARCH) ? env.RUNNER_ARCH : null, nodeArch: process.arch },
    commands: [], experiment: { status: 'not-attempted' }, limitations: [
      'DLL exports are observations in a separate helper process, not proof of the failed child loader binding.',
      'Only --list startup is executed; no test body or native SPA acceptance is run.',
      'A scratch-copy manifest experiment cannot repair or waive the original failed CI test step.',
    ] };
  mkdirSync(output);
  const save = () => writeFileSync(paths.join(output, 'index.json'), JSON.stringify(report, null, 2) + '\n');
  save();
  let identity, original;
  const command = (name, program, args, options = {}, retainText = false) => {
    const remaining = deadline - now();
    if (remaining <= 0) fail('diagnostic-budget-exhausted');
    const began = now();
    const result = run(program, args, { encoding: 'utf8', shell: false, windowsHide: true, killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024, ...options, timeout: Math.min(options.timeout ?? 30_000, remaining) });
    const record = { name, program, args, exit: result.status ?? null, signal: result.signal ?? null,
      errorCode: /^[A-Z0-9_]+$/.test(result.error?.code) ? result.error.code : null, elapsedMs: now() - began };
    if (retainText) {
      writeFileSync(paths.join(output, `${name}.stdout.txt`), result.stdout ?? '');
      writeFileSync(paths.join(output, `${name}.stderr.txt`), result.stderr ?? '');
    }
    report.commands.push(record); save();
    return result;
  };
  try {
    if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || !['X64', 'ARM64'].includes(env.RUNNER_ARCH)) fail('ci-run-stamp-unavailable');
    const scratch = mkdtempSync(paths.join(temporaryRoot, 'plur1bus-libtest-work-'));
    const childEnv = diagnosticEnvironment(env, scratch, paths);
    const metadataRun = command('cargo-metadata', 'cargo', ['metadata', '--locked', '--offline', '--no-deps', '--format-version', '1'], { cwd: desktop, env });
    if (metadataRun.status !== 0) fail('cargo-metadata-failed');
    const metadata = JSON.parse(metadataRun.stdout);
    const inventory = command('cargo-inventory', 'cargo', ['test', '--locked', '--workspace', '--no-fail-fast', '--no-run', '--message-format=json'], { cwd: desktop, env, timeout: 180_000 });
    if (inventory.status !== 0) fail('cargo-inventory-failed');
    const records = inventory.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    identity = selectCachedLibtest({ metadata, records, status: inventory.status, desktop }, paths);
    if (!samePath(realpathSync(identity.executable), identity.executable, paths)
      || !samePath(realpathSync(identity.outDir), identity.outDir, paths)) fail('artifact-path-redirected');
    report.identity = identity;
    original = inspectImage(readBounded(identity.executable));
    report.original = original;
    report.stamp.originalExecutable = identity.executable; report.stamp.originalSha256 = original.sha256;
    if (original.architecture !== (env.RUNNER_ARCH === 'ARM64' ? 'arm64' : 'x64')) fail('artifact-runner-architecture-mismatch');
    copyFileSync(identity.executable, paths.join(output, 'original-libtest.exe'));
    if (sha256(readBounded(paths.join(output, 'original-libtest.exe'))) !== original.sha256) fail('preserved-copy-not-identical');
    save();
    const listed = listOnly(identity.executable, { cwd: scratch, env: childEnv }, (program, args, options) => command('original-list', program, args, options, true));
    report.originalList = { exit: listed.status ?? null, unsignedExit: listed.status == null ? null : listed.status >>> 0, timedOut: listed.error?.code === 'ETIMEDOUT' };
    const loaderRoot = paths.join(output, 'loader'); mkdirSync(loaderRoot);
    const observations = loader({ root: loaderRoot, executable: identity.executable, cwd: scratch, env: childEnv, child: listed });
    // The reused transport helper's marker does not exist in a libtest harness.
    delete observations.child.mainEntered;
    observations.context = 'libtest-list-only; transport-main-marker-not-applicable';
    writeFileSync(paths.join(loaderRoot, 'native-startup.json'), JSON.stringify(observations, null, 2) + '\n');
    report.loaderStatus = observations.diagnostics.status; save();
    const helper = paths.join(dirname(fileURLToPath(import.meta.url)), 'windows-libtest-manifest.ps1');
    const powershell = paths.join(env.SystemRoot ?? env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const manifestOperation = (name, request) => {
      const input = paths.join(scratch, `${name}.json`); writeFileSync(input, JSON.stringify(request));
      const result = command(name, powershell, ['-NoProfile', '-NonInteractive', '-File', helper, '-InputPath', input], { cwd: scratch, env: childEnv }, true);
      if (result.status !== 0) fail(`${name}-failed`);
      const answer = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
      if (answer.schema !== 1) fail('manifest-helper-schema-invalid');
      return answer;
    };
    const discovered = manifestOperation('sdk-discovery', { operation: 'discover', architecture: original.architecture });
    if (discovered.status !== 'ready' || !within(discovered.path, discovered.sdkRoot, paths)) fail('matching-sdk-mt-unavailable');
    const mtImage = parsePe(readBounded(discovered.path));
    if (mtImage.machine !== original.machine) fail('sdk-tool-architecture-mismatch');
    report.sdk = { ...discovered, sha256: sha256(readBounded(discovered.path)), machine: mtImage.machine };
    const originalManifest = paths.join(output, 'original.manifest');
    const extracted = command('extract-original-manifest', discovered.path, [`-inputresource:${identity.executable};#1`, `-out:${originalManifest}`, '-nologo'], { cwd: scratch, env: childEnv }, true);
    report.originalManifest = { resources: original.manifests, extractionExit: extracted.status ?? null };
    if (original.manifests.length > 1) fail('original-manifest-identity-ambiguous');
    if (original.manifests.length === 1 && (extracted.status !== 0 || extracted.error)) fail('original-manifest-extraction-failed');
    if (original.manifests.length === 0 && (extracted.status === 0 || extracted.error || extracted.status == null)) fail('original-manifest-absence-unproven');
    if (original.manifests.length) report.originalManifest.sha256 = sha256(readBounded(originalManifest, 256 * 1024));
    const rcBytes = readBounded(paths.join(identity.outDir, 'resource.rc'), 1024 * 1024);
    writeFileSync(paths.join(output, 'generated-resource.rc'), rcBytes);
    const generated = paths.join(output, 'generated.manifest');
    writeFileSync(generated, generatedManifestFromRc(rcBytes.toString('utf8')));
    report.generated = { rcSha256: sha256(rcBytes), manifestSha256: sha256(readBounded(generated)), sourceOutDir: identity.outDir };
    const merged = paths.join(output, 'merged.manifest');
    const prepared = manifestOperation('manifest-prepare', { operation: 'prepare', generated, original: original.manifests.length ? originalManifest : null, merged });
    report.manifestPreparation = prepared; save();
    if (prepared.status === 'no-experiment') {
      report.experiment = { status: 'not-attempted', reason: prepared.reason };
    } else if (prepared.status !== 'prepared' || prepared.originalPropertiesPreserved !== true) {
      fail('manifest-preservation-unproven');
    } else if (report.originalList.unsignedExit !== 0xc0000139 || listed.error || listed.signal) {
      report.experiment = { status: 'not-attempted', reason: 'original-list-did-not-reproduce-entrypoint-failure' };
    } else {
      const copy = paths.join(output, 'manifest-copy.exe'); copyFileSync(identity.executable, copy);
      const copyBefore = inspectImage(readBounded(copy));
      if (copyBefore.sha256 !== original.sha256) fail('experiment-copy-not-identical');
      report.experiment = { status: 'copy-created', beforeSha256: copyBefore.sha256, manifestSha256: sha256(readBounded(merged)) }; save();
      // Relocation changes the executable-directory DLL search input. Require a
      // failing baseline at this exact scratch path before changing any bytes.
      const baseline = listOnly(copy, { cwd: scratch, env: childEnv }, (program, args, options) => command('copy-baseline-list', program, args, options, true));
      report.experiment.baseline = { exit: baseline.status ?? null, unsignedExit: baseline.status == null ? null : baseline.status >>> 0,
        timedOut: baseline.error?.code === 'ETIMEDOUT' };
      if (sha256(readBounded(copy)) !== copyBefore.sha256) fail('unmodified-copy-changed-during-list');
      if (report.experiment.baseline.unsignedExit !== 0xc0000139 || baseline.error || baseline.signal) {
        report.experiment.status = 'not-attempted';
        report.experiment.reason = 'unmodified-copy-did-not-reproduce-entrypoint-failure';
        report.status = 'collected';
        return report;
      }
      const embedded = command('embed-copy-manifest', discovered.path, ['-manifest', merged, `-outputresource:${copy};#1`, '-nologo'], { cwd: scratch, env: childEnv }, true);
      if (embedded.status !== 0 || embedded.error) fail('copy-manifest-embedding-failed');
      const copyAfter = inspectImage(readBounded(copy));
      report.experiment.after = copyAfter; report.experiment.equivalence = imageEquivalence(original, copyAfter); save();
      if (!report.experiment.equivalence.accepted || copyAfter.manifests.length !== 1) fail('copy-code-import-or-resource-proof-failed');
      const actualManifest = paths.join(output, 'copy.manifest');
      const extractedCopy = command('extract-copy-manifest', discovered.path, [`-inputresource:${copy};#1`, `-out:${actualManifest}`, '-nologo'], { cwd: scratch, env: childEnv }, true);
      if (extractedCopy.status !== 0 || extractedCopy.error) fail('copy-manifest-extraction-failed');
      const verified = manifestOperation('manifest-verify', { operation: 'verify', expected: merged, actual: actualManifest });
      report.experiment.manifestVerification = verified;
      if (verified.status !== 'equivalent') fail('copy-manifest-properties-changed');
      if (sha256(readBounded(identity.executable)) !== original.sha256) fail('original-changed-before-copy-start');
      const result = listOnly(copy, { cwd: scratch, env: childEnv }, (program, args, options) => command('copy-list', program, args, options, true));
      report.experiment.status = 'observed';
      report.experiment.list = { exit: result.status ?? null, unsignedExit: result.status == null ? null : result.status >>> 0, timedOut: result.error?.code === 'ETIMEDOUT' };
      report.experiment.observation = result.status === 0 && !result.error ? 'manifest-copy-listed-tests; product-failure-retained' : 'manifest-copy-startup-not-successful';
    }
    report.status = 'collected';
  } catch (error) {
    report.status = 'incomplete';
    report.failure = /^[a-z][a-z0-9-]{1,90}$/.test(error.message) ? error.message : 'diagnostic-operation-failed';
  } finally {
    if (identity && original) {
      try {
        report.originalSha256After = sha256(readBounded(identity.executable));
        report.originalUnchanged = report.originalSha256After === original.sha256;
        if (!report.originalUnchanged) { report.status = 'incomplete'; report.failure = 'original-binary-changed'; }
      } catch { report.status = 'incomplete'; report.failure = 'original-after-hash-unavailable'; }
    }
    // This inventory stamps every retained file, including the two immutable PE snapshots.
    const artifacts = [];
    const inventory = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = paths.join(directory, entry.name);
        if (entry.isDirectory()) inventory(file);
        else if (entry.isFile() && file !== paths.join(output, 'index.json')) artifacts.push({ path: paths.relative(output, file), sha256: sha256(readBounded(file)), bytes: statSync(file).size });
      }
    };
    try { inventory(output); }
    catch { report.status = 'incomplete'; report.failure = 'artifact-inventory-incomplete'; }
    report.artifacts = artifacts; report.elapsedMs = now() - started; save();
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.argv.length !== 4 || process.argv[2] !== '--output') {
    console.error('Windows CI failure diagnostic requires --output and the CI run stamp.'); process.exitCode = 1;
  } else {
    const output = resolve(process.argv[3]), temporaryRoot = resolve(process.env.RUNNER_TEMP);
    if (!within(output, temporaryRoot, path) || output === temporaryRoot) throw Error('diagnostic-output-outside-runner-temp');
    const report = collectLibtestEvidence({ desktop: resolve(dirname(fileURLToPath(import.meta.url)), '..'), output, temporaryRoot });
    console.log(`Libtest diagnostic ${report.status}; original workspace failure retained.`);
    process.exitCode = report.status === 'collected' ? 0 : 1;
  }
}
