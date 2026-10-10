// Typed RPC methods of media search, merged into RpcMethods so `getApi().rpc("media.search", params)` is checked. The shapes
// are the contract's (api/media-search.types.ts); the generated types replace them later (docs/web-ui.md, "Folgearbeit").
// `config.get`/`config.set` are not merged here: other pages declare them and two differing declarations would not compile.
import type { MediaCaptionSetParams, MediaCaptionSetResult, MediaIndexReindexParams, MediaIndexStatus, MediaSearchParams, MediaSearchResult } from "../../api/media-search.types.ts";

declare module "../../api/index.ts" {
  interface RpcMethods {
    "media.search": { params: MediaSearchParams; result: MediaSearchResult };
    "media.index.status": { params: Record<string, never>; result: MediaIndexStatus };
    "media.index.pause": { params: Record<string, never>; result: MediaIndexStatus };
    "media.index.resume": { params: Record<string, never>; result: MediaIndexStatus };
    "media.index.reindex": { params: MediaIndexReindexParams; result: MediaIndexStatus };
    "media.caption.set": { params: MediaCaptionSetParams; result: MediaCaptionSetResult };
  }
}

export {};
