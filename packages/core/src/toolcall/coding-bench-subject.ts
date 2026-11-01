/** B1 subjects use the actual turn composition; future arms implement the same bounded workspace contract. */
import type { StreamingAdapter } from "../../../providers/src/index.ts";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCallBudget } from "../budget/index.ts";
import { secretStoreKeySource } from "../approvals/keys.ts";
import { openPermissionStores, type PermissionStores } from "../grants/open.ts";
import { createTurnProvider } from "../composition/provider.ts";
import { composeTools } from "../composition/tools.ts";
import { createRedactor } from "../logs/redact.ts";
import type { GrantSource } from "../policy/index.ts";
import type { ChatRequest } from "../session/provider.ts";
import { createTurnTelemetry } from "../session/turn-telemetry.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { CodingBudgets } from "./coding-bench-corpus.ts";
import type { CodingTurnBinding } from "./coding-bench-provisioner.ts";
import { openTurnEvalSecrets, turnEvalFamily, type TurnEvalModel } from "./turn-eval-live.ts";

/** Measurements retain no model text, tool arguments, output or provider endpoint. Null means unavailable. */
export interface CodingMetrics {
  rounds: number;
  toolCalls: number;
  toolErrors: number;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheCreated: number | null;
  totalInput: number | null;
  cacheShare: number | null;
  syntaxRefusals: number | null;
  offloads: number | null;
  steers: number | null;
  rewinds: number | null;
}
/** Public starting worktree only. Hidden checks and reference locations never enter this contract. */
export interface CodingSubjectInput {
  root: string;
  worktree: string;
  instruction: string;
  taskId: string;
  seed: number;
  budgets: CodingBudgets;
  signal: AbortSignal;
}
/** Closed execution outcomes distinguish failed measurement from a model exceeding its task budget. */
export interface CodingSubjectResult {
  outcome: "completed" | "budget" | "aborted" | "provider-error";
  metrics: CodingMetrics;
}
/** PT-2 may supply more arms; B1 implements only single, without fabricating team or best-of-n results. */
export interface CodingArm {
  id: string;
  run(input: CodingSubjectInput): Promise<CodingSubjectResult>;
}
/** The approved provider and private runtime paths; credentials are retained solely for output redaction. */
export interface SingleCodingOptions {
  model: TurnEvalModel;
  adapter: StreamingAdapter;
  home: string;
  programs: readonly string[];
  secrets: () => Iterable<string>;
  limitsHelper?: string;
  binding?: CodingTurnBinding;
}

function taskKey(options: SingleCodingOptions, request: ChatRequest): string {
  return options.binding ? `${options.binding.projectId}/${options.binding.cardId}` : request.turnId!;
}

async function taskGrants(
  options: SingleCodingOptions,
  input: CodingSubjectInput,
  request: ChatRequest,
  privateRoot: string,
): Promise<PermissionStores> {
  const stores = await openPermissionStores({
    path: join(privateRoot, "approvals.sqlite"),
    clock: { now: Date.now },
    keys: secretStoreKeySource(openTurnEvalSecrets(privateRoot)),
  });
  try {
    for (const capability of ["fs.read", "fs.write", "shell.exec"])
      stores.grants.create({
        capability,
        person: request.principal!,
        agent: request.agentId,
        createdBy: request.principal!,
        scope: "task",
        match: { kind: "path", path: input.root, access: "write", recursive: true },
        expiresAt: Date.now() + input.budgets.wallMs,
        taskId: taskKey(options, request),
        sessionId: request.sessionId,
        surface: 3,
        ...(options.binding ? { projectId: options.binding.projectId } : {}),
      });
    return stores;
  } catch (error) {
    stores.close();
    throw error;
  }
}

async function codingRegistry(
  options: SingleCodingOptions,
  input: CodingSubjectInput,
  request: ChatRequest,
  grants: GrantSource,
): Promise<ToolRegistry> {
  const roots = [{ id: "coding-task", path: input.root }];
  // K2a adds this trusted opaque field to the existing native turn path. Until it is merged the live
  // preflight refuses; passing it never replaces the sandbox, its validator or the normal exec dispatcher.
  const sandbox = {
    required: true,
    ...(options.limitsHelper ? { limitsHelper: options.limitsHelper } : {}),
    ...(options.binding ? { worktreeMount: options.binding.worktreeMount } : {}),
  };
  const all = await composeTools(
    {
      home: options.home,
      roots,
      grants,
      audit: { append() {} },
      sandbox,
      exec: {
        mode: "allowlist",
        roots,
        allowlist: options.programs.map((program) => ({ program })),
        envAllow: [
          "PATH",
          "LANG",
          "LC_ALL",
          "HOME",
          "TMPDIR",
          "GOROOT",
          "GOCACHE",
          "GOMODCACHE",
          "GOTOOLCHAIN",
          "GOPROXY",
          "GOSUMDB",
          "CGO_ENABLED",
          "GOMAXPROCS",
          "CARGO_NET_OFFLINE",
        ],
        defaultTimeoutMs: 10_000,
        maxTimeoutMs: 30_000,
      },
    },
    request,
  );
  const registry = new ToolRegistry();
  for (const tool of all.describe()) {
    if (/^(?:file\.|artifact\.|code\.)/u.test(tool.name) || tool.name === "exec.run") {
      registry.register(all.get(tool.name)!);
    }
  }
  return registry;
}

function emptyMetrics(): CodingMetrics {
  return {
    rounds: 0,
    toolCalls: 0,
    toolErrors: 0,
    input: null,
    output: null,
    cacheRead: null,
    cacheCreated: null,
    totalInput: null,
    cacheShare: null,
    syntaxRefusals: null,
    offloads: null,
    steers: null,
    rewinds: null,
  };
}

/** Compose the existing file/exec tools, policy and provider under one task's measured bounds. */
export function singleCodingArm(options: SingleCodingOptions): CodingArm {
  return { id: "single", run: (input) => runSingle(options, input) };
}

async function runSingle(options: SingleCodingOptions, input: CodingSubjectInput): Promise<CodingSubjectResult> {
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  const privateRoot = await mkdtemp(join(options.home, "coding-case-"));
  const limit = new AbortController();
  const signal = AbortSignal.any([input.signal, limit.signal]);
  let exhausted = false;
  const timer = setTimeout(() => {
    exhausted = true;
    limit.abort();
  }, input.budgets.wallMs);
  const metrics = emptyMetrics();
  let settlements = 0;
  let spent = 0;
  let records = 0;
  let inputSum = 0;
  let readSum = 0;
  let createdSum = 0;
  let totalSum = 0;
  let telemetry = createTurnTelemetry();
  let permissions: PermissionStores | undefined;
  let budget: ReturnType<typeof createCallBudget> | undefined;
  let outcome: CodingSubjectResult["outcome"] = "provider-error";
  try {
    budget = createCallBudget({
      path: join(privateRoot, "budget.sqlite"),
      clock: { now: Date.now },
      emitter: {
        emit(event) {
          if (event.type !== "settle") return;
          settlements++;
          spent += event.tokens;
          if (spent > input.budgets.tokens) {
            exhausted = true;
            limit.abort();
          }
        },
      },
    });
    budget.setLimit({ scope: "global", id: "", period: "day", metric: "tokens", hard: input.budgets.tokens });
    const id = randomUUID();
    const principal = options.binding?.principal ?? id;
    const request: ChatRequest = {
      sessionId: id,
      turnId: id,
      agentId: options.binding?.agentId ?? "coding-bench",
      principal,
      authenticatedPerson: principal,
      approver: { person: principal, surface: 3 },
      originSurface: 3,
      modelProfile: "coding",
      summaries: [],
      memory: "",
      messages: [{ role: "user", text: input.instruction }],
      signal,
      maxOutputTokens: 4096,
      ...(options.binding ? { projectId: options.binding.projectId } : {}),
    };
    permissions = await taskGrants(options, input, request, privateRoot);
    const grants = permissions.grants;
    const registry = await codingRegistry(options, input, request, grants);
    const provider = createTurnProvider({
      registry,
      budget,
      profile: "coding",
      profiles: {
        coding: [{ provider: options.model.provider, model: options.model.model, adapter: options.adapter }],
      },
      family: { [options.model.provider]: turnEvalFamily(options.model) },
      isLocalProvider: () => options.model.local === true,
      maxTokens: 4096,
      maxRounds: input.budgets.rounds,
      approval: {
        async request() {
          return { approved: false };
        },
      },
      grants,
      grantUse: permissions.grants,
      policyContext: () => ({ taskId: taskKey(options, request) }),
      log() {},
      secrets: options.secrets,
      resultStore: {
        async put(value) {
          const text = JSON.stringify(createRedactor({ secrets: options.secrets() }).value(value));
          if (Buffer.byteLength(text) > 4 * 1024 ** 2) throw new Error("coding result limit");
          const name = randomUUID();
          await writeFile(join(privateRoot, name), text, { mode: 0o600, flag: "wx" });
          return `coding-result:${name}`;
        },
      },
      onUsage(record) {
        records++;
        inputSum += record.inputTokens;
        readSum += record.cacheReadTokens;
        createdSum += record.cacheCreationTokens;
        totalSum += record.totalInputTokens;
      },
      onTelemetry(_request, observed) {
        telemetry = observed;
      },
    });
    for await (const _chunk of provider.stream(request)) {
      /* No model transcript leaves this private turn. */
    }
    outcome = ["budget", "round-limit", "error-limit"].includes(telemetry.endReason)
      ? "budget"
      : ["provider-error", "failed", "local-only"].includes(telemetry.endReason)
        ? "provider-error"
        : "completed";
  } catch {
    outcome = ["budget", "round-limit", "error-limit"].includes(telemetry.endReason) ? "budget" : "provider-error";
  } finally {
    clearTimeout(timer);
    try {
      budget?.close();
    } finally {
      try {
        permissions?.close();
      } finally {
        await rm(privateRoot, { recursive: true, force: true });
      }
    }
  }
  if (exhausted) outcome = "budget";
  else if (input.signal.aborted) outcome = "aborted";
  metrics.rounds = telemetry.rounds;
  metrics.toolCalls = telemetry.toolCalls;
  metrics.toolErrors = telemetry.errorsReturned;
  // SDKs with partial/no usage settle estimates. Never label those estimates as measured input/output.
  if (records === settlements && spent >= totalSum) {
    Object.assign(metrics, {
      input: inputSum,
      output: spent - totalSum,
      cacheRead: readSum,
      cacheCreated: createdSum,
      totalInput: totalSum,
      cacheShare: totalSum ? readSum / totalSum : null,
    });
  }
  return { outcome, metrics };
}
