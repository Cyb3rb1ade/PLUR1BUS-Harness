import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const runtime = args[0] === '--runtime' && args.length === 2 ? args[1] : null;
if (!['docker', 'podman'].includes(runtime)) {
  console.error('usage: node apps/desktop/stub-image/build.mjs --runtime docker|podman');
  process.exit(2);
}
const result = spawnSync(runtime, ['build', '--file', 'stub-image/Dockerfile', '--tag', 'p1t-stub-harness:wp02', '.'], {
  cwd: root, stdio: 'inherit', timeout: 900_000,
});
if (result.error) { console.error(`stub image build unavailable: ${result.error.message}`); process.exit(2); }
process.exit(result.status ?? 2);
