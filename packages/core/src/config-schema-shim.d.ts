// @plur1bus/config-schema ships no declaration file next to its esbuild-bundled
// dist/index.js (a pre-existing gap in that package's build, out of scope for
// packages/core to fix). Re-declare the module here from its TypeScript source,
// which tsconfig.base.json already includes in this compilation.
declare module "@plur1bus/config-schema" {
  export { CONFIG_SCHEMA, SCHEMA_VERSION, defaults, validate, restartClassOf, restartPlan, migrate } from "../../config-schema/src/index.ts";
  export type { HarnessConfig, RestartClass } from "../../config-schema/src/index.ts";
}
