// Mirrors the real engine's shape: an ES module reaching a module through `createRequire()`
// rather than `import()` (`lib/speaker-mapping-store.js` does this for `node:sqlite`). Used by
// trace-loader-hooks.test.ts to prove `trace-loader.mjs`'s hook sees that resolution.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("./cjs-only-fixture.cjs");
console.log(JSON.stringify({ ready: true }));
