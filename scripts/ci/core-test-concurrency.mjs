/** Opt-in Core file concurrency; all other package runners keep their serial default. */
export function coreTestConcurrency({ mode, packageName, cpus, memoryBytes }) {
  if (mode === undefined || mode === '') return 1;
  if (mode !== 'bounded') throw new Error('PLUR1BUS_CORE_TEST_CONCURRENCY must be bounded or unset');
  if (packageName !== '@plur1bus/core') return 1;
  if (!Number.isSafeInteger(cpus) || cpus < 1 || !Number.isSafeInteger(memoryBytes) || memoryBytes < 1)
    throw new Error('invalid Core test resource inventory');
  // Reserve 4 GiB for the guest, then budget 4 GiB per process, with an absolute ceiling of two.
  return Math.max(1, Math.min(2, cpus, Math.floor((memoryBytes - 4 * 1024 ** 3) / (4 * 1024 ** 3))));
}
