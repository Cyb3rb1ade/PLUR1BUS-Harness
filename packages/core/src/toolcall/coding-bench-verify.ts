/** B1 freezes model-controlled files; verifier provisioning/execution/cleanup failures must remain infrastructure errors. */
import type { CodingCheckResult } from "./coding-bench-checker.ts";
import { CodingSnapshotInvalid, snapshotCodingSources, type CodingImage, type CodingSnapshot } from "./coding-bench-workspace.ts";

/** Only snapshot refusal is an invalid image. The trusted verifier callback is deliberately outside that catch. */
export async function verifyCodingCandidate(
  worktree: string,
  verify: (image: CodingImage) => Promise<CodingCheckResult>,
  entry: string,
): Promise<{
  checker: CodingCheckResult["reason"] | "invalid-image";
  verificationMs: number;
  ignoredEntries: number;
}> {
  let snapshot: CodingSnapshot;
  try {
    snapshot = await snapshotCodingSources(worktree, entry);
  } catch (error) {
    if (!(error instanceof CodingSnapshotInvalid)) throw error;
    return { checker: "invalid-image", verificationMs: 0, ignoredEntries: error.ignoredEntries };
  }
  const result = await verify(snapshot.image);
  return { checker: result.reason, verificationMs: Math.round(result.wallMs), ignoredEntries: snapshot.ignoredEntries };
}
