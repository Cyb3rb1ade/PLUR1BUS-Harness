/** Pure source and preflight request validation; backend authority remains independent. */
import type {
  AdminImportApplyParams,
  AdminImportAbortResult,
  AdminImportDetectParams,
  ImportSource,
  ImportProgress,
} from "../../../../rpc-schema/generated/types.ts";

export interface SourceInput {
  family: string;
  mode: "auto" | "path" | "wsl" | "ssh" | "snapshot";
  path: string;
  profile: string;
  distro: string;
  stopped: boolean;
  probeStopped: boolean;
  connectionId: string;
  snapshotId: string;
}
/** UX validation only. The Core independently checks its verified transport fact and sealed source ownership. */
export function sourceRequest(value: SourceInput, hostPathsAllowed: boolean): ImportSource {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value.family)) throw new Error("source-family");
  const family = value.family,
    profile = value.profile.trim() ? { profile: value.profile.trim() } : {};
  if (value.mode === "auto") return { kind: "auto", family };
  if (value.mode === "snapshot") {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value.snapshotId)) throw new Error("snapshot-required");
    return { kind: "snapshot", family, snapshotId: value.snapshotId, ...profile };
  }
  if (!value.path.trim() || value.path.length > 4096) throw new Error("source-path");
  if (value.mode === "ssh") {
    if (!value.connectionId || value.connectionId.length > 256) throw new Error("connection-required");
    return { kind: "ssh", family, connectionId: value.connectionId, path: value.path.trim(), ...profile };
  }
  if (!hostPathsAllowed) throw new Error("host-path-denied");
  if (value.mode === "wsl") {
    if (!value.distro || (value.stopped && !value.probeStopped)) throw new Error("wsl-consent");
    return {
      kind: "wsl",
      family,
      distro: value.distro,
      path: value.path.trim(),
      ...(value.probeStopped ? { probeStopped: true } : {}),
    };
  }
  return { kind: "path", family, path: value.path.trim(), ...profile };
}
/** Discovery is an explicit read action over an authorized broad path, separate from sealing one chosen installation. */
export function sourceDetectionRequest(
  value: SourceInput,
  hostPathsAllowed: boolean,
  discover = false,
): AdminImportDetectParams {
  if (discover && !["path", "wsl", "ssh"].includes(value.mode)) throw new Error("source-discovery-location");
  return { source: sourceRequest(value, hostPathsAllowed), ...(discover ? { discover: true } : {}) };
}
export function applyRequest(
  plan: { planId: string; runId: string },
  preflight: { planId: string; runId: string; ok: boolean; preflightId?: string; expiresAt?: string },
  accepted: boolean,
  resume = false,
  now = Date.now(),
): AdminImportApplyParams {
  if (
    !accepted ||
    !preflight.ok ||
    preflight.planId !== plan.planId ||
    preflight.runId !== plan.runId ||
    !preflight.preflightId ||
    !preflight.expiresAt ||
    !(Date.parse(preflight.expiresAt) > now)
  )
    throw new Error("preflight-required");
  return { planId: plan.planId, preflightId: preflight.preflightId, ...(resume ? { resume: true } : {}) };
}
export const terminalRun = (state: string): boolean => ["completed", "aborted", "failed"].includes(state);

/** Accepts only bounded checkpoint metadata for the run this page is already viewing. */
export function importProgress(raw: string, runId: string): ImportProgress | undefined {
  if (raw.length > 4096 || new TextEncoder().encode(raw).byteLength > 4096) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !["runId", "phase", "completed", "total", "entity"].includes(key)) ||
      value.runId !== runId ||
      !["detect", "plan", "preflight", "snapshot", "apply", "rollback", "verify", "complete"].includes(
        String(value.phase),
      ) ||
      !Number.isSafeInteger(value.completed) ||
      (value.completed as number) < 0
    )
      return undefined;
    if (value.total !== undefined && (!Number.isSafeInteger(value.total) || (value.total as number) < 0))
      return undefined;
    if (
      value.entity !== undefined &&
      !["agent", "skill", "memory", "store", "config", "secret", "extension"].includes(String(value.entity))
    )
      return undefined;
    return value as unknown as ImportProgress;
  } catch {
    return undefined;
  }
}

/** A cancellation refusal is final metadata, never an implied pending request. */
export function importAbortResult(raw: unknown, runId: string): AdminImportAbortResult {
  const value = raw as Record<string, unknown> | null;
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["runId", "accepted", "state"].includes(key)) ||
    value.runId !== runId ||
    typeof value.accepted !== "boolean" ||
    ![
      "queued",
      "stopping-core",
      "snapshotting",
      "applying",
      "rolling-back",
      "restarting-core",
      "completed",
      "aborted",
      "failed",
    ].includes(String(value.state))
  )
    throw new Error("abort-result");
  return value as unknown as AdminImportAbortResult;
}
