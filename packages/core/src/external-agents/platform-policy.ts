/** ACP acceptance is independent of ordinary tool-sandbox availability. No opt-out exists. */
export type ExternalAgentRefusal = { reason: "sandbox-unavailable"; cause?: "macos-acceptance-pending" };

export function externalAgentRefusal(platform: NodeJS.Platform = process.platform): ExternalAgentRefusal | null {
  // A platform override may make policy stricter, but cannot disguise the actual host.
  if (process.platform === "darwin" || platform === "darwin")
    return { reason: "sandbox-unavailable", cause: "macos-acceptance-pending" };
  if (process.platform === "win32" || platform === "win32") return { reason: "sandbox-unavailable" };
  return null;
}
