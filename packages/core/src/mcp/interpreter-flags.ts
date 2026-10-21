// ADR-014 §7: the command allowlist names a program, not its argument vector. An allowlisted interpreter that is handed
// inline code (`node -e`, `python -c`, `sh -c`, ...) is arbitrary code under the harness user's rights, so those arguments
// need an explicit approval of their own (`McpPolicy.inlineCodeCommands`). This module only classifies; it starts nothing.
//
// The scan stops at the first positional argument: from there on the arguments belong to the script, so `python server.py -c cfg`
// stays a normal script launch. Where an interpreter has too many options to list those that take a separate value (node, bun),
// an unknown long option may consume the next token and the scan goes on, which errs towards flagging, never towards allowing.
// Wrappers that merely run another program (`env`, `busybox`, `xargs`, `sudo`, `nice`, `timeout`) are not interpreted here:
// they have no business on the allowlist, because the program they launch is not the one the allowlist named.
import { win32 } from "node:path";

export type InterpreterFamily = "node" | "deno" | "python" | "shell" | "perl" | "ruby" | "php" | "lua" | "rscript" | "powershell" | "cmd" | "npx";

const FAMILY: ReadonlyArray<readonly [RegExp, InterpreterFamily]> = [
  [/^(node|nodejs|bun)$/, "node"], [/^deno$/, "deno"],
  [/^(python|pypy)(\d+(\.\d+)*)?$/, "python"],
  [/^(sh|bash|dash|zsh|ksh|ash|csh|tcsh|fish)$/, "shell"],
  [/^perl(\d+(\.\d+)*)?$/, "perl"], [/^ruby(\d+(\.\d+)*)?$/, "ruby"], [/^php(\d+(\.\d+)*)?$/, "php"], [/^(lua|luajit)(\d+(\.\d+)*)?$/, "lua"],
  [/^r(script)?$/, "rscript"], [/^(powershell|pwsh)$/, "powershell"], [/^cmd$/, "cmd"], [/^npx$/, "npx"],
];

/** The interpreter a command names, by file name alone: any path, case, version suffix or `.exe`. */
export function interpreterFamily(command: string): InterpreterFamily | null {
  const base = win32.basename(command).toLowerCase().replace(/\.exe$/, "");
  for (const [re, family] of FAMILY) if (re.test(base)) return family;
  return null;
}

interface Spec {
  /** Long (or whole short) option names that carry inline code. */
  names: readonly string[];
  /** Short option letters that carry inline code, also inside a cluster such as `-lc`. */
  cluster: string;
  /** Short letters whose value is the rest of the token, or the next token when nothing follows. */
  valueShort: string;
  /** Short letters whose value is the rest of the token only. */
  attachShort: string;
  /** Short letters after which the remaining arguments belong to a module or file (`python -m mod args`). */
  stopShort: string;
  /** Long options whose value may be the next token. */
  valueLong: readonly string[];
  /** Node-like runtimes: an unknown long option without `=` may consume the next token. */
  anyLongValue?: true;
  /** A first positional argument that is itself the inline-code command (`deno eval`). */
  subcommands?: readonly string[];
}
const S = (o: Partial<Spec>): Spec => ({ names: [], cluster: "", valueShort: "", attachShort: "", stopShort: "", valueLong: [], ...o });

const SPECS: Record<Exclude<InterpreterFamily, "powershell" | "cmd">, Spec> = {
  node: S({ names: ["--eval", "--print"], cluster: "ep", valueShort: "rC", anyLongValue: true,
    valueLong: ["--require", "--import", "--loader", "--experimental-loader", "--input-type", "--env-file", "--env-file-if-exists", "--conditions", "--title", "--disable-warning", "--experimental-default-type", "--redirect-warnings", "--watch-path", "--run", "--test-name-pattern", "--test-reporter", "--test-reporter-destination", "--diagnostic-dir", "--dns-result-order", "--icu-data-dir", "--openssl-config", "--report-dir", "--report-directory", "--report-filename", "--report-signal", "--unhandled-rejections", "--cpu-prof-dir", "--heap-prof-dir"] }),
  deno: S({ names: ["--eval"], subcommands: ["eval", "repl"], valueLong: ["--config", "--import-map", "--lock", "--cert", "--location", "--seed", "--v8-flags"] }),
  python: S({ cluster: "c", valueShort: "WXQ", stopShort: "m", valueLong: ["--check-hash-based-pycs"] }),
  shell: S({ names: ["--command"], cluster: "c", valueShort: "oO", valueLong: ["--rcfile", "--init-file"] }),
  perl: S({ cluster: "eE", valueShort: "IMm", attachShort: "xdDVCiF" }),
  ruby: S({ cluster: "e", valueShort: "IrCE", attachShort: "KWxFi" }),
  php: S({ cluster: "rRBE", valueShort: "dcz", stopShort: "fF" }),
  lua: S({ cluster: "e", valueShort: "lW" }),
  rscript: S({ cluster: "e" }),
  npx: S({ names: ["--call"], cluster: "c", valueShort: "pw", valueLong: ["--package", "--prefix", "--cache", "--userconfig", "--registry", "--loglevel", "--workspace", "--shell"] }),
};

// Node-like options that are plain switches (or take their value after `=`): a positional after them is the script.
const SWITCH = /^--(no-|experimental-|enable-|disable-|trace-|expose-|harmony|use-|allow-|unstable|abort-|preserve-|pending-|throw-|verify-|force-|insecure-|zero-|frozen-|prof$|check$|watch$|test$|inspect(-brk)?$|interactive$)/;

function scan(spec: Spec, args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return null;
    if (!a.startsWith("-") && !a.startsWith("+") || a.length === 1) return spec.subcommands?.includes(a) ? a : null; // the script (or `-`, stdin): the rest is its own
    if (a.startsWith("--")) {
      const name = a.split("=", 1)[0]!;
      if (spec.names.includes(name)) return name;
      if (a.includes("=")) continue;
      const next = args[i + 1];
      if (spec.valueLong.includes(name) || spec.anyLongValue && !SWITCH.test(name) && next !== undefined && !next.startsWith("-")) i++;
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const c = a[k]!;
      if (a[0] === "-" && spec.cluster.includes(c)) return `-${c}`;
      if (spec.stopShort.includes(c)) return null;
      if (spec.valueShort.includes(c)) { if (k === a.length - 1) i++; break; }
      if (spec.attachShort.includes(c)) break;
    }
  }
  return null;
}

const isPrefix = (name: string, full: string): boolean => name.length > 0 && full.startsWith(name);
const PS_VALUE = ["executionpolicy", "windowstyle", "inputformat", "outputformat", "configurationname", "configurationfile", "version", "psconsolefile", "workingdirectory", "settingsfile", "custompipename"];

// PowerShell accepts any unambiguous prefix of a parameter name and treats the first positional argument as `-Command`.
function scanPowerShell(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-" || a === "--") return null;
    if (!/^[-/–—]/.test(a)) return "(positional command)";
    const name = a.slice(1).split(":", 1)[0]!.toLowerCase();
    if (isPrefix(name, "command") || isPrefix(name, "commandwithargs") || isPrefix(name, "encodedcommand")) return "-Command";
    if (isPrefix(name, "file")) return null;
    if (!a.includes(":") && name.length >= 2 && PS_VALUE.some(v => isPrefix(name, v))) i++;
  }
  return null;
}

// `cmd /c`, `/k` and `/r` run the rest of the line; they may sit in a run such as `/d/s/c`, with the text attached.
const scanCmd = (args: readonly string[]): string | null => {
  for (const a of args) if (a.startsWith("/") && a.split("/").some(seg => /^[ckr]/i.test(seg))) return "/c";
  return null;
};

/**
 * The inline-code option an interpreter command line carries, as the option's own name (never the code), or null when the
 * command is no known interpreter or is launching a script, module or file.
 */
export function inlineCodeFlag(command: string, args: readonly string[]): string | null {
  const family = interpreterFamily(command);
  if (family === null) return null;
  if (family === "powershell") return scanPowerShell(args);
  if (family === "cmd") return scanCmd(args);
  return scan(SPECS[family], args);
}
