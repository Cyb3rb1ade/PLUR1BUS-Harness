/** Observe test Perl bombs by user namespace; never include processes in the test runner's own namespace. */
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';

/** Count each bomb's processes and threads; /proc entries disappearing during a sample are ignored. */
export function bombTasks(): Map<string, number> {
  const own = readlinkSync('/proc/self/ns/user'), tasks = new Map<string, number>();
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const path = `/proc/${pid}`;
      if (statSync(path).uid !== process.getuid!() || readFileSync(`${path}/comm`, 'utf8').trim() !== 'perl') continue;
      const ns = readlinkSync(`${path}/ns/user`);
      if (ns !== own) tasks.set(ns, (tasks.get(ns) ?? 0) + readdirSync(`${path}/task`).length);
    } catch { /* A task exited while the sample was collected. */ }
  }
  return tasks;
}
