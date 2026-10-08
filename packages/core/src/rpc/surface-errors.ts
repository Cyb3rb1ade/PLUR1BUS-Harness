import { RpcError } from "./errors.ts";
import { CollabError } from "../collab/errors.ts";
import { MediaError } from "../../../media/src/index.ts";
import { mapIdentityError } from "../identity/rpc.ts";
import { IdentityError } from "../identity/service.ts";
export function surfaceError(error: unknown): never {
  if (error instanceof RpcError) throw error;
  if (error instanceof IdentityError) return mapIdentityError(error);
  if (error instanceof CollabError)
    throw new RpcError(
      error.code === "unauthorized"
        ? "E_DENIED"
        : error.code === "not-found"
          ? "E_NOT_FOUND"
          : "E_INVALID_PARAMS",
      "collaboration request refused",
      { reason: error.code },
    );
  if (error instanceof MediaError)
    throw new RpcError(
      error.code === "unsupported_parameter" || error.code === "too_large"
        ? "E_INVALID_PARAMS"
        : "E_NOT_AVAILABLE",
      "media request refused",
      { reason: error.code },
    );
  throw new RpcError("E_STORAGE", "surface storage unavailable");
}
