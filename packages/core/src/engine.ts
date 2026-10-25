import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { normalizeEmbeddingConfig } from "@cyb3rb1ade/plur1bus-memory/lib/providers/config-normalize.js";
import type { Engine, HostServices } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { RpcError } from "./rpc/errors.ts";

export const CORE_CONTRACT = "1.17.0";
/** The engine contract's supported major version (ADR-016 §1): the core accepts major 1 only. */
export const SUPPORTED_CONTRACT_MAJOR = 1;
/** Contract 1.15 is required: older engines ignore host.fetch and host.secrets and bypass per-request egress. */
export const MIN_CONTRACT_MINOR = 15;

/** Refuses to start against an engine whose `contract` isn't a `<int>.<int>.<int>` string with the
 *  supported major (G20): throws E_RPC_VERSION reason=engine-contract-major, detail=<contract>; and against
 *  a supported major below MIN_CONTRACT_MINOR: reason=engine-contract-minor. */
export function assertEngineContract(engine: Pick<Engine, "contract">): void {
  const c = engine.contract;
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(c);
  const major = match ? Number(match[1]) : NaN;
  if (!match || major !== SUPPORTED_CONTRACT_MAJOR) {
    throw new RpcError("E_RPC_VERSION", `engine contract ${c} is not supported (major 1 expected)`, {
      reason: "engine-contract-major",
      detail: c,
    });
  }
  if (Number(match[2]) < MIN_CONTRACT_MINOR) {
    throw new RpcError("E_RPC_VERSION", `engine contract ${c} is too old (1.${MIN_CONTRACT_MINOR}.0 or later expected)`, {
      reason: "engine-contract-minor",
      detail: c,
    });
  }
}

/** The one place the harness constructs the engine. `testInternals` is the contract's test-only seam (e.g. a stub embedder). */
export function bindEngine(host: HostServices, engineConfig: Record<string, unknown>, testInternals?: Record<string, unknown>): Engine {
  // A test embedder given as a factory gets the configured embedding's width (bin.ts's flat seam), so it still fits the
  // store after a re-embedding switch to a model of another width.
  const embeddings = testInternals?.embeddings;
  const internals = typeof embeddings === "function"
    ? { ...testInternals, embeddings: embeddings(Number(normalizeEmbeddingConfig((engineConfig.embedding ?? {}) as Record<string, unknown>).dimensions)) }
    : testInternals;
  const engine = createEngine(host, engineConfig, internals ? { internals } : undefined);
  for (const channel of ["cli", "telegram", "discord", "matrix", "buzz", "slack", "signal", "email"]) engine.channels.register(channel);
  return engine;
}
