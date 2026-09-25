// `--import`ed by the import-hygiene test into a fresh core process: registers the resolve hook
// (trace-hooks.mjs) that records every module URL the core resolves at start.
import { register } from "node:module";

register(new URL("./trace-hooks.mjs", import.meta.url));
