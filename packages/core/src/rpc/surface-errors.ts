import { RpcError } from "./errors.ts";
import { CollabError } from "../collab/errors.ts";
import { MediaError } from "../../../media/src/index.ts";
import { mapIdentityError } from "../identity/rpc.ts";
import { IdentityError } from "../identity/service.ts";
import { MEDIA_ERROR_CODES, type MediaErrorCode } from "../media-search/types.ts";

const isMediaIndexCode = (c: unknown): c is MediaErrorCode => typeof c === "string" && (MEDIA_ERROR_CODES as readonly string[]).includes(c);
/** Fixed text per media-index code: the engine's own message can name paths, models or provider details. */
const MEDIA_INDEX_MESSAGES: Record<MediaErrorCode, string> = {
  E_MEDIA_CAPABILITY: "the media provider cannot handle this media kind",
  E_MEDIA_LICENSE: "the media model licence has not been confirmed",
  E_MEDIA_PRIVACY: "the privacy pin forbids a cloud media provider",
  E_MEDIA_UNAVAILABLE: "the media index is not available",
  E_MEDIA_DIMENSION: "the media index dimensions do not match",
  E_MEDIA_UNSUPPORTED_KIND: "this media kind cannot be processed",
};
export function surfaceError(error: unknown): never {
  if (error instanceof RpcError) throw error;
  // The media index (engine) raises plain errors carrying one of its six E_MEDIA_* codes; they keep the code on the wire.
  const mediaCode = (error as { code?: unknown } | null)?.code;
  if (isMediaIndexCode(mediaCode)) throw new RpcError(mediaCode, MEDIA_INDEX_MESSAGES[mediaCode], { reason: mediaCode.slice("E_MEDIA_".length).toLowerCase().replaceAll("_", "-") });
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
