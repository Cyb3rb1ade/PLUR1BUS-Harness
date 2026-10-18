import { createRequire, findPackageJSON } from 'node:module';
// Published nostr-tools source exports point to files absent from its npm tarball.
// require selects its published CommonJS artifacts even under our source test condition.
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const base = dirname(findPackageJSON('nostr-tools', import.meta.url)!);
export const { getPublicKey, getEventHash, verifyEvent, finalizeEvent, generateSecretKey } = require(join(base, 'lib/cjs/pure.js')) as typeof import('nostr-tools/pure');
export const { decode, npubEncode } = require(join(base, 'lib/cjs/nip19.js')) as typeof import('nostr-tools/nip19');
export const { unwrapEvent, wrapManyEvents, wrapEvent, createRumor, createSeal, createWrap } = require(join(base, 'lib/cjs/nip59.js')) as typeof import('nostr-tools/nip59');
