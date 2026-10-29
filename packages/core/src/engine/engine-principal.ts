// The shared server owns request contexts and the unforgeable in-process registry; the Core's host dispatch uses it.
export { bindEnginePrincipal, isEngineContext, verifyEngineDelegation, type EngineDelegation } from "@plur1bus/module-api";
