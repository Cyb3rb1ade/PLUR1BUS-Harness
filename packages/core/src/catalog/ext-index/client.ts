// #162 entry point, upgraded to the complete trust client. There are no production callers to migrate yet.
export { createCatalogClient as createExtIndexClient } from "../client.ts";
export type { CatalogClient as ExtIndexClient, CatalogOptions as ExtIndexClientOptions } from "../types.ts";
