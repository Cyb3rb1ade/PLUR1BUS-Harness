/** B1 command isolation. Trusted original fixtures use owned groups; every live candidate uses the existing verifier. */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sandboxVerifier, type VerifierPort } from "../collab/verifier.ts";
import { runCodingCommand } from "./coding-bench-process.ts";

/** Missing isolation/tooling must invalidate evidence, rather than look like an ordinary unsolved task. */
export class CodingIsolationUnavailable extends Error {}
/** Candidate failures remain private and become an unresolved verdict. */
export class CodingCaseFailure extends Error {}
/** One bounded invocation; arguments and stdin carry task data, never credentials or expected answers. */
export interface CodingBoxRequest {
  root: string;
  program: string;
  args: string[];
  cwd?: string;
  stdin?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}
/** Captured candidate output is private to the parent checker. */
export interface CodingBoxResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
/** Execution mode is explicit; a missing sandbox never selects fixture mode. */
export interface CodingBoxOptions {
  mode: "fixture" | "live";
  node: string;
  environment: NodeJS.ProcessEnv;
  captureSource: string;
  signal: AbortSignal;
  verifier?: VerifierPort;
}
/** A parent-owned command port, not exposed to an agent subject. */
export type CodingBox = (request: CodingBoxRequest) => Promise<CodingBoxResult>;

/** Replace a known private leaf without following a link left by a candidate. */
export async function freshCodingFile(
  root: string,
  name: string,
  data: string | Buffer,
  mode = 0o600,
): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) throw new CodingCaseFailure("invalid private leaf");
  const target = join(root, name);
  await rm(target, { recursive: true, force: true });
  await writeFile(target, data, { mode, flag: "wx" });
  return target;
}

/** Construct the verifier adapter once; all expected-output comparisons happen after it returns. */
export function createCodingBox(options: CodingBoxOptions): CodingBox {
  const verifier = options.verifier ?? sandboxVerifier(90_000);
  return async (request) => {
    if (options.signal.aborted) throw new CodingCaseFailure("aborted");
    const script = await freshCodingFile(request.root, "coding-command.mjs", options.captureSource);
    const input = await freshCodingFile(
      request.root,
      "coding-command.json",
      JSON.stringify({
        program: request.program,
        args: request.args,
        cwd: request.cwd ?? request.root,
        stdin: Buffer.from(request.stdin ?? "").toString("base64"),
        env: request.env ?? {},
        timeoutMs: request.timeoutMs ?? 5000,
      }),
    );
    let output: string;
    if (options.mode === "fixture") {
      const result = await runCodingCommand(options.node, [script, input], {
        root: request.root,
        env: options.environment,
        signal: options.signal,
        timeoutMs: 90_000,
      });
      if (result.reason === "platform-unavailable" || result.reason === "spawn-failed") {
        throw new CodingIsolationUnavailable("fixture execution unavailable");
      }
      if (result.reason || result.code !== 0) throw new CodingCaseFailure("fixture command failed");
      output = result.stdout;
    } else {
      const result = await verifier.run(
        request.root,
        { kind: "test", argv: [options.node, script, input] },
        { signal: options.signal, networkAllowed: false },
      );
      if (
        result.reason &&
        ["sandbox-unavailable", "verifier-unavailable", "command-unavailable", "spawn-failed"].includes(result.reason)
      )
        throw new CodingIsolationUnavailable("live verifier unavailable");
      if (!result.ok) throw new CodingCaseFailure("verifier command failed");
      output = result.output;
    }
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new CodingCaseFailure("invalid command frame");
    const row = value as Record<string, unknown>;
    if (
      row.failed ||
      !["code", "stdout", "stderr"].every((key) => key in row) ||
      !(row.code === null || Number.isSafeInteger(row.code)) ||
      typeof row.stdout !== "string" ||
      typeof row.stderr !== "string" ||
      row.stdout.length + row.stderr.length > 65_536
    ) {
      throw new CodingCaseFailure("invalid command result");
    }
    return {
      code: row.code as number | null,
      stdout: Buffer.from(row.stdout, "base64").toString("utf8"),
      stderr: Buffer.from(row.stderr, "base64").toString("utf8"),
    };
  };
}
