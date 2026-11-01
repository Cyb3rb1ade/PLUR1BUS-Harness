// SPDX-License-Identifier: MIT
/** Trusted language preflight; only failures before candidate execution are infrastructure failures. */
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { executionEnvironment, IsolationUnavailable } from "./contract.mjs";
import { runOwnedCommand } from "./process.mjs";

/** The trusted repository toolchain is the only default Rust channel. */
export async function rustChannel() {
  const text = await readFile(new URL("../../../../../rust-toolchain.toml", import.meta.url), "utf8");
  const channel = /^channel\s*=\s*"([^"\r\n]+)"\s*$/m.exec(text)?.[1];
  if (!channel) throw new Error("missing trusted Rust channel");
  return channel;
}

async function executable(name, path = process.env.PATH ?? "") {
  if (name.includes("/")) return realpath(name);
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const target = resolve(directory, name);
    try {
      await access(target, constants.X_OK);
      return await realpath(target);
    } catch {
      // Continue through the trusted host's PATH, without invoking a shell.
    }
  }
  throw new IsolationUnavailable("toolchain-unavailable");
}

/** Build compiler/runtime environment using K2's allowlist and private caches. */
export async function languageRuntime(language, root, options) {
  const provided = options.runtimes?.[language];
  let program = provided?.program;
  if (!program) {
    const name = { typescript: process.execPath, python: "python3", rust: "rustc", go: "go" }[language];
    program = await executable(name);
    if (language === "rust" && /rustup$/.test(program)) {
      const rustup = await runOwnedCommand({
        program,
        args: ["which", "--toolchain", await rustChannel(), "rustc"],
        cwd: root,
        env: executionEnvironment({ ...process.env, HOME: homedir() }),
        timeoutMs: 10000,
      });
      if (rustup.code !== 0) throw new IsolationUnavailable("toolchain-unavailable");
      program = await realpath(rustup.stdout.trim());
    }
  }
  const cache = join(root, "cache");
  await mkdir(cache, { recursive: true });
  const env = executionEnvironment({
    PATH: `${dirname(program)}${delimiter}${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`,
    HOME: root,
    TMPDIR: root,
    CI: "1",
    LC_ALL: "C",
    TZ: "UTC",
    GOCACHE: cache,
    GOMODCACHE: join(cache, "modules"),
    GOPROXY: "off",
    GOSUMDB: "off",
    GOTOOLCHAIN: "local",
    CGO_ENABLED: "0",
    GOMAXPROCS: "2",
    CARGO_NET_OFFLINE: "true",
    RUSTUP_TOOLCHAIN: await rustChannel(),
    ...provided?.env,
  });
  const runtime = { program, env };
  const queries = {
    rust: ["--print", "sysroot"],
    go: ["env", "GOROOT"],
    python: ["-I", "-S", "-c", "import sys; print(sys.prefix)"],
  };
  const roots = [];
  if (queries[language]) {
    const result = await runOwnedCommand({
      ...runtime,
      args: queries[language],
      cwd: root,
      timeoutMs: 10000,
      signal: options.signal,
    });
    if (result.code !== 0 || result.reason || !isAbsolute(result.stdout.trim())) {
      throw new IsolationUnavailable("toolchain-unavailable");
    }
    roots.push(await realpath(result.stdout.trim()));
  }
  return { ...runtime, roots };
}

/** Compile and execute known-good authored code before considering any candidate output. */
export async function preflight(language, runtime, root, execute) {
  const source = join(root, "known-good");
  const bin = join(root, "known-good-bin");
  const definitions = {
    typescript: [
      ".ts",
      "enum Answer { Value = 7 }; process.stdout.write(String(Answer.Value));",
      ["--experimental-transform-types", "--no-warnings=ExperimentalWarning", source + ".ts"],
    ],
    python: [".py", "print(\"7\", end=\"\")", ["-I", "-S", "-B", "-X", "utf8", source + ".py"]],
    rust: [
      ".rs",
      "fn main() { print!(\"7\"); }",
      ["--edition=2024", "--crate-name", "known_good", source + ".rs", "-o", bin],
    ],
    go: [".go", "package main\nimport \"fmt\"\nfunc main() { fmt.Print(\"7\") }", ["build", "-o", bin, source + ".go"]],
  };
  const [extension, text, args] = definitions[language];
  await writeFile(source + extension, text);
  const first = await execute({ ...runtime, args, cwd: root });
  if (first.code !== 0 || first.reason) throw new IsolationUnavailable("toolchain-unavailable");
  const result = ["go", "rust"].includes(language)
    ? await execute({ program: bin, env: runtime.env, args: [], cwd: root })
    : first;
  if (result.code !== 0 || result.stdout !== "7" || result.reason) {
    throw new IsolationUnavailable("toolchain-unavailable");
  }
}
