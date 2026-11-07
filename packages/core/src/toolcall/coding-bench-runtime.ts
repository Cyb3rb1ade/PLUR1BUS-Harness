/** Private compiler staging for B1. Original runtime files are never hardlinked into writable task sandboxes. */
import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runCodingCommand } from "./coding-bench-process.ts";

/** Bound trusted runtime traversal too; test data/docs are not needed by these standard-library tasks. */
export interface CodingRuntimeCopyOptions {
  maxFiles?: number;
  maxBytes?: number;
}

/** Copy/COW a trusted runtime, flattening only internal links; never create writable aliases of the original. */
export async function copyCodingRuntime(
  source: string,
  destination: string,
  options: CodingRuntimeCopyOptions = {},
): Promise<void> {
  const root = await realpath(source);
  const target = resolve(destination);
  if (!isAbsolute(destination) || target === root || target.startsWith(root + sep)) {
    throw new Error("invalid coding runtime destination");
  }
  const skipped = new Set([".git", "testdata", "doc", "docs", "test", "misc", "api", "share"]);
  let count = 0;
  let bytes = 0;
  async function copy(from: string, to: string, ancestors: ReadonlySet<string>): Promise<void> {
    const actual = await realpath(from);
    if (actual !== root && !actual.startsWith(root + sep)) throw new Error("coding runtime link refused");
    const stat = await lstat(actual);
    if (stat.isDirectory()) {
      if (ancestors.has(actual) || ancestors.size > 32) throw new Error("coding runtime link cycle");
      await mkdir(to, { mode: 0o700 });
      const next = new Set([...ancestors, actual]);
      for (const name of (await readdir(actual)).sort()) {
        if (!skipped.has(name)) await copy(join(actual, name), join(to, name), next);
      }
    } else {
      bytes += stat.size;
      if (!stat.isFile() || ++count > (options.maxFiles ?? 80_000) || bytes > (options.maxBytes ?? 4 * 1024 ** 3))
        throw new Error("coding runtime copy limit");
      try {
        await copyFile(actual, to, constants.COPYFILE_FICLONE);
      } catch {
        await copyFile(actual, to, constants.COPYFILE_EXCL);
      }
      await chmod(to, stat.mode & 0o111 ? 0o700 : 0o600);
    }
  }
  await copy(root, target, new Set());
}

/** Actual executable paths and private fixture caches; no provider configuration or credential fields. */
export interface CodingRuntimes {
  node: string;
  rustc: string;
  rustRoot: string;
  go: string;
  goRoot: string;
  python: string;
  shell: string;
  cache: string;
  versions: { node: string; rust: string; go: string; python: string };
  close(): Promise<void>;
}

async function executable(name: string, system = false): Promise<string> {
  const paths = isAbsolute(name)
    ? [name]
    : (system ? ["/usr/bin", "/bin"] : (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)).map((path) =>
        join(path, name),
      );
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      const actual = await realpath(path);
      const stat = await lstat(actual);
      if (!stat.isFile() || stat.mode & 0o022 || ![0, process.getuid?.()].includes(stat.uid)) continue;
      return actual;
    } catch {
      /* Try the next trusted installed runtime; never download one. */
    }
  }
  throw new Error("coding runtime unavailable");
}

export type CodingRuntimePhase = "toolchain-file" | "rustc" | "rust-sysroot" | "go" | "go-root"
  | "python" | "shell" | "rust-version" | "go-version" | "python-version";

/** Inspect installed tools before any model runs; missing tools refuse, never trigger a bootstrap/download. */
export async function resolveCodingRuntimes(
  live: boolean, signal: AbortSignal, onPhase?: (phase: CodingRuntimePhase) => void,
): Promise<CodingRuntimes> {
  if (process.platform === "win32" || (live && process.platform !== "linux")) {
    throw new Error("coding runtime platform unavailable");
  }
  const cache = await realpath(await mkdtemp(join(tmpdir(), "p1b-coding-runtime-")));
  try {
    const repository = fileURLToPath(new URL("../../../../", import.meta.url));
    onPhase?.("toolchain-file");
    const toolchain = await readFile(join(repository, "rust-toolchain.toml"), "utf8");
    const channel = /channel\s*=\s*"([^"]+)"/u.exec(toolchain)?.[1];
    if (!channel) throw new Error("coding Rust toolchain unavailable");
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: cache,
      CI: "1",
      LC_ALL: "C",
      RUSTUP_TOOLCHAIN: channel,
      GOTOOLCHAIN: "local",
      GOPROXY: "off",
      GOSUMDB: "off",
    };
    const query = async (program: string, args: string[], root = cache): Promise<string> => {
      const result = await runCodingCommand(program, args, { root, env, signal, timeoutMs: 30_000 });
      if (result.reason || result.code !== 0) throw new Error("coding runtime query unavailable");
      return result.stdout.trim();
    };
    onPhase?.("rustc");
    let rustc = await executable("rustc");
    if (basename(rustc) === "rustup") rustc = await executable(await query(rustc, ["which", "rustc"], repository));
    onPhase?.("rust-sysroot");
    const rustRoot = await realpath(await query(rustc, ["--print", "sysroot"]));
    onPhase?.("go");
    const go = await executable("go");
    onPhase?.("go-root");
    const goRoot = await realpath(await query(go, ["env", "GOROOT"]));
    onPhase?.("python");
    const python = await executable("python3", live);
    onPhase?.("shell");
    const shell = await executable("/bin/sh");
    onPhase?.("rust-version");
    const rustVersion = /rustc ([0-9.]+)/u.exec(await query(rustc, ["--version"]))?.[1];
    onPhase?.("go-version");
    const goVersion = /go([0-9.]+)/u.exec(await query(go, ["version"]))?.[1];
    onPhase?.("python-version");
    const pythonVersion = /Python ([0-9.]+)/u.exec(await query(python, ["--version"]))?.[1];
    if (!rustVersion || !goVersion || !pythonVersion) throw new Error("coding runtime version unavailable");
    await mkdir(join(cache, "go-cache"), { mode: 0o700 });
    return {
      node: process.execPath,
      rustc,
      rustRoot,
      go,
      goRoot,
      python,
      shell,
      cache,
      versions: { node: process.versions.node, rust: rustVersion, go: goVersion, python: pythonVersion },
      close: () => rm(cache, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(cache, { recursive: true, force: true });
    throw error;
  }
}

/** Trusted fixture compiler environment; live compiler environments are constructed inside the verifier. */
export function codingRuntimeEnvironment(runtime: CodingRuntimes, root: string): NodeJS.ProcessEnv {
  return {
    PATH: [dirname(runtime.node), dirname(runtime.rustc), dirname(runtime.go), "/usr/bin", "/bin"].join(delimiter),
    HOME: root,
    TMPDIR: root,
    CI: "1",
    LC_ALL: "C",
    GOTOOLCHAIN: "local",
    GOROOT: runtime.goRoot,
    GOCACHE: join(runtime.cache, "go-cache"),
    GOMODCACHE: join(root, "go-modules"),
    GOPROXY: "off",
    GOSUMDB: "off",
    CGO_ENABLED: "0",
    GOMAXPROCS: "2",
    CARGO_NET_OFFLINE: "true",
  };
}
