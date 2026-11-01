/** B1 private end-state coordinator. Hidden expected answers stay outside candidate verifier roots. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { VerifierPort } from "../collab/verifier.ts";
import type { CodingTask, CodingVariant } from "./coding-bench-corpus.ts";
import {
  createCodingBox,
  CodingCaseFailure,
  CodingIsolationUnavailable,
  freshCodingFile,
  type CodingBoxResult,
} from "./coding-bench-box.ts";
import { CodingCheckFiles } from "./coding-bench-check-files.ts";
import { compileCodingImage } from "./coding-bench-compile.ts";
import { codingRuntimeEnvironment, type CodingRuntimes } from "./coding-bench-runtime.ts";
import { writeCodingImage, type CodingImage } from "./coding-bench-workspace.ts";

/** A compile/assertion failure is unresolved; unavailable isolation invalidates the evidence instead. */
export interface CodingCheckResult {
  passed: boolean;
  unavailable: boolean;
  reason: "passed" | "unresolved" | "unavailable" | "aborted";
  wallMs: number;
}
/** Trusted fixture execution is explicit and never selected after a live-sandbox failure. */
export interface CodingCheckOptions {
  mode: "fixture" | "live";
  runtimes: CodingRuntimes;
  signal: AbortSignal;
  verifier?: VerifierPort;
  /** Live roots must be allocated by the shared provisioner; fixture mode alone owns ordinary trusted temp copies. */
  provision?: () => Promise<{ root: string; close(): Promise<void> }>;
  /** Local development diagnostics for original fixtures only; callers must keep them private. */
  onFixtureFailure?: (error: unknown) => void;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CodingCaseFailure("invalid bridge input");
  return value as Record<string, unknown>;
}
function decoded(result: CodingBoxResult): unknown {
  if (result.code !== 0) throw new CodingCaseFailure("candidate execution failed");
  return JSON.parse(result.stdout);
}

/** Verify a frozen candidate after the subject has ended, restoring code/bridges for every independent call. */
export async function verifyCodingTask(
  task: CodingTask,
  variant: CodingVariant,
  image: CodingImage,
  options: CodingCheckOptions,
): Promise<CodingCheckResult> {
  const began = performance.now();
  const verdict = (reason: CodingCheckResult["reason"]): CodingCheckResult => ({
    passed: reason === "passed",
    unavailable: reason === "unavailable",
    reason,
    wallMs: performance.now() - began,
  });
  if (process.platform === "win32" || (options.mode === "live" && process.platform !== "linux")) {
    return verdict("unavailable");
  }
  if (options.mode === "live" && !options.provision) return verdict("unavailable");
  const workspace = options.mode === "live" ? await options.provision!() : undefined;
  const root = workspace?.root ?? (await realpath(await mkdtemp(join(tmpdir(), "p1b-coding-check-"))));
  try {
    if (!image.has(variant.entry)) throw new CodingCaseFailure("candidate entry missing");
    const corpus = dirname(task.directory);
    const source = async (name: string): Promise<string> => readFile(join(corpus, name), "utf8");
    const captureSource = await source("bridge-command.mjs");
    const box = createCodingBox({
      mode: options.mode,
      node: options.runtimes.node,
      environment: codingRuntimeEnvironment(options.runtimes, root),
      captureSource,
      signal: options.signal,
      ...(options.verifier ? { verifier: options.verifier } : {}),
    });
    const binary = await compileCodingImage(task, variant, image, {
      mode: options.mode,
      runtimes: options.runtimes,
      box,
      executionRoot: root,
    });
    const candidate = join(root, "candidate");
    const data = join(root, "data");
    await mkdir(data, { mode: 0o700 });
    const files = new CodingCheckFiles(data);
    const reset = async (): Promise<void> => {
      await rm(candidate, { recursive: true, force: true });
      await mkdir(candidate, { mode: 0o700 });
      await writeCodingImage(candidate, image);
      if (binary) await freshCodingFile(root, "coding-program", binary, 0o700);
    };
    const python = async (input: unknown, operation?: string): Promise<unknown> => {
      await reset();
      const script = await freshCodingFile(root, "coding-python.py", await source("bridge-python.py"));
      const setup = await freshCodingFile(
        root,
        "coding-python.json",
        JSON.stringify({
          id: task.meta.id,
          entry: join(candidate, variant.entry),
          symbol: variant.symbol,
          input,
          ...(operation ? { operation } : {}),
        }),
      );
      return decoded(
        await box({ root, program: options.runtimes.python, args: ["-I", script, setup], cwd: candidate }),
      );
    };
    const repo = async (input: unknown): Promise<unknown> => {
      if (task.meta.language === "python") return python(input);
      await reset();
      const payload = record(input);
      if (task.meta.language === "typescript") {
        const script = await freshCodingFile(root, "coding-node.mjs", await source("bridge-node.mjs"));
        const setup = await freshCodingFile(
          root,
          "coding-node.json",
          JSON.stringify({ id: task.meta.id, entry: join(candidate, variant.entry), symbol: variant.symbol, input }),
        );
        return decoded(
          await box({
            root,
            program: options.runtimes.node,
            args: ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", script, setup],
            cwd: candidate,
          }),
        );
      }
      if (task.meta.language === "go") {
        const result = await box({
          root,
          program: join(root, "coding-program"),
          args: ["-test.run=^TestCodingPrivateBridge$"],
          cwd: candidate,
          stdin: JSON.stringify(input),
        });
        if (result.code !== 0) throw new CodingCaseFailure("Go invocation failed");
        const lines = result.stdout.trim().split("\n");
        if (lines.length !== 2 || lines[1] !== "PASS") throw new CodingCaseFailure("invalid Go invocation output");
        return JSON.parse(lines[0]!);
      }
      let args: string[];
      if (task.meta.id === "easy-rust-window") {
        if (!Array.isArray(payload.values) || !Number.isSafeInteger(payload.width)) {
          throw new CodingCaseFailure("invalid window input");
        }
        args = [payload.values.join(","), String(payload.width)];
      } else if (task.meta.id === "medium-rust-tokenizer") {
        if (typeof payload.text !== "string") throw new CodingCaseFailure("invalid tokenizer input");
        args = [payload.text];
      } else {
        if (!Array.isArray(payload.intervals)) throw new CodingCaseFailure("invalid interval input");
        args = [
          payload.intervals
            .map((row) => {
              if (!Array.isArray(row)) throw new CodingCaseFailure("invalid interval pair");
              return row.join(",");
            })
            .join(";"),
        ];
      }
      return decoded(await box({ root, program: join(root, "coding-program"), args, cwd: candidate }));
    };
    const terminal = async (args: string[], stdin: string | Buffer, cwd?: string): Promise<CodingBoxResult> => {
      await reset();
      if (cwd) await files.safe(cwd);
      const entry = join(candidate, variant.entry);
      const language = task.meta.language;
      const program =
        language === "python"
          ? options.runtimes.python
          : language === "typescript"
            ? options.runtimes.node
            : language === "shell"
              ? options.runtimes.shell
              : join(root, "coding-program");
      const prefix =
        language === "python" || language === "shell"
          ? [entry]
          : language === "typescript"
            ? ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", entry]
            : [];
      return box({ root, program, args: [...prefix, ...args], stdin, cwd: cwd ?? candidate });
    };
    const inspector = async (path: string): Promise<unknown> => {
      await files.safe(path);
      return python({ path }, "sqlite-inspect");
    };
    const context = {
      id: task.meta.id,
      constant: variant.constant,
      tag: variant.tag,
      repo,
      terminal,
      directory: files.directory.bind(files),
      filePath: files.filePath.bind(files),
      write: files.write.bind(files),
      read: files.read.bind(files),
      mode: files.mode.bind(files),
      names: files.names.bind(files),
      symlink: files.symlink.bind(files),
      remove: files.remove.bind(files),
      inspectSqlite: inspector,
      async sqlite(schema: string, rows: unknown[]) {
        const directory = await files.directory(`sqlite-${randomUUID()}`);
        const path = await files.filePath(directory, "people.sqlite");
        const snapshot = await python({ path, schema, rows }, "sqlite-prepare");
        return { path, snapshot };
      },
    };
    const imported: unknown = await import(pathToFileURL(join(task.directory, task.meta.checker)).href);
    const check = record(imported).check;
    if (typeof check !== "function") throw new CodingCaseFailure("checker missing");
    await check(context);
    return verdict("passed");
  } catch (error) {
    if (options.mode === "fixture") options.onFixtureFailure?.(error);
    return verdict(
      options.signal.aborted ? "aborted" : error instanceof CodingIsolationUnavailable ? "unavailable" : "unresolved",
    );
  } finally {
    if (workspace) await workspace.close();
    else await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
