// SPDX-License-Identifier: MIT
/** Owned command lifetime for trusted fixture tests and the isolation adapter, following K2 #868. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { executionEnvironment, requirePlatform } from "./contract.mjs";

/** Run one bounded command with stdin; reap its leader and terminate its entire owned Unix process group. */
export function runOwnedCommand(request) {
  requirePlatform("fixture");
  if (
    !isAbsolute(request.program) ||
    !isAbsolute(request.cwd) ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > 300000
  ) {
    throw new Error("invalid fixture command");
  }
  if (request.signal?.aborted) {
    return Promise.resolve({ code: null, stdout: "", stderr: "", reason: "aborted" });
  }
  return new Promise((resolve) => {
    const child = spawn(request.program, request.args, {
      cwd: request.cwd,
      env: executionEnvironment(request.env),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const digest = request.digestOutput ? createHash("sha256") : undefined;
    let stdoutBytes = 0;
    const stderr = [];
    let size = 0;
    let reason;
    let hardKill;
    const kill = (signal) => {
      try {
        if (child.pid) {
          process.kill(-child.pid, signal);
        }
      } catch {
        // The owned process group has already exited.
      }
    };
    const stop = (failure) => {
      if (reason) {
        return;
      }
      reason = failure;
      kill("SIGTERM");
      hardKill = setTimeout(() => kill("SIGKILL"), 100);
    };
    const collect = (chunks, chunk) => {
      const cap = request.maxOutputBytes ?? 65536;
      const room = cap - size;
      if (chunks === stdout && digest) {
        digest.update(chunk);
        stdoutBytes += chunk.length;
      } else if (room > 0) {
        chunks.push(chunk.subarray(0, room));
      }
      size += chunk.length;
      if (size > cap) {
        stop("output-limit");
      }
      request.onOutput?.(chunk);
    };
    const abort = () => stop("aborted");
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(request.stdin ?? "");
    child.once("exit", () => kill("SIGKILL"));
    child.once("error", () => {
      reason = "spawn-failed";
    });
    const timeout = setTimeout(() => stop("timeout"), request.timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(hardKill);
      request.signal?.removeEventListener("abort", abort);
      kill("SIGKILL");
      resolve({
        code,
        signal,
        stdout: digest
          ? JSON.stringify({ sha256: digest.digest("hex"), bytes: stdoutBytes })
          : Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(reason ? { reason } : {}),
      });
    });
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) {
      abort();
    }
  });
}
