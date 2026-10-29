import { dirname } from "node:path";
import type { Engine, HostServices } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { HarnessConfig } from "@plur1bus/config-schema";
import { bindEngine } from "../engine.ts";
import { RpcError } from "../rpc/errors.ts";
import { EngineClient } from "./client.ts";

/** The implementation selector is owned by the Harness, never passed into EngineConfig. */
export function selectEngine(cfg: HarnessConfig, host: HostServices, engineConfig: Record<string, unknown>, testInternals?: Record<string, unknown>): Engine {
  switch (cfg.engine.implementation ?? "node") {
    case "node": return bindEngine(host, engineConfig, testInternals);
    case "rust": return new EngineClient({ home: dirname(host.stateDir), onEvent: (name, payload) => host.events?.emit(name, payload) });
    default: throw new RpcError("E_INVALID_PARAMS", "unknown engine implementation", { reason: "engine-implementation" });
  }
}
