import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import type { Engine, HostServices } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { RpcError } from "./rpc/errors.ts";

/** The engine contract's supported major version (ADR-016 §1): the core accepts major 1 only. */
export const SUPPORTED_CONTRACT_MAJOR = 1;

/** Refuses to start against an engine whose `contract` isn't a `<int>.<int>.<int>` string with the
 *  supported major (G20): throws E_RPC_VERSION reason=engine-contract-major, detail=<contract>. */
export function assertEngineContract(engine: Pick<Engine, "contract">): void {
  const c = engine.contract;
  const match = /^(\d+)\.\d+\.\d+$/.exec(c);
  const major = match ? Number(match[1]) : NaN;
  if (!match || major !== SUPPORTED_CONTRACT_MAJOR) {
    throw new RpcError("E_RPC_VERSION", `engine contract ${c} is not supported (major 1 expected)`, {
      reason: "engine-contract-major",
      detail: c,
    });
  }
}

/** The one place the harness constructs the engine. `testInternals` is the contract's test-only seam (e.g. a stub embedder). */
export function bindEngine(host: HostServices, engineConfig: Record<string, unknown>, testInternals?: Record<string, unknown>): Engine {
  const engine = createEngine(host, engineConfig, testInternals ? { internals: testInternals } : undefined);
  engine.channels.register("cli");
  return engine;
}
