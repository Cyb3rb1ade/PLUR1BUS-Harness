// The temp-dir helper lives with module-api's tests (H3B-R12 moved the shared runtime pieces there); the core's tests
// keep importing it from here. A test-only relative import, in the package dependency direction (the core depends on
// module-api); it is not part of module-api's published surface.
export { tempDir } from "../../../module-api/test/helpers/temp-dir.ts";
