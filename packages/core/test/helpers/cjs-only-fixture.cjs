// A plain CommonJS module, resolved only through `require()` (via `createRequire`), never through
// `import()`. Used by trace-loader-hooks.test.ts to prove the trace hook sees CJS resolution too —
// the real engine reaches at least one module this same way (`lib/speaker-mapping-store.js` calls
// `createRequire(import.meta.url)("node:sqlite")`), and a plain `node:module` `register()` async
// loader hook (the mechanism this replaced) does not see that resolution at all.
module.exports = { marker: "cjs-only-fixture" };
