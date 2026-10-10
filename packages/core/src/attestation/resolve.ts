import { helperPinned, type HelperSpec } from "./helper.ts";

/**
 * The helper the supervisor / CLI points the core at (`PLUR1BUS_ATTEST_BIN`, an absolute path they resolved beside their own
 * executable). Container mode has no OS dialog to show, so there is no helper there. Anything that is not an absolute, regular,
 * not group/world-writable file is no helper at all: the core then answers `attestation-unavailable` and stays at T1.
 */
export function helperFromEnv(env: Readonly<Record<string, string | undefined>>): HelperSpec | null {
  if (env.PLUR1BUS_CONTAINER === "1") return null;
  const p = env.PLUR1BUS_ATTEST_BIN;
  return typeof p === "string" && p !== "" && helperPinned(p) ? { path: p } : null;
}
