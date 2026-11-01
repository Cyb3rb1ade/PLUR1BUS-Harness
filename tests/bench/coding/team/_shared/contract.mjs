// SPDX-License-Identifier: MIT
/** Published K2 contracts for the private team checker; no model runner or public benchmark report is implemented. */
import contract from "./k2-contract.json" with { type: "json" };

function freeze(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Immutable provenance for the adopted K2 report, environment and platform contracts. */
export const K2_CONTRACT = freeze(contract);

/** Retain only K2's explicit command variables; never inherit an ambient credential or loader option. */
export function executionEnvironment(values) {
  const allowed = new Set(contract.environment);
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) => allowed.has(key) && typeof value === "string" && !value.includes("\0"),
    ),
  );
}

/** Return K2's checker-result shape. Per-case diagnostics remain on the private host callback. */
export function checkerVerdict(reason, began) {
  if (!contract.reasons.includes(reason)) {
    throw new Error("invalid K2 checker outcome");
  }
  return {
    passed: reason === "passed",
    unavailable: reason === "unavailable",
    reason,
    wallMs: Math.max(0, performance.now() - began),
  };
}

/** K2/D123 Q6: no platform silently falls back from isolation to trusted fixture execution. */
export class IsolationUnavailable extends Error {
  constructor(code = "platform-unavailable") {
    super(code);
    this.name = "IsolationUnavailable";
    this.code = code;
  }
}

/** Reject unsupported modes before any child process is created. */
export function requirePlatform(mode, platform = process.platform) {
  const platforms = mode === "live" ? contract.livePlatforms : contract.fixturePlatforms;
  if (!["live", "fixture"].includes(mode) || !platforms.includes(platform)) {
    throw new IsolationUnavailable();
  }
}
