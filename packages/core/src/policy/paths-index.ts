// Public surface of the D109 path canonicaliser. (policy/index.ts belongs to the parallel decide/capabilities session.)
export { canonicalisePath, checkSyntax, containsExact, foldForDeny, isForbiddenRoot, isPathRefusal, isReservedDeviceName, matchDeny, openVerified } from "./paths.ts";
export type { Access, CanonicalPath, CanonicaliseOptions, DenyEntry, Identity, PathRefusal, PathResult, PathRoot, RefusalReason, SyntaxOk } from "./paths.ts";
