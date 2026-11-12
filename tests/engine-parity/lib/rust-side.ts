import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { accessSync, constants, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline";
import { coreAddress, createLogger, createRpcServer, engineRunFiles, readRunToken } from "@plur1bus/module-api";
import { EngineClient } from "../../../packages/core/src/engine/client.ts";
import { createHostMethods, type HostMethodDependencies } from "../../../packages/core/src/engine/host-methods.ts";
import { isEngineContext } from "../../../packages/core/src/engine/engine-principal.ts";
import { CORE_CONTRACT } from "../../../packages/core/src/engine.ts";
import { createPlatformCapabilities } from "../../../packages/core/src/platform.ts";
import { createMemoryAuditSink } from "../../../packages/core/src/secrets/audit.ts";
import { createMemoryBackend } from "../../../packages/core/src/secrets/memory-backend.ts";
import { createSecretStore } from "../../../packages/core/src/secrets/store.ts";
import { buildCapabilities, RPC_VERSION } from "../../../packages/rpc-schema/src/index.ts";
import { assertNoMarkers, isRecord } from "./diff.ts";
import { offlineHost, repo, runSteps, withHome } from "./side.ts";
import type { Scenario } from "./scenario.ts";

function findBinary(): string {
  const executable = process.platform === "win32" ? "plur1bus-engine.exe" : "plur1bus-engine";
  const binary = resolve(process.env.PLUR1BUS_ENGINE_BIN ?? join(repo, "target/debug", executable));
  try { accessSync(binary, constants.X_OK); }
  catch { throw new Error("Rust engine binary unavailable. Run cargo build --locked -p plur1bus-engine or set PLUR1BUS_ENGINE_BIN"); }
  return binary;
}

function waitReady(child: ChildProcess): Promise<void> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("Rust engine has no readiness pipe");
  const lines = createInterface({ input: stdout });
  return new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => fail("Rust engine readiness timed out"), 10_000);
    const cleanup = () => {
      clearTimeout(timeout);
      lines.close();
      stdout.resume();
      child.removeListener("exit", exited);
    };
    const fail = (message: string) => { cleanup(); reject(new Error(message)); };
    const exited = () => fail("Rust engine exited before readiness");
    child.once("exit", exited);
    child.once("error", () => fail("Rust engine could not start"));
    lines.once("line", line => {
      try {
        const value: unknown = JSON.parse(line);
        assertNoMarkers(value, "Rust readiness");
        if (!isRecord(value) || value.ready !== true || value.pid !== child.pid || typeof value.address !== "string") {
          return fail("Rust engine produced invalid readiness");
        }
        cleanup();
        resolveReady();
      } catch { fail("Rust engine produced invalid readiness"); }
    });
  });
}

async function stopChild(child: ChildProcess, done: Promise<void>): Promise<void> {
  child.stdin?.end();
  if (await Promise.race([done.then(() => true), delay(3_000, false, { ref: false })])) return;
  child.kill("SIGKILL");
  await done;
  throw new Error("Rust engine did not stop within its test lifeline budget");
}

export async function runRust(scenario: Scenario) {
  const binary = findBinary();
  return withHome(scenario, "rust", async home => {
    const { paths, config } = home;
    const offline = offlineHost(scenario, home);
    const llm = offline.llm;
    const complete: HostMethodDependencies["complete"] = llm ? (_agentId, params) => llm.complete(params) : undefined;
    const token = randomBytes(32).toString("hex");
    const instanceId = randomUUID();
    const client = new EngineClient({
      home: paths.home, onEvent: offline.event, connectTimeoutMs: 1_000, callTimeoutMs: 15_000,
    });
    const secrets = createSecretStore({
      keyring: createMemoryBackend(), file: createMemoryBackend(),
      fileFallback: () => false, audit: createMemoryAuditSink(),
    });
    const platform = createPlatformCapabilities();
    const logger = createLogger({ file: paths.logFile("core"), level: "warn", role: "core" });
    const server = createRpcServer({
      address: coreAddress(paths.home), token, logger,
      engineToken: () => {
        try { return readRunToken(paths.home, engineRunFiles(paths.home).token); }
        catch { return undefined; }
      },
      hello: () => ({ contract: CORE_CONTRACT, rpc: RPC_VERSION, instanceId, pid: process.pid, capabilities: buildCapabilities([]) }),
      methods: {
        ...createHostMethods({
          host: { workspaceDir: offline.workspaceDir, events: { emit: offline.event } }, secrets,
          agents: { has: id => Object.hasOwn(config.agents, id) }, canCompleteFor: id => client.canCompleteFor(id),
          ...(complete ? { complete } : {}),
          egress: { decide: async () => {
            offline.denyNetwork();
            return { allowed: false, reason: "host-not-allowed", message: "offline parity" };
          } },
        }),
        "events.subscribe": async (params, ctx) => {
          if (!isEngineContext(ctx) || params.names?.length !== 1 || params.names[0] !== "egress.changed") {
            throw new Error("only authenticated engine policy subscription is offered");
          }
          return {};
        },
      },
    });
    try {
      writeFileSync(paths.coreToken, token, { mode: 0o600 });
      writeFileSync(paths.corePid, `${process.pid} ${instanceId}\n`, { mode: 0o600 });
      platform.securePath(paths.coreToken);
      platform.securePath(paths.corePid);
      await server.listen();
      const variant = scenario.seams.embedder === "hash" ? "hash-embedder" : "flat-embedder";
      const child = spawn(binary, ["serve", "--home", paths.home, "--lifeline", "stdin", "--test-internals", variant], {
        env: {
          PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
          HOME: paths.home, USERPROFILE: paths.home,
          PLUR1BUS_TOKENIZER_DIR: process.env.PLUR1BUS_TOKENIZER_DIR,
          PLUR1BUS_TOKENIZER_FILES_REQUIRED: process.env.PLUR1BUS_TOKENIZER_FILES_REQUIRED,
          PLUR1BUS_ALLOW_TEST_INTERNALS: "1",
          PLUR1BUS_TEST_CLOCK_MS: String(scenario.seams.clock),
        },
        stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
      });
      const done = new Promise<void>(resolveDone => child.once("close", () => resolveDone()));
      child.stdin.on("error", () => {});
      try {
        await waitReady(child);
        return await runSteps(client, scenario, offline.check);
      } finally {
        await client.close({ budgetMs: 2_000 });
        await stopChild(child, done);
        offline.check();
      }
    } finally {
      await server.close();
      await logger.close();
    }
  });
}
