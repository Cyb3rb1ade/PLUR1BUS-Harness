export { createExtIndexClient } from "./client.ts";
export type { ExtIndexClient, ExtIndexClientOptions } from "./client.ts";
export { createCatalogFileStore, createFileCacheStore } from "./store.ts";
export * from "../types.ts";
// Low-level #162 schema/crypto utilities; the client supplies trust, lifetime, threshold and rollback policy.
export { importPublicKey, importKeys, parseIndex, verifySignature } from "./verify.ts";
export { ExtIndexError } from "./types.ts";
