// The narrow engine surface the migration driver needs. It mirrors the pinned engine's `admin.reembedding` coordinator
// (lib/reembedding/coordinator.js): plan with a hash-bound confirmation, then ONE batch per apply/resume call, a durable
// record whose state the engine owns. `validate` is optional because an Engine before contract 1.17.0 does not expose it (the
// driver then stops at `validating`, fail closed). The real adapter is engine-port.ts; tests use a fake.
import type { EmbeddingFingerprint } from "./probe.ts";

export type EngineState = "planned" | "confirmed" | "running" | "validating" | "ready_to_switch" | "switching" | "completed" | "failed"
  | "rollback_planned" | "rolling_back" | "rolled_back";

export interface EngineTable { tableId: string; version: string; rowCount: number; estimatedBytes: number }
export interface EngineRecord {
  id: string;
  state: EngineState;
  cursor: { tableIndex: number; offset: number; completedRows: number; providerCalls: number; bytes: number };
  source: { generation: string; fingerprintId: string; fingerprint: EmbeddingFingerprint; tables: EngineTable[] };
  target: { generation: string; fingerprintId: string; fingerprint: EmbeddingFingerprint };
  error?: { code: string } | null;
}

export interface PlanRequest {
  id: string;
  /** `secretRef` names where a remote target's key lives (env var name), never the key; absent for a local target. */
  target: { fingerprint: EmbeddingFingerprint; secretRef?: { source: "env"; provider: "default"; id: string } };
  targetGeneration?: string;
  confirmationTtlMs?: number;
}
export interface EnginePlan {
  plan: {
    id: string;
    source: { generation: string; fingerprintId: string; fingerprint: EmbeddingFingerprint; tables: EngineTable[] };
    target: { generation: string; fingerprintId: string; fingerprint: EmbeddingFingerprint; probeStatus: string };
    estimates: { rows: number; providerCalls: number; sourceBytes: number; targetBytes: number; requiredFreeBytes: number; freeBytes: number };
  };
  planDigest: string;
  /** `expiresAt`: when the engine stops accepting `token` for the first apply (epoch ms), when the engine reports it. */
  confirmation: { token: string; expiresAt?: number };
}

export interface ReembedEngine {
  /** Rows per provider batch the engine uses (the plan's batch arithmetic). */
  readonly batchSize: number;
  plan(req: PlanRequest): Promise<EnginePlan>;
  /** Confirms a planned migration and runs its first batch; later batches are `resume`. One batch per call. */
  apply(a: { id: string; token: string }): Promise<EngineRecord>;
  resume(a: { id: string; token: string }): Promise<EngineRecord>;
  status(id: string): Promise<EngineRecord | null>;
  /** Absent when the engine does not expose validation (before contract 1.17.0): the driver stops at `validating`. */
  validate?(a: { id: string }): Promise<EngineRecord>;
}

/** The Harness-owned half of the switch: make `generation` the active one for the next core start. */
export interface SwitchPort {
  /** One atomic step; rejects without any partial effect. */
  apply(sel: { generation: string; fingerprint: EmbeddingFingerprint; fingerprintId: string; remote?: { apiKeyEnv: string; baseUrl?: string; privacyAck?: import("@plur1bus/config-schema").PrivacyAcknowledgment } }): Promise<void>;
  /** Whether config.json on disk already selects this generation in this vector space. The supervisor writes the file and
   *  restarts the core before it answers `config.set`, so the reply of a switch that worked can be lost with the connection. */
  written?(sel: { generation: string; fingerprint: EmbeddingFingerprint }): boolean;
}
