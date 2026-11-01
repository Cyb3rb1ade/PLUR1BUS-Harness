// SPDX-License-Identifier: MIT
// Behavioral checker support, not a model/benchmark runner. K2 supplies the
// verifier sandbox for model-generated candidates. Self-tests use authored code.
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { seedValues } from './seed.mjs';
const exec = promisify(execFile);
const EXEC_LIMITS = { timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf8' };
const RUNTIME_KEYS = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir', 'SYSTEMDRIVE', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'];
const COMPILER_KEYS = [...RUNTIME_KEYS, 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'RUSTUP_HOME', 'CARGO_HOME', 'GOROOT', 'GOCACHE', 'GOPATH'];
function environment(keys) {
  return Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
}
function infrastructure(error) {
  if (error?.code === 'TOOLCHAIN_UNAVAILABLE') throw error;
}
async function execute(command, args, options) {
  try { return await exec(command, args, options); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const failure = new Error('fixture toolchain unavailable');
    failure.code = 'TOOLCHAIN_UNAVAILABLE';
    throw failure;
  }
}
function scopedTask(task, scope) {
  if (scope === 'e2e') return task;
  const entry = task.packages.find(item => item.id === scope);
  if (!entry) throw new Error('unknown checker scope');
  return { ...task, packages: [entry], endToEnd: { ...task.endToEnd, order: [entry.id] } };
}
function nodeProbe(task, entries) {
  return `const entries = ${JSON.stringify(entries)};\nconst symbols = ${JSON.stringify(Object.fromEntries(task.packages.map(item => [item.id, item.symbol])))};\nconst order = ${JSON.stringify(task.endToEnd.order)};\nconst [scope, input] = process.argv.slice(2);\nlet value = input;\nfor (const id of scope === 'e2e' ? order : [scope]) { const module = await import(entries[id]); value = await module[symbols[id]](value); if (typeof value !== 'string') throw Error('expected string'); }\nprocess.stdout.write(value);\n`;
}
function pythonProbe(task, entries) {
  return `import importlib.util, json, sys\nentries = json.loads(${JSON.stringify(JSON.stringify(entries))})\nsymbols = json.loads(${JSON.stringify(JSON.stringify(Object.fromEntries(task.packages.map(item => [item.id, item.symbol]))))})\norder = json.loads(${JSON.stringify(JSON.stringify(task.endToEnd.order))})\nvalue = sys.argv[2]\nfor index, key in enumerate(order if sys.argv[1] == 'e2e' else [sys.argv[1]]):\n    spec = importlib.util.spec_from_file_location('candidate_' + str(index), entries[key])\n    module = importlib.util.module_from_spec(spec)\n    spec.loader.exec_module(module)\n    value = getattr(module, symbols[key])(value)\n    if not isinstance(value, str):\n        raise TypeError('expected string')\nsys.stdout.write(value)\n`;
}
function rustProbe(task, entries) {
  const imports = task.packages.map((item, i) => `#[path = ${JSON.stringify(entries[item.id])}] mod p${i};`).join('\n');
  const call = item => `p${task.packages.indexOf(item)}::${item.symbol}(&value)`;
  const arms = task.packages.map(item => `${JSON.stringify(item.id)} => value = ${call(item)},`).join('\n');
  const pipeline = task.packages.map(item => `value = ${call(item)};`).join('\n');
  return `#![allow(dead_code)]\n${imports}\nfn main() { let args: Vec<String> = std::env::args().collect(); let mut value = args[2].clone(); match args[1].as_str() { ${arms} "e2e" => { ${pipeline} }, _ => panic!("unknown scope") } print!("{}", value); }\n`;
}
function goProbe(task) {
  const imports = task.packages.map((_, i) => `p${i} "fixture.local/checker/p${i}"`).join('\n');
  const call = item => `p${task.packages.indexOf(item)}.${item.symbol}(value)`;
  const arms = task.packages.map(item => `case ${JSON.stringify(item.id)}: value = ${call(item)}`).join('\n');
  const pipeline = task.packages.map(item => `value = ${call(item)}`).join('\n');
  return `package main\nimport ("fmt"; "os"; ${imports})\nfunc main() { value := os.Args[2]; switch os.Args[1] { ${arms}\ncase "e2e": ${pipeline}\ndefault: panic("unknown scope") }; fmt.Print(value) }\n`;
}

export async function createProbe(fullTask, candidateRoot, seed, scope = 'e2e') {
  const task = scopedTask(fullTask, scope);
  const directory = await mkdtemp(join(tmpdir(), 'p1b-team-probe-'));
  const tag = seedValues(seed).tag;
  const paths = Object.fromEntries(task.packages.map(item => [item.id, resolve(candidateRoot, item.entry.replaceAll('__SEED__', tag))]));
  let command, args;
  try {
    const root = await realpath(candidateRoot);
    for (const file of Object.values(paths)) {
      const stat = await lstat(file), inside = relative(root, await realpath(file));
      if (!stat.isFile() || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || isAbsolute(inside)) throw new Error('candidate entry must be a regular file inside its tree');
    }
    if (task.language === 'typescript') {
      const file = join(directory, 'probe.mjs');
      await writeFile(file, nodeProbe(task, Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, pathToFileURL(value).href]))));
      command = process.execPath; args = ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', file];
    } else if (task.language === 'python') {
      const file = join(directory, 'probe.py');
      await writeFile(file, pythonProbe(task, paths));
      command = process.platform === 'win32' ? 'python' : 'python3'; args = ['-I', '-B', '-X', 'utf8', file];
    } else if (task.language === 'rust') {
      const source = join(directory, 'probe.rs'), binary = join(directory, process.platform === 'win32' ? 'probe.exe' : 'probe');
      await writeFile(source, rustProbe(task, paths));
      await execute('rustc', ['--edition=2024', source, '-o', binary], { ...EXEC_LIMITS, cwd: directory, env: { ...environment(COMPILER_KEYS), RUSTUP_TOOLCHAIN: '1.95', RUSTUP_AUTO_INSTALL: '0' } });
      command = binary; args = [];
    } else if (task.language === 'go') {
      const binary = join(directory, process.platform === 'win32' ? 'probe.exe' : 'probe');
      // The private build has no candidate-controlled go.mod, toolchain or replace.
      for (const [index, item] of task.packages.entries()) {
        const destination = join(directory, `p${index}`);
        await mkdir(destination);
        await writeFile(join(destination, 'solution.go'), await readFile(paths[item.id], 'utf8'));
      }
      await writeFile(join(directory, 'go.mod'), 'module fixture.local/checker\ngo 1.22\n');
      await writeFile(join(directory, 'main.go'), goProbe(task));
      await execute('go', ['build', '-o', binary, '.'], { ...EXEC_LIMITS, cwd: directory, env: { ...environment(COMPILER_KEYS), GOWORK: 'off', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local', GOENV: 'off', CGO_ENABLED: '0', GOFLAGS: '-mod=readonly' } });
      command = binary; args = [];
    } else throw new Error('unsupported fixture language');
    return {
      async invoke(key, input) { return (await execute(command, [...args, key, input], { ...EXEC_LIMITS, env: environment(RUNTIME_KEYS) })).stdout; },
      async close() { await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function validateCases(cases, scopes) {
  for (const key of scopes) {
    if (!Object.hasOwn(cases, key) || !Array.isArray(cases[key]) || !cases[key].length) throw new Error('checker scope requires nonempty cases');
    const ids = new Set();
    for (const item of cases[key]) {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.input !== 'string' || typeof item.expected !== 'string') throw new Error('invalid checker case');
      ids.add(item.id);
    }
  }
}
export async function verify(taskRoot, candidateRoot, seed, scope = 'all') {
  const task = JSON.parse(await readFile(join(taskRoot, 'task.json'), 'utf8'));
  if (!task.seeds.includes(seed)) throw new Error('seed is not declared by this task');
  const instance = JSON.parse(await readFile(join(candidateRoot, 'instance.json'), 'utf8'));
  if (instance.taskId !== task.id || instance.seed !== seed) throw new Error('candidate instance does not match task and seed');
  const { casesForSeed } = await import(pathToFileURL(join(taskRoot, task.seedGenerator)).href);
  const cases = casesForSeed(seed), scopes = scope === 'all' ? [...task.packages.map(item => item.id), 'e2e'] : [scope];
  validateCases(cases, scopes);
  const checks = [];
  for (const key of scopes) {
    let probe, reason;
    const failures = new Set();
    try {
      probe = await createProbe(task, candidateRoot, seed, key);
      for (const item of cases[key]) {
        try { if (await probe.invoke(key, item.input) !== item.expected) failures.add(item.id); }
        catch (error) { infrastructure(error); reason = 'candidate-error'; failures.add(item.id); }
      }
    } catch (error) {
      infrastructure(error);
      reason = 'candidate-error';
      for (const item of cases[key]) failures.add(item.id);
    } finally { if (probe) await probe.close(); }
    checks.push({ scope: key, passed: failures.size === 0, cases: cases[key].length, failures: [...failures], ...(reason ? { reason } : {}) });
  }
  return { schema: 'plur1bus.team-check/1', taskId: task.id, seed, passed: checks.every(check => check.passed), checks };
}
export async function checkerCli(taskRoot) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== '--candidate' || args[2] !== '--seed' || args[4] !== '--scope') throw new Error('use --candidate <tree> --seed <uint32> --scope <package|e2e|all>');
    const result = await verify(taskRoot, resolve(args[1]), Number(args[3]), args[5]);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    const reason = error?.code === 'TOOLCHAIN_UNAVAILABLE' ? 'toolchain-unavailable' : 'checker-error';
    process.stdout.write(JSON.stringify({ schema: 'plur1bus.team-check/1', passed: false, reason, checks: [] }) + '\n');
    process.exitCode = 1;
  }
}
