import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePe } from './windows-pe.mjs';

export const MAIN_MARKER = 'PLUR1BUS_NATIVE_SPIKE_MAIN_ENTERED';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const keyOf = symbol => symbol.name == null ? `#${symbol.ordinal}` : symbol.name;
const publicCode = code => typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : null;
const windowsPathWithin = (path, root) => {
  const relative = win32.relative(root, path);
  return !relative.startsWith('..') && !win32.isAbsolute(relative);
};

export function startupResult(child) {
  const status = Number.isInteger(child.status) ? child.status : null;
  const unsigned = status == null ? null : status >>> 0;
  return { status, unsignedStatus: unsigned,
    hexStatus: unsigned == null ? null : `0x${unsigned.toString(16).padStart(8, '0').toUpperCase()}`,
    signal: publicCode(child.signal), errorCode: publicCode(child.error?.code),
    mainEntered: [child.stdout, child.stderr].some(value =>
      typeof value === 'string' && value.split(/\r?\n/).some(line => line === MAIN_MARKER)) };
}

// Deliberately catches every diagnostic failure. The caller retains the ORIGINAL
// child status and still fails collection; a diagnostic is never a remediation.
export function diagnoseWindowsStartup({ root, executable, cwd, env, child }, dependencies = {}) {
  const run = dependencies.spawnSync ?? spawnSync;
  const now = dependencies.now ?? Date.now;
  const start = now(), deadline = start + 45000;
  const startup = { schema: 1, executable: { path: executable }, cwd,
    child: startupResult(child), diagnostics: { status: 'not-started', limitations: [
      'Separate helper process: its loaded modules/search context are not proof of the failed child loader state.',
      'Normal DLL loading may initialize runtime DLLs in this isolated helper; no resolved export is invoked.',
      'Failed DLL loads use image-resource mapping and static exports; that is not a successful GetProcAddress lookup.',
    ] } };
  const peRecords = [], batches = [];
  let findings = [];
  const save = () => {
    findings = batches.flatMap(batch => batch.modules.flatMap(entry => {
      const moduleFindings = !entry.resolvedPath ? [{ kind: 'module-unresolved-by-helper', ...entry }]
        : entry.loadError != null ? [{ kind: 'module-load-failed-metadata-mapped', ...entry }] : [];
      return [...moduleFindings, ...entry.symbols.filter(fact => fact.found === false || fact.declaredExport === false).map(fact => ({
        kind: fact.found === false ? 'procedure-unresolved-by-helper' : 'import-export-table-mismatch',
        dll: entry.dll, importers: entry.importers, resolvedPath: entry.resolvedPath,
        fileVersion: entry.fileVersion, architecture: entry.architecture, ...fact,
      }))];
    }));
    for (const [name, value] of [['startup', startup], ['pe-imports', peRecords], ['loader-exports', { batches, findings }]]) {
      writeFileSync(resolve(root, `native-${name}.json`), JSON.stringify(value, null, 2) + '\n');
    }
  };
  const readPe = path => {
    if (!dependencies.readPeBytes && statSync(path).size > 128 * 1024 * 1024) throw new Error('PE size limit');
    const bytes = dependencies.readPeBytes ? dependencies.readPeBytes(path) : readFileSync(path);
    const sha256 = hash(bytes);
    if (path === executable) startup.executable.sha256 = sha256;
    return { path, sha256, ...parsePe(bytes) };
  };
  try {
    save();
    const image = readPe(executable);
    Object.assign(startup.executable, { sha256: image.sha256, architecture: image.architecture, machine: image.machine });
    peRecords.push({ ...image, exports: undefined });
    if (child.status === 0) { startup.diagnostics.status = 'not-required-child-succeeded'; save(); return startup; }
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
    if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error('Windows system root unavailable');
    const helper = resolve(dirname(fileURLToPath(import.meta.url)), 'windows-loader.ps1');
    const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const executableDirectory = win32.dirname(executable);
    const permittedRoots = [systemRoot, executableDirectory, win32.dirname(process.execPath)];
    const parsed = new Map([[executable.toLowerCase(), image]]), seen = new Map();
    let pending = image.imports.map(entry => ({ ...entry, importer: executable }));
    for (let round = 0; pending.length && round < 12; round++) {
      if (now() >= deadline || parsed.size >= 192) { startup.diagnostics.status = 'partial-budget-limit'; break; }
      const grouped = new Map();
      for (const item of pending) {
        const dll = item.dll.toLowerCase();
        let group = grouped.get(dll);
        if (!group) { group = { dll, symbols: new Map(), importers: [] }; grouped.set(dll, group); }
        group.importers.push({ path: item.importer, delayed: item.delayed });
        for (const symbol of item.symbols) {
          if (!seen.get(dll)?.has(keyOf(symbol))) group.symbols.set(keyOf(symbol), symbol);
        }
      }
      const modules = [...grouped.values()].filter(entry => entry.symbols.size).map(entry => ({ ...entry, symbols: [...entry.symbols.values()] }));
      pending = [];
      if (!modules.length) break;
      for (const entry of modules) {
        if (!seen.has(entry.dll)) seen.set(entry.dll, new Set());
        for (const symbol of entry.symbols) seen.get(entry.dll).add(keyOf(symbol));
      }
      const queryPath = resolve(root, `native-loader-query-${round}.json`);
      writeFileSync(queryPath, JSON.stringify({ machine: image.machine, executableDirectory, modules }));
      const result = run(powershell, ['-NoProfile', '-NonInteractive', '-File', helper, '-InputPath', queryPath],
        { cwd, env, encoding: 'utf8', timeout: Math.max(1, Math.min(12000, deadline - now())), maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      const batch = { round, status: result.status, signal: publicCode(result.signal), errorCode: publicCode(result.error?.code),
        stderrBytes: Buffer.byteLength(result.stderr ?? ''), modules: [] };
      batches.push(batch);
      if (result.status !== 0 || result.error) {
        try {
          const failure = JSON.parse(result.stdout);
          if (['compile', 'architecture', 'search', 'modules'].includes(failure.stage)) batch.helperStage = failure.stage;
          if (Number.isInteger(failure.hresult)) batch.helperHresult = failure.hresult;
        } catch { /* Arbitrary subprocess messages are not copied into artifacts. */ }
        startup.diagnostics.status = 'partial-helper-failed'; break;
      }
      let data;
      try { data = JSON.parse(result.stdout.replace(/^\uFEFF/, '')); } catch { startup.diagnostics.status = 'partial-helper-invalid-json'; break; }
      if (data.schema !== 1 || !Number.isInteger(data.machine) || !Array.isArray(data.modules)) {
        startup.diagnostics.status = 'partial-helper-invalid-schema'; break;
      }
      batch.machine = data.machine;
      batch.architectureMatches = data.machine === image.machine;
      if (!batch.architectureMatches) { startup.diagnostics.status = 'partial-helper-architecture-mismatch'; break; }
      if (data.modules.length !== modules.length) { startup.diagnostics.status = 'partial-helper-missing-modules'; break; }
      for (const query of modules) {
        const answer = data.modules.find(item => item.dll?.toLowerCase() === query.dll);
        if (!answer || !Array.isArray(answer.symbols)) throw new Error('Incomplete helper module');
        const entry = { dll: query.dll, apiSet: /^(api|ext)-ms-/.test(query.dll), importers: query.importers,
          lookup: typeof answer.lookup === 'string' ? answer.lookup : null,
          executableMapping: typeof answer.executableMapping === 'boolean' ? answer.executableMapping : null,
          resolvedPath: typeof answer.resolvedPath === 'string' ? answer.resolvedPath : null,
          previouslyLoadedPath: typeof answer.previouslyLoadedPath === 'string' ? answer.previouslyLoadedPath : null,
          fileVersion: null,
          loadError: Number.isInteger(answer.loadError) ? answer.loadError : null,
          mappingError: Number.isInteger(answer.mappingError) ? answer.mappingError : null, symbols: [] };
        batch.modules.push(entry);
        // Win32 observations are evidence even when optional file metadata is unavailable.
        for (const symbol of query.symbols) {
          const resolved = answer.symbols.find(item => keyOf(item) === keyOf(symbol));
          if (!resolved || !(typeof resolved.found === 'boolean' || (resolved.found === null && entry.loadError != null))) {
            if (!entry.resolvedPath && !answer.symbols.length) break;
            throw new Error('Incomplete symbol resolution');
          }
          entry.symbols.push({ ...symbol, found: resolved.found, error: Number.isInteger(resolved.error) ? resolved.error : null });
        }
        save();
        if (!entry.resolvedPath) { entry.metadataStatus = 'resolved-path-unavailable'; continue; }
        const authorizedPath = win32.isAbsolute(entry.resolvedPath) && permittedRoots.some(path => windowsPathWithin(entry.resolvedPath, path));
        if (!authorizedPath) {
          entry.metadataStatus = 'resolved-path-outside-fixture-system-runtime-scope';
          startup.diagnostics.limitations.push('A resolved file was outside allowed metadata roots and was not read.');
          continue;
        }
        entry.metadataAuthorized = true;
        let module = parsed.get(entry.resolvedPath.toLowerCase());
        if (!module) {
          if (parsed.size >= 192) {
            entry.metadataStatus = 'module-budget-limit';
            startup.diagnostics.status = 'partial-budget-limit';
            continue;
          }
          try { module = readPe(entry.resolvedPath); }
          catch { entry.metadataStatus = 'PE-metadata-unavailable'; continue; }
          parsed.set(entry.resolvedPath.toLowerCase(), module);
          peRecords.push({ ...module, exports: undefined });
          pending.push(...module.imports.map(item => ({ ...item, importer: entry.resolvedPath })));
        }
        entry.architecture = module.architecture;
        entry.machine = module.machine;
        entry.sha256 = module.sha256;
        entry.metadataStatus = 'PE-metadata-read';
        for (const fact of entry.symbols) {
          const exported = module.exports.find(item => fact.name == null ? item.ordinal === fact.ordinal : item.names.includes(fact.name));
          fact.declaredExport = !!exported;
          fact.forwarder = exported?.forwarder ?? null;
          if (fact.found !== true && fact.forwarder) {
            const separator = fact.forwarder.lastIndexOf('.');
            const targetDll = fact.forwarder.slice(0, separator), targetSymbol = fact.forwarder.slice(separator + 1);
            if (separator > 0 && /^[\w.-]+$/.test(targetDll) && (/^#[0-9]{1,5}$/.test(targetSymbol) ? Number(targetSymbol.slice(1)) <= 65535 : /^[\w?@$.-]+$/.test(targetSymbol))) {
              pending.push({ dll: targetDll.toLowerCase().endsWith('.dll') ? targetDll : `${targetDll}.dll`,
                importer: `${entry.resolvedPath} (export forwarder)`, delayed: false,
                symbols: targetSymbol.startsWith('#') ? [{ ordinal: Number(targetSymbol.slice(1)) }] : [{ name: targetSymbol }] });
            }
          }
        }
      }
      save();
    }
    // Version enrichment happens only after the same path authorization as PE reads.
    // One bounded batch avoids a separate PowerShell startup for every DLL.
    const versionEntries = batches.flatMap(batch => batch.modules).filter(entry => entry.metadataAuthorized);
    if (versionEntries.length) {
      try {
        if (now() >= deadline) throw new Error('Version budget exhausted');
        const paths = [...new Set(versionEntries.map(entry => entry.resolvedPath))];
        const readVersions = dependencies.readFileVersions ?? (paths => {
          const queryPath = resolve(root, 'native-loader-query-versions.json');
          writeFileSync(queryPath, JSON.stringify({ operation: 'file-versions', paths }));
          const result = run(powershell, ['-NoProfile', '-NonInteractive', '-File', helper, '-InputPath', queryPath],
            { cwd, env, encoding: 'utf8', timeout: Math.max(1, Math.min(12000, deadline - now())), maxBuffer: 1024 * 1024, windowsHide: true });
          if (result.status !== 0 || result.error) throw new Error('Version helper unavailable');
          const data = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
          if (data.schema !== 1 || !Array.isArray(data.versions)) throw new Error('Version helper invalid');
          return data.versions;
        });
        const versions = readVersions(paths);
        for (const entry of versionEntries) {
          const version = versions.find(item => item.path === entry.resolvedPath);
          entry.fileVersion = typeof version?.fileVersion === 'string' ? version.fileVersion : null;
          entry.versionStatus = version?.status === 'read' ? 'read' : 'version-metadata-unavailable';
        }
      } catch {
        for (const entry of versionEntries) entry.versionStatus = 'version-metadata-unavailable';
      }
    }
    const partialMetadata = batches.some(batch => batch.modules.some(entry =>
      entry.metadataStatus !== 'PE-metadata-read' || entry.versionStatus !== 'read'));
    if (startup.diagnostics.status === 'not-started') startup.diagnostics.status = pending.length ? 'partial-depth-limit'
      : partialMetadata ? 'partial-metadata' : 'completed-helper-observations';
    save();
    startup.diagnostics.findingCount = findings.length;
  } catch {
    startup.diagnostics.status = 'partial-diagnostic-error';
    // Exception messages can contain arbitrary input; preserve only fixed status.
  }
  try { save(); } catch { /* Collection still fails with its original status. */ }
  return startup;
}
