export { authorize, canSee } from "./authorize.ts";
export { POLICY, policyFor } from "./policy.ts";
export { createBreakGlass, BreakGlassError, type BreakGlass, type BreakGlassNotice, type BreakGlassOptions } from "./break-glass.ts";
export { createJsonlAuditSink, memoryAuditSink, type AuditEvent, type AuditSink } from "./audit.ts";
export { LOCAL_OWNER, RPC_RULES, guardMethods, type GuardOptions, type PrincipalResolver } from "./guard.ts";
export * from "./types.ts";
export { STEP_UP_WINDOW_MS, surfaceSatisfies, surfaceTrust, type SurfaceFacts, type SurfaceTrustLevel } from "./surface.ts";
export { UNATTESTED_LOCAL_SURFACE, connectionSurface, type ConnectionAttestation, type ConnectionFacts } from "./connection-surface.ts";
