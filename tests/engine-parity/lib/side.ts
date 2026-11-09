import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaults } from "@plur1bus/config-schema";
import { layout } from "../../../packages/core/src/paths.ts";
import { validateParams } from "../../../packages/rpc-schema/src/index.ts";
import type { bindEngine } from "../../../packages/core/src/engine.ts";
import { assertNoMarkers, isRecord, normalizeStep, type StepResult } from "./diff.ts";
import { fixtureLlm } from "./fixtures.ts";
import type { Scenario, Step } from "./scenario.ts";

export const repo = fileURLToPath(new URL("../../../", import.meta.url));
const agentId = "a1";
const fixtureRoot = join(repo, "crates/plur1bus-engine/tests/fixtures");
export type Engine = ReturnType<typeof bindEngine>;
type Host = Parameters<typeof bindEngine>[0];
type Memory = Engine["memory"];
type Principal = Parameters<Memory["show"]>[1];
type Actor = Parameters<Memory["show"]>[2];

export function withHome<T>(scenario: Scenario, side: "node" | "rust", run: (home: Home) => Promise<T>): Promise<T> {
  // Unix-domain socket paths are limited, including the canonical /private prefix on macOS.
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ep-"));
  return Promise.resolve().then(() => run(prepareHome(root, scenario, side))).finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
}

function prepareHome(root: string, scenario: Scenario, side: "node" | "rust") {
  const paths = layout(root);
  const config = defaults();
  config.supervisor.graceMs = 1_000;
  config.core.recall.hardBudgetMs = 10_000;
  config.core.recall.softBudgetMs = 5_000;
  config.agents = { [agentId]: {} };
  config.engine = {
    neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
    ...scenario.config,
    implementation: side,
  };
  for (const dir of [paths.state, paths.run, paths.workspaceDir(agentId)]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configPath, JSON.stringify(config), { mode: 0o600 });
  if (scenario.store !== "empty") {
    const source = join(fixtureRoot, scenario.store);
    const destination = join(paths.lancedb, agentId);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const name of ["memories.lance", "_embedding_identity.lance"]) {
      cpSync(join(source, name), join(destination, name), { recursive: true, errorOnExist: true });
    }
    cpSync(join(source, "_schema.json"), join(paths.lancedb, "_schema.json"));
  }
  return { paths, config };
}

export type Home = ReturnType<typeof prepareHome>;

export function offlineHost(scenario: Scenario, home: Home) {
  let failure: Error | undefined;
  const fail = (message: string) => failure ??= new Error(message);
  const fixture = scenario.seams.llm === "none" ? undefined
    : fixtureLlm(join(repo, "tests/engine-parity/llm", scenario.seams.llm.slice("fixture:".length)));
  const llm: Host["llm"] = fixture ? {
    async complete(params) {
      try { return await fixture.complete(params); }
      catch (error) {
        failure = error instanceof Error ? error : new Error("LLM fixture failed");
        throw failure;
      }
    },
  } : undefined;
  const check = () => {
    if (failure) throw failure;
    fixture?.check();
  };
  return {
    llm,
    check,
    workspaceDir: async (id: string) => id === agentId ? home.paths.workspaceDir(id) : undefined,
    event(name: string, payload: unknown): void {
      try { assertNoMarkers({ name, payload }, "engine event"); }
      catch { fail("engine event: secret marker detected"); }
    },
    denyNetwork() { return fail("network requested in an offline parity scenario"); },
  };
}

function params<T>(value: unknown): T {
  // execute() validates the closed wire parameters before either side sees them.
  return value as T;
}

function validateStep(step: Step): void {
  if (step.op === "snapshot") throw new Error("snapshot requires an approved snapshot adapter");
  const method = step.op === "adopt" ? "engine.stores.adopt" : `engine.${step.op}`;
  if (!validateParams(method, step.args).ok) throw new Error(`${step.op}: arguments do not match the frozen RPC schema`);
}

async function execute(engine: Engine, step: Step, signal: AbortSignal): Promise<unknown> {
  const args = step.args;
  const p = params<Principal>(args.p);
  const a = params<Actor>(args.a);
  const memory = engine.memory;
  switch (step.op) {
    case "recall":
      return engine.recall({ ...params<Omit<Parameters<Engine["recall"]>[0], "signal">>(args.query), signal }, params(args.options));
    case "capture":
      return engine.capture({ ...params<Omit<Parameters<Engine["capture"]>[0], "signal">>(args.turn), signal }, params(args.options)).done;
    case "checkpoint": return engine.checkpoint(params(args.agentId), params(args.reason));
    case "jobs.run":
      return engine.jobs.run(params(args.job), params(args.agentId), {
        signal, ...(args.trigger === undefined ? {} : { trigger: params(args.trigger) }),
        ...(args.dryRun === undefined ? {} : { dryRun: params(args.dryRun) }),
      });
    case "memory.list": return memory.list(params(args.q), p, a);
    case "memory.show": return memory.show(params(args.id), p, a);
    case "memory.forget": return memory.forget(params(args.id), p, a);
    case "memory.state": return memory.state(p, a);
    case "memory.correct": return memory.correct(params(args.id), params(args.newText), p, a);
    case "memory.share": return memory.share(params(args.id), params(args.target), p, a, params(args.opts));
    case "memory.import": return memory.import(params(args.req), p, a);
    case "memory.rebind": return memory.rebind(params(args.req), p, a);
    case "memory.unbind": return memory.unbind(params(args.req), p, a);
    case "memory.unimport": return memory.unimport(params(args.req), p, a);
    case "memory.link": return memory.link(params(args.id), params(args.req), p, a);
    case "memory.propose": return memory.propose(params(args.sharedId), params(args.newText), p, a, params(args.opts));
    case "memory.proposals.list": return memory.proposals.list(params(args.q), p, a);
    case "memory.proposals.accept": return memory.proposals.accept(params(args.proposalId), p, a);
    case "memory.proposals.reject": return memory.proposals.reject(params(args.proposalId), p, a, params(args.opts));
    case "admin.migrate": return engine.admin.migrate(params(args.from), params(args.to));
    case "adopt": return engine.stores.adopt(params(args.req));
    case "snapshot": throw new Error("snapshot adapter unavailable");
  }
}

function operationError(error: unknown): { error: { code: string; reason?: string } } {
  if (error instanceof Error) assertNoMarkers(error.message, "engine error");
  assertNoMarkers(error, "engine error");
  const code = isRecord(error) ? error.error ?? error.code : undefined;
  const reason = isRecord(error) ? error.reason : undefined;
  const safe = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9_-]{1,64}$/i.test(value);
  if (!safe(code)) throw new Error("engine operation failed without a structured error code");
  return { error: { code, ...(safe(reason) ? { reason } : {}) } };
}

export async function runSteps(engine: Engine, scenario: Scenario, check: () => void): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    try {
      validateStep(step);
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort("parity-step-timeout");
          reject(new Error("engine step timed out"));
        }, 15_000);
      });
      const raw = await Promise.race([execute(engine, step, controller.signal).catch(operationError), deadline]);
      check();
      results.push(normalizeStep(raw, step.op));
    } catch (error) {
      const message = error instanceof Error ? error.message : "engine operation failed";
      throw new Error(`step ${index + 1} ${step.op}: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  return results;
}
