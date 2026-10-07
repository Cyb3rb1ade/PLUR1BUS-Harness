export { compileEgressPolicy, hostAllowed, DEFAULT_EGRESS_CONFIG, type EgressConfig, type EgressPolicy } from "./policy.ts";
export { createGate, EgressDenial, isLoopbackHost, type DenyReason, type Decision, type HopGate } from "./gate.ts";
export { createEgress, type Egress, type EgressOptions, type EgressStatus, type DryRun } from "./service.ts";
