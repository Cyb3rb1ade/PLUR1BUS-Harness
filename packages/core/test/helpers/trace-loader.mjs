// `--import`ed by the import-hygiene test into a fresh core process: registers a synchronous
// module-resolution hook that records every URL Node resolves, for BOTH `import()` and
// `require()` (a plain `node:module` `register()` async loader hook only sees the ESM `import()`
// path, so a dependency that reaches a CommonJS/builtin module through `createRequire()` — for
// example `require("node:sqlite")` — would resolve invisibly to it; `registerHooks` (Node >=
// 23.5) instruments both).
import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (process.env.PLUR1BUS_TRACE_FILE) appendFileSync(process.env.PLUR1BUS_TRACE_FILE, `${result.url}\n`);
    return result;
  },
});
