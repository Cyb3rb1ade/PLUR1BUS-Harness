/** B1 owner-run orchestration: actual approved providers, native foundation preflight and private task/verifier trees. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sandboxVerifier } from "../collab/verifier.ts";
import { ToolsClient } from "../tools-service/client.ts";
import { detectSandbox } from "../tools/sandbox/backends.ts";
import { DEFAULT_MAX_TASKS } from "../tools/sandbox/types.ts";
import { createSandboxProcessPort } from "../tools/sandbox/ports.ts";
import { loadCodingCorpus, renderCodingTask, type CodingLanguage } from "./coding-bench-corpus.ts";
import { verifyCodingTask } from "./coding-bench-checker.ts";
import { codingEvalHome, codingSecretValues } from "./coding-bench-secrets.ts";
import { parseCodingLiveReport, type CodingLiveCase, type CodingLiveReport } from "./coding-bench-report.ts";
import { copyCodingRuntime, resolveCodingRuntimes, type CodingRuntimes } from "./coding-bench-runtime.ts";
import { singleCodingArm, type CodingArm, type SingleCodingOptions } from "./coding-bench-subject.ts";
import { verifyCodingCandidate } from "./coding-bench-verify.ts";
import { defineCodingArm, type CodingArmSpec } from "./coding-bench-arms.ts";
import {
  codingProvisionerApi,
  provisionCodingCard,
  type CodingProvisionedWorkspace,
} from "./coding-bench-provisioner.ts";
import {
  composeTurnEvalProviders,
  openTurnEvalSecrets,
  parseTurnEvalModels,
  type TurnEvalModel,
  type TurnEvalProviders,
} from "./turn-eval-live.ts";

/** PT-2 supplies factories explicitly. No team/best-of-n behavior is implicitly emulated by B1. */
export interface CodingArmFactory extends CodingArmSpec {
  create(options: SingleCodingOptions): CodingArm;
}
/** Credentials live in an already marked eval home; no key environment or endpoint reaches a task process. */
export interface CodingLiveOptions {
  home: string;
  models: readonly TurnEvalModel[];
  revision: string;
  toolsBinary: string;
  limitsHelper: string;
  signal: AbortSignal;
  arms?: readonly CodingArmFactory[];
  onCase?: (progress: { checked: number; resolved: number }) => void;
}

/** Stable across harness revisions and temporary paths; changed model endpoints/settings cannot silently pair. */
export function codingConfiguration(model: TurnEvalModel): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        profile: "coding-b1/1",
        maxOutput: 4096,
        sampling: "provider-default",
        provider: model.provider,
        model: model.model,
        baseUrl: model.baseUrl,
        wireFormat: model.wireFormat,
        local: model.local === true,
      }),
    )
    .digest("hex");
}

/** Stage writable private copies only. Compiler wrappers set their own scrubbed environment inside the sandbox. */
async function livePrograms(
  runtime: CodingRuntimes,
  root: string,
  language: CodingLanguage,
  entry: string,
): Promise<string[]> {
  const directory = join(root, ".build", "runtime");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const node = join(directory, "node");
  await copyFile(runtime.node, node, constants.COPYFILE_FICLONE);
  await chmod(node, 0o700);
  const programs = [node, runtime.python, "/usr/bin/git"];
  const environment = {
    PATH: `${directory}:/usr/bin:/bin`,
    HOME: directory,
    TMPDIR: directory,
    CI: "1",
    LC_ALL: "C",
    GOPROXY: "off",
    GOSUMDB: "off",
    GOTOOLCHAIN: "local",
    CGO_ENABLED: "0",
    GOMAXPROCS: "2",
    CARGO_NET_OFFLINE: "true",
    GOCACHE: join(directory, "go-cache"),
    GOMODCACHE: join(directory, "go-modules"),
  };
  if (language === "rust" || language === "go") {
    const compilerRoot = join(directory, language);
    await copyCodingRuntime(language === "rust" ? runtime.rustRoot : runtime.goRoot, compilerRoot);
    const program = join(compilerRoot, "bin", language === "rust" ? "rustc" : "go");
    const prefix = language === "rust" ? ["--sysroot", compilerRoot] : [];
    const wrapper = join(directory, language === "rust" ? "rustc" : "go");
    const env = language === "go" ? { ...environment, GOROOT: compilerRoot } : environment;
    await writeFile(
      wrapper,
      `#!${node}\n/** Private B1 compiler launcher, with no inherited credentials. */\n` +
        `const {spawnSync}=require("node:child_process");\n` +
        `const r=spawnSync(${JSON.stringify(program)},${JSON.stringify(prefix)}.concat(process.argv.slice(2)),` +
        `{env:${JSON.stringify(env)},stdio:"inherit"});\nprocess.exit(r.status??1);\n`,
      { mode: 0o700, flag: "wx" },
    );
    programs.push(wrapper);
  }
  if (language === "shell") programs.push(entry);
  return programs;
}

function publicInstruction(instruction: string, worktree: string, programs: readonly string[]): string {
  return (
    `${instruction}\n\nWorking directory: ${worktree}\n` +
    `Use the coding tools to repair files in this worktree, then finish. Network access is disabled.\n` +
    `Installed executable paths: ${programs.join(", ")}\n` +
    `For exec.run use an absolute program path and cwd. Node can run local test scripts or feed stdin to a CLI.\n` +
    `Compiler launchers already select their private standard libraries and offline caches.\n` +
    `Shell task entries are executable directly; exec.run does not admit shell interpreter programs.\n`
  );
}

async function assertCodingTurn(
  workspace: CodingProvisionedWorkspace,
  node: string,
  limitsHelper: string,
  signal: AbortSignal,
): Promise<void> {
  const sandbox = { required: true, limitsHelper, worktreeMount: workspace.binding.worktreeMount };
  const port = createSandboxProcessPort({
    home: workspace.home,
    roots: [{ id: "coding-card", path: workspace.worktree }],
    deny: [],
    sandbox,
    principal: workspace.binding.principal,
    audit: { append() {} },
  });
  const child = port.spawn({
    program: node,
    args: ["-e", "process.exit(0)"],
    cwd: workspace.worktree,
    env: { PATH: "/usr/bin:/bin", HOME: workspace.worktree, TMPDIR: workspace.worktree, CI: "1" },
  });
  const stop = () => {
    void child.killTree();
  };
  const timer = setTimeout(stop, 10_000);
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) stop();
    if ((await child.wait()).code !== 0) throw new Error("coding provisioned turn unavailable");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    await child.killTree();
  }
}

/** Execute the full matrix only on supported isolation. A failed preflight never falls back to fixture evidence. */
export async function runCodingLive(root: string, options: CodingLiveOptions): Promise<CodingLiveReport> {
  if (process.platform !== "linux" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(options.revision)) {
    throw new Error("coding live environment unavailable");
  }
  const home = await codingEvalHome(options.home);
  await codingProvisionerApi();
  const models = parseTurnEvalModels(JSON.stringify(options.models));
  const configurations = models.map(codingConfiguration);
  const definitions = options.arms ?? [{ family: "single", params: {}, create: singleCodingArm }];
  const arms = definitions.map((factory) => ({ ...defineCodingArm(factory), create: factory.create }));
  if (
    new Set(configurations).size !== models.length ||
    !arms.length ||
    arms.length > 8 ||
    new Set(arms.map((arm) => arm.id)).size !== arms.length ||
    arms.some((arm) => typeof arm.create !== "function")
  )
    throw new Error("coding matrix refused");
  const corpus = await loadCodingCorpus(root);
  const isolation = await detectSandbox(options.limitsHelper);
  if (!isolation.available || isolation.tasks.mechanism !== "namespace-limit") {
    throw new Error("coding live process-count isolation unavailable");
  }
  const verifier = sandboxVerifier(90_000, { limitsHelper: options.limitsHelper, maxTasks: () => DEFAULT_MAX_TASKS });
  const runtimes = await resolveCodingRuntimes(true, options.signal);
  const native = new ToolsClient({ home: join(home, "native"), supervised: false, binary: options.toolsBinary });
  let providers: TurnEvalProviders | undefined;
  try {
    const probeWorkspace = await provisionCodingCard(
      home,
      new Map([["README.md", { text: "Private B1 preflight.\n", mode: 0o600 }]]),
      options.signal,
    );
    try {
      const programs = await livePrograms(runtimes, probeWorkspace.worktree, "typescript", "unused");
      await assertCodingTurn(probeWorkspace, programs[0]!, options.limitsHelper, options.signal);
      const probe = await verifier.run(
        probeWorkspace.worktree,
        { kind: "test", argv: [programs[0]!, "-e", "process.exit(0)"] },
        { signal: options.signal, networkAllowed: false },
      );
      if (!probe.ok) throw new Error("coding live verifier unavailable");
    } finally {
      await probeWorkspace.close();
    }
    const health = await native.health();
    if (health.process.state !== "ready") throw new Error("coding native foundation unavailable");
    const secrets = await codingSecretValues(home, models);
    providers = composeTurnEvalProviders(models, { secrets: openTurnEvalSecrets(home) });
    const cases: CodingLiveCase[] = [];
    const capturedAt = new Map<number, string>();
    for (const [index, model] of models.entries())
      for (const factory of arms) {
        for (const task of corpus.tasks)
          for (const seed of corpus.seeds) {
            options.signal.throwIfAborted();
            const instance = await renderCodingTask(task, seed, "start");
            const workspace = await provisionCodingCard(home, instance.files, options.signal);
            try {
              const programs = await livePrograms(
                runtimes,
                workspace.worktree,
                task.meta.language,
                join(workspace.worktree, instance.variant.entry),
              );
              await assertCodingTurn(workspace, programs[0]!, options.limitsHelper, options.signal);
              const arm = factory.create({
                home: workspace.home,
                model,
                adapter: providers.adapters[index]!,
                programs,
                binding: workspace.binding,
                secrets: () => secrets,
                limitsHelper: options.limitsHelper,
              });
              if (arm.id !== factory.id) throw new Error("coding arm identity refused");
              const began = performance.now();
              const subject = await arm.run({
                root: workspace.worktree,
                worktree: workspace.worktree,
                instruction: publicInstruction(instance.instruction, workspace.worktree, programs),
                taskId: task.meta.id,
                seed,
                budgets: task.meta.budgets,
                signal: options.signal,
              });
              const wallMs = Math.round(performance.now() - began);
              const { checker, verificationMs } = await verifyCodingCandidate(workspace.worktree, (image) =>
                verifyCodingTask(task, instance.variant, image, {
                  mode: "live",
                  runtimes,
                  verifier,
                  signal: AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]),
                  async provision() {
                    const checker = await provisionCodingCard(
                      home,
                      new Map([["README.md", { text: "Private B1 verifier workspace.\n", mode: 0o600 }]]),
                      options.signal,
                    );
                    return { root: checker.worktree, close: () => checker.close() };
                  },
                }),
              );
              cases.push({
                arm: arm.id,
                configuration: configurations[index]!,
                taskId: task.meta.id,
                seed,
                subject: subject.outcome,
                checker,
                wallMs,
                verificationMs,
                metrics: subject.metrics,
                resolved: subject.outcome === "completed" && checker === "passed",
              });
              options.onCase?.({ checked: cases.length, resolved: cases.filter((row) => row.resolved).length });
            } finally {
              await workspace.close();
            }
          }
        capturedAt.set(index, new Date().toISOString());
      }
    return parseCodingLiveReport({
      schema: "plur1bus.coding-bench/1",
      evidence: "live",
      generatedAt: new Date().toISOString(),
      corpus: corpus.fingerprint,
      revision: options.revision,
      environment: { platform: "linux", ...runtimes.versions, rpc: health.rpc },
      tasks: corpus.tasks.map(({ meta: { id, tier, language, kind } }) => ({ id, tier, language, kind })),
      seeds: corpus.seeds,
      models: models.map((model, index) => ({
        provider: model.provider,
        model: model.model,
        configuration: configurations[index]!,
        capturedAt: capturedAt.get(index)!,
      })),
      arms: arms.map(({ id, family, params }) => ({ id, family, params })),
      cases,
      comparison: null,
    });
  } finally {
    providers?.close();
    await native.close();
    await runtimes.close();
  }
}
