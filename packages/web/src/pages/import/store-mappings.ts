/** Discovered stores keep their opaque server authority until the Core reseals a requested source mapping. */
import type {
  AdminImportPlanParams,
  ImportDiscovery,
  ImportDetection,
} from "../../../../rpc-schema/generated/types.ts";

export type SourceStore = NonNullable<ImportDetection["stores"]>[number];
export type UnmappedSourcePath = NonNullable<ImportDetection["portability"]>["unmapped"][number];
export type DiscoveredStore = NonNullable<ImportDiscovery["stores"]>[number];
type Mappings = NonNullable<NonNullable<AdminImportPlanParams["options"]>["maps"]>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const absolute = (path: string): boolean =>
  path.length <= 4096 && /^(?:\/|\\\\|[A-Za-z]:[\\/])/.test(path) && !/[\x00-\x1f\x7f]/.test(path);

/** Only a returned opaque ID becomes the replacement selector; displayed paths never supply read authority. */
export function storeReplacement(id: string, stores: readonly DiscoveredStore[]): string {
  if (!uuid.test(id) || !stores.some((store) => store.id === id)) throw new Error("discovered-store-required");
  return `store:${id}`;
}
/** UI readiness only. Core checks the authenticated owner, expiry, original transport and sealed bytes independently. */
export function importMappingsReady(
  maps: Mappings | undefined,
  stores: readonly DiscoveredStore[],
  hostPathsAllowed: boolean,
): boolean {
  if (!maps) return true;
  const seen = new Set<string>();
  return (
    maps.length <= 64 &&
    maps.every((mapping) => {
      if (!absolute(mapping.from) || seen.has(mapping.from)) return false;
      seen.add(mapping.from);
      if (mapping.to.startsWith("store:")) {
        try {
          return storeReplacement(mapping.to.slice(6), stores) === mapping.to;
        } catch {
          return false;
        }
      }
      return hostPathsAllowed && absolute(mapping.to);
    })
  );
}

/** Adoption uses the inspected source's real store IDs, never a guessed destination or discovery receipt ID. */
export function sourceStoreReady(id: string | undefined, stores: readonly SourceStore[] | undefined): boolean {
  return id === undefined || !!stores?.some((store) => store.id === id);
}
