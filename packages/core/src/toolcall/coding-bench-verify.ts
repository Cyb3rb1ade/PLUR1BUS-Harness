/** B1 freezes model-controlled files; verifier provisioning/execution/cleanup failures must remain infrastructure errors. */
import type { CodingCheckResult } from "./coding-bench-checker.ts";
import { snapshotCodingSources, type CodingImage } from "./coding-bench-workspace.ts";

/** Only snapshot refusal is an invalid image. The trusted verifier callback is deliberately outside that catch. */
export async function verifyCodingCandidate(
  worktree: string,
  verify: (image: CodingImage) => Promise<CodingCheckResult>,
): Promise<{
  checker: CodingCheckResult["reason"] | "invalid-image";
  verificationMs: number;
}> {
  let image: CodingImage;
  try {
    image = await snapshotCodingSources(worktree);
  } catch {
    return { checker: "invalid-image", verificationMs: 0 };
  }
  const result = await verify(image);
  return { checker: result.reason, verificationMs: Math.round(result.wallMs) };
}
