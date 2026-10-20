import path from 'node:path';
import { stat } from 'node:fs/promises';
/**
 * Which programs a command line really starts. A wrapper (`env`, `nice`, `timeout`, `xargs`, `busybox`, ...) hands its
 * first non-option argument to the operating system, so a check that only looks at argv[0] sees `env` and not `bash`
 * or `rm`. Everything here is a pure function over argv; nothing touches the file system.
 */
export interface Command { program: string; args: string[] }
interface Wrapper {
  /** Options that take the next argument as their value. */
  valued: readonly string[];
  /** Options that take none. Any other option makes the parse unsure, and every argument becomes a candidate. */
  flags?: readonly string[];
  /** Positional arguments before the command (`timeout DURATION cmd`). */
  skip?: number;
  /** `NAME=value` arguments before the command (`env`). */
  assign?: boolean;
  /** Do not parse: every argument may start the real command. For wrappers whose syntax is too varied to track. */
  scan?: boolean;
}
const WRAPPERS: Readonly<Record<string, Wrapper>> = {
  env: { valued: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'], flags: ['-i', '--ignore-environment', '-0', '--null', '-v', '--debug', '-'], assign: true },
  timeout: { valued: ['-s', '--signal', '-k', '--kill-after'], flags: ['--foreground', '--preserve-status', '-v', '--verbose'], skip: 1 },
  xargs: { valued: ['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '--max-lines', '--eof', '--process-slot-var'], flags: ['-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-p', '--interactive', '-x', '--exit', '-o', '--open-tty', '-e', '-i', '-l'] },
  nice: { valued: ['-n', '--adjustment'] },
  nohup: { valued: [] },
  busybox: { valued: [] },
  sudo: { valued: ['-u', '--user', '-g', '--group', '-C', '-D', '-R', '-h', '-p', '-r', '-t', '-U', '-T'] },
  doas: { valued: ['-u', '-C'] },
  command: { valued: [] },
  exec: { valued: ['-a'] },
  time: { valued: ['-f', '-o', '--format', '--output'] },
  setsid: { valued: [] },
  stdbuf: { valued: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  ionice: { valued: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata'] },
  taskset: { valued: [], scan: true }, chrt: { valued: [], scan: true }, flock: { valued: [], scan: true }, strace: { valued: [], scan: true },
  watch: { valued: [], scan: true }, caffeinate: { valued: [], scan: true }, nsenter: { valued: [], scan: true }, unshare: { valued: [], scan: true },
  chroot: { valued: [], scan: true }, runuser: { valued: [], scan: true }, setpriv: { valued: [], scan: true },
};
/** Basename without directory or `.exe`, lower-cased, for either path separator. */
export const baseName = (program: string): string => (program.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '').toLowerCase();
const SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish', 'pwsh', 'powershell', 'cmd', 'ash', 'ksh', 'mksh', 'csh', 'tcsh', 'hush', 'wsl']);
export const isShellProgram = (program: string): boolean => SHELLS.has(baseName(program));
const MAX_DEPTH = 8;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!']);

/** The commands that really run: the given one, and what each wrapper in it hands on, to any depth. */
export function effectiveCommands(program: string, args: readonly string[]): Command[] {
  const found: Command[] = [];
  const walk = (prog: string, argv: readonly string[], depth: number): void => {
    found.push({ program: prog, args: [...argv] });
    const wrapper = WRAPPERS[baseName(prog)];
    if (!wrapper || depth >= MAX_DEPTH) return;
    const every = () => { for (let i = 0; i < argv.length; i++) walk(argv[i]!, argv.slice(i + 1), depth + 1); };
    if (wrapper.scan) return every();
    let positionals = 0; let i = 0; let unsure = false;
    for (; i < argv.length; i++) {
      const token = argv[i]!;
      if (token === '--') { i++; break; }
      if (wrapper.assign && ASSIGNMENT.test(token)) continue;
      if (token.startsWith('-') && (token.length > 1 || wrapper.flags?.includes('-'))) {
        const name = token.split('=')[0]!;
        const split = baseName(prog) === 'env' && (name === '-S' || name === '--split-string' || /^-S./.test(token));
        if (split) {
          // env -S "bash -c id": the value is itself a command line.
          const value = token.startsWith('--') ? (token.includes('=') ? token.slice(token.indexOf('=') + 1) : argv[++i] ?? '') : token.length > 2 ? token.slice(2) : argv[++i] ?? '';
          const parts = value.split(/\s+/).filter(Boolean);
          if (parts.length > 0) walk(parts[0]!, [...parts.slice(1), ...argv.slice(i + 1)], depth + 1);
          return;
        }
        if (wrapper.valued.includes(token)) { i++; continue; }
        if (token.includes('=') && wrapper.valued.includes(name)) continue;
        // `-n10`, `-oL`: a valued short option with its value attached.
        if (/^-[A-Za-z]./.test(token) && wrapper.valued.includes(token.slice(0, 2))) continue;
        if (wrapper.flags?.includes(token)) continue;
        unsure = true; continue;
      }
      if (positionals < (wrapper.skip ?? 0)) { positionals++; continue; }
      break;
    }
    if (unsure) return every();
    if (i < argv.length) walk(argv[i]!, argv.slice(i + 1), depth + 1);
  };
  walk(program, args, 0);
  return found;
}

const DRIVE_ROOT = /^[a-z]:[\\/]*\*?$/i;
/** `/`, `//`, `/.`, `/..`, `/a/../..`, `/*`, `C:\`, `C:/*`: everything a recursive removal there would take. */
function isRootOperand(operand: string): boolean {
  if (DRIVE_ROOT.test(operand)) return true;
  const unified = operand.replace(/\\/g, '/');
  if (!unified.startsWith('/')) return false;
  return path.posix.normalize(unified.replace(/\*+$/, '')) === '/';
}
/** `rm` flags parsed one by one, so `-r -f`, `-fr`, `-R`, `--recursive` and abbreviations such as `--recur` all count. */
export function removesRoot(args: readonly string[]): boolean {
  let recursive = false; let operandsOnly = false; const operands: string[] = [];
  for (const arg of args) {
    if (!operandsOnly && arg === '--') { operandsOnly = true; continue; }
    if (!operandsOnly && arg.startsWith('--')) { const name = arg.split('=')[0]!; if (name.length > 2 && '--recursive'.startsWith(name)) recursive = true; continue; }
    if (!operandsOnly && /^-[^-]/.test(arg)) { if (/[rR]/.test(arg)) recursive = true; continue; }
    operands.push(arg);
  }
  return recursive && operands.some(isRootOperand);
}
/** True when a command that starts `rm` (directly or behind a wrapper) would recursively remove a file system root. */
export const removesRootBehind = (commands: readonly Command[]): boolean => commands.some(c => baseName(c.program) === 'rm' && removesRoot(c.args));

/** The simple commands of a shell command line, split at `; & | ( ) { }`, newlines and substitutions, quotes removed. Coarse on purpose: it only has to see `rm`. */
export function shellCommands(commandLine: string): Command[] {
  const result: Command[] = [];
  for (const segment of commandLine.split(/\$\(|[;&|(){}`\n\r]/)) {
    const tokens = segment.replace(/["']/g, '').split(/\s+/).filter(Boolean);
    while (tokens.length > 0 && (ASSIGNMENT.test(tokens[0]!) || RESERVED.has(tokens[0]!))) tokens.shift();
    if (tokens.length > 0) result.push({ program: tokens[0]!, args: tokens.slice(1) });
  }
  return result;
}

/** Extensions whose "open" runs code: Windows programs and scripts, macOS bundles and Terminal scripts, Linux launchers. */
const LAUNCHABLE = /\.(?:exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|scr|pif|cpl|reg|jar|command|tool|app|workflow|action|pkg|mpkg|desktop|appimage)$/i;
/** True when opening the canonical path would start a program: a launchable extension, or a regular file with an execute bit. */
export async function launchesProgram(canonical: string): Promise<boolean> {
  if (LAUNCHABLE.test(canonical.replace(/[\\/]+$/, ''))) return true;
  if (process.platform === 'win32') return false;
  try { const s = await stat(canonical); return s.isFile() && (s.mode & 0o111) !== 0; } catch { return false; }
}
