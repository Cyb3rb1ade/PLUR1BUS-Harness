/** Compile original/candidate Rust and Go in a private build root; execution receives only sealed executable bytes. */
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CodingTask, CodingVariant } from "./coding-bench-corpus.ts";
import { CodingCaseFailure, freshCodingFile, type CodingBox } from "./coding-bench-box.ts";
import { copyCodingRuntime, type CodingRuntimes } from "./coding-bench-runtime.ts";
import { writeCodingImage, type CodingImage } from "./coding-bench-workspace.ts";

async function bridge(corpus: string, language: "rust" | "go", args: string[]): Promise<string> {
  const module: unknown = await import(pathToFileURL(join(corpus, `bridge-${language}.mjs`)).href);
  const fn = (module as Record<string, unknown>)[`${language}Bridge`];
  if (typeof fn !== "function") throw new CodingCaseFailure("missing invocation bridge");
  const result: unknown = await fn(...args);
  if (typeof result !== "string") throw new CodingCaseFailure("invalid invocation bridge");
  return result;
}

/** Compile once per candidate; compiler trees are fresh copies, then destroyed before candidate execution. */
export async function compileCodingImage(
  task: CodingTask,
  variant: CodingVariant,
  image: CodingImage,
  options: { mode: "fixture" | "live"; runtimes: CodingRuntimes; box: CodingBox; executionRoot: string },
): Promise<Buffer | undefined> {
  const language = task.meta.language;
  if (language !== "rust" && language !== "go") return undefined;
  const parent = options.mode === "live" ? options.executionRoot : tmpdir();
  const root = await realpath(await mkdtemp(join(parent, "p1b-coding-build-")));
  try {
    const candidate = join(root, "candidate");
    await mkdir(candidate, { mode: 0o700 });
    await writeCodingImage(candidate, image);
    const output = join(root, "coding-program");
    let program: string;
    let args: string[];
    let env: NodeJS.ProcessEnv = {};
    if (language === "rust") {
      let sysroot = options.runtimes.rustRoot;
      program = options.runtimes.rustc;
      if (options.mode === "live") {
        sysroot = join(root, "rust-runtime");
        await copyCodingRuntime(options.runtimes.rustRoot, sysroot);
        program = join(sysroot, "bin", "rustc");
      }
      let entry = join(candidate, variant.entry);
      if (task.meta.kind === "repository") {
        const source = await bridge(dirname(task.directory), "rust", [
          task.meta.id,
          `candidate/${variant.entry}`,
          variant.symbol,
        ]);
        entry = await freshCodingFile(root, "coding-bridge.rs", source);
      }
      args = [
        "--edition=2021",
        "--crate-name",
        "coding_task",
        "--sysroot",
        sysroot,
        "-C",
        "debuginfo=0",
        entry,
        "-o",
        output,
      ];
    } else {
      let goroot = options.runtimes.goRoot;
      program = options.runtimes.go;
      if (options.mode === "live") {
        goroot = join(root, "go-runtime");
        await copyCodingRuntime(options.runtimes.goRoot, goroot);
        program = join(goroot, "bin", "go");
      }
      env = {
        GOROOT: goroot,
        GOCACHE: options.mode === "live" ? join(root, "go-cache") : join(options.runtimes.cache, "go-cache"),
        GOTOOLCHAIN: "local",
        GOMAXPROCS: "2",
        GOMODCACHE: join(root, "go-modules"),
        GOPROXY: "off",
        GOSUMDB: "off",
        CGO_ENABLED: "0",
      };
      if (task.meta.kind === "repository") {
        const source = await bridge(dirname(task.directory), "go", [task.meta.id, variant.symbol]);
        await freshCodingFile(candidate, "coding_private_bridge_test.go", source);
        args = ["-C", candidate, "test", "-c", "-buildvcs=false", "-vet=off", "-p=1", "-o", output];
      } else args = ["-C", candidate, "build", "-buildvcs=false", "-p=1", "-o", output, "."];
    }
    const sandboxRoot = options.mode === "live" ? options.executionRoot : root;
    const compiled = await options.box({ root: sandboxRoot, program, args, cwd: candidate, env, timeoutMs: 60_000 });
    if (compiled.code !== 0) throw new CodingCaseFailure("candidate compilation failed");
    const stat = await lstat(output);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 33_554_432)
      throw new CodingCaseFailure("invalid executable");
    return await readFile(output);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
