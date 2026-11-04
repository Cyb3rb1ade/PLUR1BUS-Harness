/** CLI-1 human /check and /diff commands. Checks reuse D98's plan/VerifierPort; they never complete or move a card. */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { CallerIdentity } from "@plur1bus/rpc-schema";
import { detectVerifiers } from "../collab/coding-gate.ts";
import type { CheckKind, VerifierPort, VerifierResult } from "../collab/verifier.ts";
import { RpcError } from "../rpc/errors.ts";
import type { Principal } from "../rbac/types.ts";
import type { SessionStore } from "../session/store.ts";
import type { CodingSessions } from "./sessions.ts";
import { codingGit } from "./git.ts";
import { workingDiff } from "./git-view.ts";

const MANIFESTS = [
  ".plur1bus-verifiers.json",
  "package.json",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "build.gradle",
  "build.gradle.kts",
] as const;
interface SessionInput {
  caller: CallerIdentity;
  sessionId: string;
}
interface ActionDeps {
  coding: CodingSessions;
  storeFor(id: string): SessionStore;
  verifier: VerifierPort;
  redact(text: string): string;
}

/** Small human-only adapters over existing runners and stored event data; no model tool bypass lives here. */
export class CodingActions {
  readonly #d: ActionDeps;
  constructor(deps: ActionDeps) {
    this.#d = deps;
  }

  /** Advisory checks have no independent-review requirement and create no D98 reuse evidence (Q24/Q16). */
  async check(p: SessionInput & { kind?: CheckKind }, who: Principal, signal: AbortSignal, taskId?: string) {
    const current = await this.#d.coding.requireRoot(p.sessionId, who, p.caller, taskId);
    if (this.#d.storeFor(p.sessionId).runningTurn(p.sessionId)) {
      throw new RpcError("E_CONFLICT", "finish or cancel the model turn before running human checks", {
        reason: "session-busy",
      });
    }
    const root = current.binding.root;
    const files: Record<string, string> = {};
    let committed = true;
    for (const file of MANIFESTS) {
      const path = join(root, file);
      if (existsSync(path)) {
        const native = realpathSync.native(path);
        if (!native.startsWith(root + sep) || !statSync(native).isFile() || statSync(native).size > 1024 * 1024) {
          throw new RpcError("E_DENIED", "verifier convention is outside the worktree or exceeds 1 MiB");
        }
        files[file] = readFileSync(native, "utf8");
      }
      let original: string | undefined;
      try {
        original = codingGit(root, ["show", `HEAD:${file}`], 1024 * 1024);
      } catch {
        /* new/untracked convention */
      }
      if (original !== files[file]) committed = false;
    }
    let plan: ReturnType<typeof detectVerifiers>;
    try {
      plan = detectVerifiers(files);
    } catch {
      throw new RpcError("E_INVALID_PARAMS", "invalid or unsupported project verifier conventions", {
        reason: "verifier-conventions",
      });
    }
    if (p.kind && !["format", "lint", "typecheck", "test"].includes(p.kind)) {
      throw new RpcError("E_INVALID_PARAMS", "unknown check kind");
    }
    const checks: (VerifierResult & { kind: CheckKind })[] = [];
    for (const command of plan.commands.filter((command) => !p.kind || command.kind === p.kind)) {
      if (signal.aborted) break;
      const result = await this.#d.verifier.run(root, command, {
        signal,
        networkAllowed: committed && plan.networkAllowed,
      });
      checks.push({ ...result, kind: command.kind, output: this.#d.redact(result.output) });
      if (signal.aborted) break;
      await this.#d.coding.requireRoot(p.sessionId, who, p.caller, taskId);
    }
    return {
      sessionId: p.sessionId,
      advisory: true as const,
      ok: !signal.aborted && checks.length > 0 && checks.every((c) => c.ok),
      checks,
      ...(signal.aborted ? { reason: "aborted" } : {}),
    };
  }

  /** Paged native Git diff or one stored tool's full inline patch. Paging never splits a Unicode surrogate pair. */
  async diff(p: SessionInput & { callId?: string; offset?: number; limit?: number }, who: Principal, taskId?: string) {
    const current = await this.#d.coding.requireRoot(p.sessionId, who, p.caller, taskId);
    let patch: string;
    if (p.callId) {
      const output = this.#d.storeFor(p.sessionId).toolResult(p.sessionId, p.callId);
      patch = inlinePatch(output);
    } else {
      patch = workingDiff(current.binding.root);
    }
    patch = this.#d.redact(patch);
    const offset = p.offset ?? 0,
      limit = p.limit ?? 32768;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > patch.length ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 65536
    ) {
      throw new RpcError("E_INVALID_PARAMS", "invalid diff page");
    }
    if (offset > 0 && /[\uDC00-\uDFFF]/u.test(patch[offset]!)) {
      throw new RpcError("E_INVALID_PARAMS", "diff offset must not split a Unicode code point");
    }
    let end = Math.min(patch.length, offset + limit);
    if (end < patch.length && /[\uDC00-\uDFFF]/u.test(patch[end]!)) end++;
    return {
      sessionId: p.sessionId,
      source: p.callId ? ("call" as const) : ("worktree" as const),
      diff: patch.slice(offset, end),
      offset,
      nextOffset: end < patch.length ? end : null,
    };
  }
}

function inlinePatch(output: string | null): string {
  if (output === null) throw new RpcError("E_NOT_FOUND", "tool result not found");
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    /* legacy plain result */
  }
  for (let depth = 0; depth < 4 && value && typeof value === "object" && !Array.isArray(value); depth++) {
    const row = value as Record<string, unknown>;
    if (typeof row.diff === "string") return row.diff;
    if (typeof row.unifiedDiff === "string") return row.unifiedDiff;
    value = row.value ?? row.data ?? row.result;
  }
  throw new RpcError("E_NOT_AVAILABLE", "this tool result has no inline patch; use /diff for the current worktree", {
    reason: "tool-diff-unavailable",
  });
}
