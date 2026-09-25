import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import type { Engine, HostServices } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

/** The one place the harness constructs the engine. `testInternals` is the contract's test-only seam (e.g. a stub embedder). */
export function bindEngine(host: HostServices, engineConfig: Record<string, unknown>, testInternals?: Record<string, unknown>): Engine {
  const engine = createEngine(host, engineConfig, testInternals ? { internals: testInternals } : undefined);
  engine.channels.register("cli");
  return engine;
}
