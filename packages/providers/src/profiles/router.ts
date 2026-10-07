import { ProviderRouter, RouterError } from "../router/router.ts";
import type { RouterConfig } from "../router/types.ts";
import { resolveModelProfiles } from "./resolve.ts";
import type { ModelProfilesConfig, ProviderRegistry, ResolvedProfiles } from "./types.ts";

export function createRouterFromProfiles(
  config: ModelProfilesConfig | undefined,
  registry: ProviderRegistry,
  options: Omit<RouterConfig, "profiles" | "profileDefaults" | "unsupportedProfiles"> = {},
): { router: ProviderRouter; resolved: ResolvedProfiles } {
  const resolved = resolveModelProfiles(config, registry);
  const router = new ProviderRouter({
    ...options,
    profiles: resolved.table,
    profileDefaults: resolved.defaults,
    unsupportedProfiles: resolved.unsupported,
  });
  return { router, resolved };
}

/** The named profile, else the default one; throws when neither exists. */
export function profileNameOrDefault(resolved: ResolvedProfiles, name?: string): string {
  if (name !== undefined) return name;
  if (resolved.defaultProfile !== undefined) return resolved.defaultProfile;
  throw new RouterError("unknown_profile", "no profile was named and no default profile is configured");
}
