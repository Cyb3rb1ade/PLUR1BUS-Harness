// The one place `packages/api` reaches into `packages/core` for address classification (read and call only, core is not
// changed). `@plur1bus/core` exports only its built `dist/index.js`, which does not carry `tools/web/ip.ts`. The module is
// pure (no I/O, no node imports), so a relative import bundles it into the API without pulling the core process in; the
// same pattern as `rbac-bridge.ts`. Follow-up: a `@plur1bus/core/net` subpath export, then this file becomes a package import.
export { IANA_SPECIAL_REGISTRY, cidrContainsPublic, parseCidr } from "../../core/src/tools/web/ip.ts";
export type { Cidr, ParsedAddress } from "../../core/src/tools/web/ip.ts";
export { formatAddress } from "../../core/src/tools/web/ip-display.ts";
