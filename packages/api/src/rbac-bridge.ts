// The one place `packages/api` reaches into `packages/core` (read and call only, core is not changed). `@plur1bus/core`
// exports only its built `dist/index.js`, which does not carry `rbac/` or `audit/` (docs/rbac.md: "core-internal; no
// package export yet"). These modules are pure (authorize, policy, types, break-glass) or self-contained (the audit
// chain, which serialises writers with an OS lock), so a relative import bundles them into the API without pulling the
// core process in. Follow-up: a `@plur1bus/core/rbac` subpath export, then this file becomes a package import.
export { authorize, canSee } from "../../core/src/rbac/authorize.ts";
export { policyFor } from "../../core/src/rbac/policy.ts";
export { createBreakGlass, BreakGlassError } from "../../core/src/rbac/break-glass.ts";
export { createAuditChain } from "../../core/src/audit/chain.ts";
export type { BreakGlass, BreakGlassNotice } from "../../core/src/rbac/break-glass.ts";
export type { AuditEvent, AuditSink } from "../../core/src/rbac/audit.ts";
export type { AgentRight, Decision, Principal as RbacPrincipal, ProjectRight, Resource, Role } from "../../core/src/rbac/types.ts";
