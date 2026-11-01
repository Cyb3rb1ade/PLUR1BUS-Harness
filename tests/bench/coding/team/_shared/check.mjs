// SPDX-License-Identifier: MIT
/** Host-only oracle comparison. Candidates run through an input-only K2-compatible isolation port. */
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkerVerdict, IsolationUnavailable, requirePlatform } from "./contract.mjs";
import { createIsolation } from "./isolation.mjs";
import { loadManifest } from "./manifest.mjs";
import { snapshotInputs } from "./snapshot.mjs";
import { prepareProbe } from "./probe.mjs";
import { languageRuntime, preflight } from "./runtime.mjs";
import { seedValues } from "./seed.mjs";

/** Refuse missing, empty or ambiguous host case sets before executing any candidate code. */
export function validateCases(cases, scopes) {
  for (const key of scopes) {
    if (!Object.hasOwn(cases, key) || !Array.isArray(cases[key]) || !cases[key].length) {
      throw new Error("checker scope requires nonempty cases");
    }
    const ids = new Set();
    for (const item of cases[key]) {
      if (
        !item ||
        typeof item.id !== "string" ||
        !item.id ||
        ids.has(item.id) ||
        typeof item.input !== "string" ||
        typeof item.expected !== "string" ||
        (item.prefix !== undefined && typeof item.prefix !== "boolean")
      )
        throw new Error("invalid checker case");
      if (item.state !== undefined && !["stale", "corrupt"].includes(item.state)) {
        throw new Error("invalid checker state");
      }
      ids.add(item.id);
    }
  }
}

function expectedDigest(value) {
  return JSON.stringify({
    sha256: createHash("sha256").update(value, "utf8").digest("hex"),
    bytes: Buffer.byteLength(value, "utf8"),
  });
}

async function scopeCheck(task, scope, cases, image, values, root, runtime, execute) {
  const failures = new Set();
  let reason;
  try {
    const probe = await prepareProbe(task, image, values.tag, scope, root, runtime, execute);
    for (const item of cases) {
      try {
        if (
          (await probe.invoke(item.input, item.prefix === true || scope === "e2e", item.state)) !==
          expectedDigest(item.expected)
        ) {
          failures.add(item.id);
        }
      } catch (error) {
        reason = error.message === "timeout" || error.message === "aborted" ? error.message : "candidate-error";
        failures.add(item.id);
      }
    }
  } catch {
    reason = "candidate-error";
    for (const item of cases) failures.add(item.id);
  }
  return { scope, passed: !failures.size, cases: cases.length, failures: [...failures], ...(reason ? { reason } : {}) };
}

async function grade(task, taskRoot, candidateRoot, seed, scopes, options, began) {
  const timeoutMs = Math.min(task.budgets.wallMs, options.timeoutMs ?? 60000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error("invalid checker limit");
  const root = await realpath(await mkdtemp(join(tmpdir(), "p1b-team-check-")));
  const deadline = performance.now() + timeoutMs;
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);
  try {
    let runtime;
    try {
      runtime = await languageRuntime(task.language, root, { ...options, signal });
    } catch {
      throw new IsolationUnavailable("toolchain-unavailable");
    }
    const isolation = await createIsolation({ ...options, root, taskRoot, signal, runtimeRoots: runtime.roots });
    const execute = (request) => {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining < 1) return Promise.resolve({ code: null, stdout: "", stderr: "", reason: "timeout" });
      return isolation.run({ ...request, timeoutMs: Math.min(remaining, 30000) });
    };
    try {
      await preflight(task.language, runtime, root, execute);
    } catch {
      throw new IsolationUnavailable("toolchain-unavailable");
    }
    const { casesForSeed } = await import(pathToFileURL(join(taskRoot, task.seedGenerator)).href);
    const cases = casesForSeed(seed);
    validateCases(cases, scopes);
    const image = join(root, "image");
    try {
      await snapshotInputs(task, taskRoot, candidateRoot, image, seed, signal);
    } catch {
      for (const scope of scopes)
        options.onCheck?.({
          scope,
          passed: false,
          cases: cases[scope].length,
          failures: cases[scope].map((item) => item.id),
          reason: "candidate-error",
        });
      return checkerVerdict("unresolved", began);
    }
    const checks = [];
    for (const scope of scopes) {
      const check = await scopeCheck(task, scope, cases[scope], image, seedValues(seed), root, runtime, execute);
      checks.push(check);
      options.onCheck?.(check);
    }
    const reason = options.signal?.aborted
      ? "aborted"
      : checks.every((check) => check.passed)
        ? "passed"
        : "unresolved";
    return checkerVerdict(reason, began);
  } catch (error) {
    if (!(error instanceof IsolationUnavailable)) throw error;
    if (options.signal?.aborted) return checkerVerdict("aborted", began);
    options.onInfrastructureFailure?.(error.code);
    return checkerVerdict("unavailable", began);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** K2 checker verdict only; scopes are private host diagnostics. Fixture mode must be chosen by the trusted caller. */
export async function verify(taskRoot, candidateRoot, seed, scope = "all", options = {}) {
  const began = performance.now();
  const task = await loadManifest(taskRoot);
  if (!task.seeds.includes(seed)) throw new Error("seed is not declared by this task");
  const scopes = scope === "all" ? [...task.packages.map((item) => item.id), "e2e"] : [scope];
  if (scopes.some((key) => key !== "e2e" && !task.packages.some((item) => item.id === key))) {
    throw new Error("unknown checker scope");
  }
  try {
    requirePlatform(options.mode ?? "live");
  } catch (error) {
    options.onInfrastructureFailure?.(error.code);
    return checkerVerdict("unavailable", began);
  }
  return grade(task, taskRoot, candidateRoot, seed, scopes, { ...options, mode: options.mode ?? "live" }, began);
}

/** Standalone host command defaults to Linux live isolation. --fixture is restricted to authored self-tests. */
export async function checkerCli(taskRoot) {
  const began = performance.now();
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    const args = process.argv.slice(2);
    const fixture = args.at(-1) === "--fixture";
    if (fixture) args.pop();
    if (args.length !== 6 || args[0] !== "--candidate" || args[2] !== "--seed" || args[4] !== "--scope") {
      throw new Error("invalid checker arguments");
    }
    const result = await verify(taskRoot, resolve(args[1]), Number(args[3]), args[5], {
      mode: fixture ? "fixture" : "live",
      signal: controller.signal,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.passed ? 0 : 1;
  } catch {
    process.stdout.write(JSON.stringify(checkerVerdict("unavailable", began)) + "\n");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}
