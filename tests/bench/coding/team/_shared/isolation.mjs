// SPDX-License-Identifier: MIT
/** Candidate execution port: authored fixtures or Linux-only K2 verifier isolation, never an implicit fallback. */
import { copyFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeVerifier } from "./verifier-port.mjs";
import { executionEnvironment, IsolationUnavailable, requirePlatform } from "./contract.mjs";
import { runOwnedCommand } from "./process.mjs";

function within(parent, path) {
  const suffix = relative(parent, path);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !suffix.startsWith(sep));
}

async function safeMounts(privateRoot, taskRoot, runtimeRoots) {
  const hidden = await realpath(taskRoot);
  const exposed = [
    "/usr",
    "/bin",
    "/lib",
    "/lib64",
    "/etc",
    dirname(await realpath(process.execPath)),
    privateRoot,
    ...runtimeRoots,
  ];
  if (exposed.some((path) => within(path, hidden) || within(hidden, path))) {
    throw new IsolationUnavailable("oracle-path-exposed");
  }
}

/** Create the same explicit fixture/live boundary as K2; a future Windows backend implements this run interface. */
export async function createIsolation({ mode, root, taskRoot, signal, verifier, runtimeRoots = [] }) {
  requirePlatform(mode);
  if (mode === "fixture") {
    return { run: (request) => runOwnedCommand({ ...request, signal }) };
  }
  const roots = await Promise.all(runtimeRoots.map((path) => realpath(path)));
  await safeMounts(root, taskRoot, roots);
  const port = verifier ?? runtimeVerifier(roots);
  const bridge = join(root, "capture.mjs");
  for (const file of ["capture.mjs", "process.mjs", "contract.mjs", "k2-contract.json"]) {
    await copyFile(fileURLToPath(new URL(file, import.meta.url)), join(root, file));
  }
  return {
    async run(request) {
      const commandFile = join(root, "command.json");
      await writeFile(
        commandFile,
        JSON.stringify({
          program: request.program,
          args: request.args,
          cwd: request.cwd,
          stdin: Buffer.from(request.stdin ?? "", "utf8").toString("base64"),
          env: executionEnvironment(request.env),
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maxOutputBytes,
          digestOutput: request.digestOutput,
        }),
      );
      // A2 M1: hide host paths first, then make ephemeral parent directories read-only as well.
      const argv = [
        "/usr/bin/bwrap",
        "--die-with-parent",
        "--unshare-all",
        "--ro-bind",
        "/",
        "/",
        "--bind",
        root,
        root,
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--chdir",
        root,
        process.execPath,
        bridge,
        commandFile,
      ];
      const result = await port.run(
        root,
        { kind: "test", argv },
        {
          signal,
          networkAllowed: false,
        },
      );
      if (!result.ok) {
        return { code: result.exitCode, stdout: "", stderr: "", reason: result.reason ?? "candidate-error" };
      }
      try {
        const frame = JSON.parse(result.output);
        if (
          Object.keys(frame).sort().join(",") !== "code,stderr,stdout" ||
          !(frame.code === null || Number.isInteger(frame.code)) ||
          typeof frame.stdout !== "string" ||
          typeof frame.stderr !== "string"
        )
          throw new Error("invalid frame");
        const stdout = Buffer.from(frame.stdout, "base64").toString("utf8");
        if (frame.code === null) {
          const failure = JSON.parse(stdout);
          const allowed = ["spawn-failed", "aborted", "timeout", "output-limit"];
          if (Object.keys(failure).join(",") !== "failure" || !allowed.includes(failure.failure)) {
            throw new Error("invalid failure frame");
          }
          return { code: null, stdout: "", stderr: "", reason: failure.failure };
        }
        return {
          code: frame.code,
          stdout: Buffer.from(frame.stdout, "base64").toString("utf8"),
          stderr: Buffer.from(frame.stderr, "base64").toString("utf8"),
        };
      } catch {
        return { code: null, stdout: "", stderr: "", reason: "invalid-frame" };
      }
    },
  };
}
