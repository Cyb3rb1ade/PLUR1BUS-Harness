import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CodingActions } from "../../packages/core/src/coding/actions.ts";
import { RpcError } from "../../packages/core/src/rpc/errors.ts";
import { fixtureHead } from "./export-coding-git-view.ts";
import { exporterMain } from "./lib.mjs";

const person = { kind: "person", role: "owner", userId: "owner" } as const;
const caller = { channel: "cli", accountId: "host", userId: "owner" } as const;
const name = ".plur1bus-verifiers.json";
const manifest = JSON.stringify({
  commands: { format: ["fixture-format"], lint: ["fixture-lint"], typecheck: ["fixture-typecheck"], test: ["fixture-test"] },
  networkAllowed: true,
});

async function check(caseName: string, root: string) {
  const controller = new AbortController();
  let readable = true;
  const calls = [];
  const actions = new CodingActions({
    coding: {
      async requireRoot() {
        if (!readable) throw new RpcError("E_APPROVAL_REQUIRED", "folder grant is missing or revoked", { reason: "root-not-granted" });
        return { binding: { root } };
      },
    } as never,
    storeFor: () => ({ runningTurn: () => caseName === "busy" ? { id: "fixture" } : null } as never),
    verifier: {
      async run(_root, command, options) {
        calls.push({ kind: command.kind, argv: command.argv, networkAllowed: options.networkAllowed });
        if (caseName === "abort during check") controller.abort();
        if (caseName === "revoked during check") readable = false;
        return { ok: true, exitCode: 0, output: "check fixture" };
      },
    },
    redact: text => text.replace("fixture", "[masked]"),
  });
  if (caseName === "aborted") controller.abort();
  try {
    const {sessionId: _sessionId, advisory: _advisory, ...result} = await actions.check(
      { sessionId: "demo", caller, ...(caseName === "lint only" ? { kind: "lint" as const } : {}) },
      person, controller.signal,
    );
    return { ok: result, calls };
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    return { err: { code: e.error, message: e.message, reason: e.reason ?? null }, calls };
  }
}

export async function buildCodingCheckVectors() {
  const dir = mkdtempSync(join(tmpdir(), "p4k-advisory-checks-"));
  try {
    const root = realpathSync.native(dir);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : devNull });
    const git = (args: string[], input?: string) =>
      execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: "pipe", timeout: 5_000, input });
    git(["init", "--template=", "--object-format=sha1", "-q"]);
    writeFileSync(join(root, name), manifest);
    git(["add", "--", name]);
    fixtureHead(root, git);

    const checks = [];
    for (const scenario of ["committed", "lint only", "busy", "aborted", "abort during check", "revoked during check", "host offline", "uncommitted", "invalid"]) {
      if (scenario === "uncommitted") writeFileSync(join(root, name), manifest + " ");
      if (scenario === "invalid") writeFileSync(join(root, name), "{}");
      checks.push({
        name: scenario, result: await check(scenario, root),
        ...(scenario === "host offline" ? { divergence: { networkAllowed: false } } : {}),
      });
    }
    return { advisory: checks };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "coding", build: buildCodingCheckVectors });
}
