import { createHash } from "node:crypto";
import { IdentityError } from "./store.ts";

export type UserPrincipal = `user:v${1 | 2}:${string}`;
export const USER_PRINCIPAL = /^user:v(1|2):[a-f0-9]{64}$/;
export function isUserPrincipal(value: unknown): value is UserPrincipal {
  return typeof value === "string" && USER_PRINCIPAL.test(value);
}
/** Opaque ids are exact UTF-8 bytes: never trim, case-fold or normalize Unicode. */
export function deriveUserPrincipal(harnessUserId: string): UserPrincipal {
  if (typeof harnessUserId !== "string" || !harnessUserId || harnessUserId.length > 128 || /[\u0000-\u001f\u007f]/.test(harnessUserId)) {
    throw new IdentityError("invalid-params", "invalid harness user id");
  }
  return `user:v2:${createHash("sha256").update(harnessUserId, "utf8").digest("hex")}`;
}
