import type { IdentityService } from "./service.ts";
import { isUserPrincipal } from "./principals.ts";
import { IdentityError } from "./store.ts";

/** Engine integration port. Reads take the union; writes always take one canonical principal. */
export interface RecallScopeProvider {
  resolvePrincipals(userV2: string): string[];
  capturePrincipal(userV2: string): string;
}
export function createRecallScopeProvider(service: IdentityService): RecallScopeProvider {
  return {
    resolvePrincipals: userV2 => service.resolvePrincipals(userV2),
    capturePrincipal(userV2) {
      if (!isUserPrincipal(userV2) || !userV2.startsWith("user:v2:")) throw new IdentityError("invalid-params", "expected v2 principal");
      service.resolvePrincipals(userV2); // require a known harness user
      return userV2;
    },
  };
}
