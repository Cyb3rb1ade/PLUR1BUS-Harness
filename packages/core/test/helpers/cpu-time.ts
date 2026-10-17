/** CPU time (user + system, ms) this process has used so far.
 *
 *  For tests that bound the cost of purely synchronous work (a regex that must not backtrack, a validator that must not
 *  freeze). A wall-clock bound on such work fails on a loaded machine although the code did nothing wrong; the CPU time of
 *  the process does not grow while it waits for a core. The threshold of the check stays as it was. */
export function cpuMs(): number {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}
