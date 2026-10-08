import { tap } from 'node:test/reporters';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
// TAP preserves the root runner's non-vacuous test-count guard. Observe top-level durations only:
// suite durations include their children, so counting nested events again would inflate the file totals.
export default async function* reporter(source) {
  const totals = new Map();
  async function* observe() {
    for await (const event of source) {
      if (['test:pass', 'test:fail'].includes(event.type) && event.data.nesting === 0 && event.data.file) {
        const file = relative(process.env.GITHUB_WORKSPACE ?? process.cwd(), event.data.file).replaceAll('\\', '/');
        totals.set(file, (totals.get(file) ?? 0) + (event.data.details?.duration_ms ?? 0));
      }
      yield event;
    }
  }
  try { yield* tap(observe()); }
  finally {
    if (process.env.TEST_TIMING_DIR) {
      mkdirSync(process.env.TEST_TIMING_DIR, { recursive: true });
      writeFileSync(join(process.env.TEST_TIMING_DIR, `${process.pid}.json`), JSON.stringify([...totals]));
    }
  }
}
