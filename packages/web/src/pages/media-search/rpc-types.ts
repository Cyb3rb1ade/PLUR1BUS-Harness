// Typed RPC methods of media search, merged into RpcMethods so `getApi().rpc("media.search", params)` is checked. The shapes
// are generated from the schema (packages/rpc-schema/generated/types.ts), the same way the other pages merge theirs.
// `config.get`/`config.set` are not merged here: other pages declare them and two differing declarations would not compile.
import type {
  MediaCaptionSetParams,
  MediaCaptionSetResult,
  MediaIndexPauseParams,
  MediaIndexPauseResult,
  MediaIndexReindexParams,
  MediaIndexReindexResult,
  MediaIndexResumeParams,
  MediaIndexResumeResult,
  MediaIndexStatusParams,
  MediaIndexStatusResult,
  MediaSearchParams,
  MediaSearchResult,
} from "../../../../rpc-schema/generated/types.ts";

declare module "../../api/index.ts" {
  interface RpcMethods {
    "media.search": { params: MediaSearchParams; result: MediaSearchResult };
    "media.index.status": { params: MediaIndexStatusParams; result: MediaIndexStatusResult };
    "media.index.pause": { params: MediaIndexPauseParams; result: MediaIndexPauseResult };
    "media.index.resume": { params: MediaIndexResumeParams; result: MediaIndexResumeResult };
    "media.index.reindex": { params: MediaIndexReindexParams; result: MediaIndexReindexResult };
    "media.caption.set": { params: MediaCaptionSetParams; result: MediaCaptionSetResult };
  }
}

export {};
