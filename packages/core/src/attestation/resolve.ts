import { helperPinned, type HelperPin, type HelperSpec } from "./helper.ts";

/**
 * The helper the supervisor / CLI points the core at (`PLUR1BUS_ATTEST_BIN`, an absolute path they resolved beside their own
 * executable). Container mode has no OS dialog to show, so there is no helper there. Anything that is not an absolute, regular,
 * not group/world-writable file is no helper at all: the core then answers `attestation-unavailable` and stays at T1.
 *
 * The same caller may hand over what the installation expects of that binary: `PLUR1BUS_ATTEST_SHA256` (hex), and, for the
 * platform's code signature, `PLUR1BUS_ATTEST_TEAM_ID` (macOS) / `PLUR1BUS_ATTEST_WIN_THUMBPRINT` (Windows). A variable that is
 * set but malformed makes the result `null`: a broken pin must not read as "no pin". Without any of them the helper is pinned by
 * owner and mode only (development builds, which bake no hash).
 */
export function helperFromEnv(env: Readonly<Record<string, string | undefined>>): HelperSpec | null {
  if (env.PLUR1BUS_CONTAINER === "1") return null;
  const p = env.PLUR1BUS_ATTEST_BIN;
  if (typeof p !== "string" || p === "" || !helperPinned(p)) return null;
  const pin: HelperPin = {};
  const sha = env.PLUR1BUS_ATTEST_SHA256;
  if (sha !== undefined) { if (!/^[0-9a-fA-F]{64}$/u.test(sha)) return null; pin.sha256 = sha.toLowerCase(); }
  const team = env.PLUR1BUS_ATTEST_TEAM_ID;
  if (team !== undefined) { if (!/^[A-Z0-9]{10}$/u.test(team)) return null; pin.macTeamId = team; }
  const thumb = env.PLUR1BUS_ATTEST_WIN_THUMBPRINT;
  if (thumb !== undefined) { if (!/^[0-9a-fA-F]{40}$/u.test(thumb)) return null; pin.winThumbprint = thumb.toUpperCase(); }
  return Object.keys(pin).length > 0 ? { path: p, pin } : { path: p };
}
