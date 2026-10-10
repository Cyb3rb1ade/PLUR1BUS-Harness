import { mediaError } from "./errors.ts";
import type { MediaIndexPort, MediaIndexStatus } from "./types.ts";

export const MEDIA_UNAVAILABLE_HINT = "Engine-Version unterstützt Medienindex noch nicht";

/** Port used when the engine has no media index (or it is switched off): every call except status() fails with E_MEDIA_UNAVAILABLE. */
export class DisabledMediaIndex implements MediaIndexPort {
  readonly reason: string | undefined;
  constructor(reason?: string) { this.reason = reason; }
  private fail(): never {
    throw mediaError("E_MEDIA_UNAVAILABLE", this.reason ? `${MEDIA_UNAVAILABLE_HINT} (${this.reason})` : MEDIA_UNAVAILABLE_HINT);
  }
  index: MediaIndexPort["index"] = async () => this.fail();
  search: MediaIndexPort["search"] = async () => this.fail();
  remove: MediaIndexPort["remove"] = async () => this.fail();
  setCaption: MediaIndexPort["setCaption"] = async () => this.fail();
  async status(): Promise<MediaIndexStatus> {
    return { enabled: false, provider: "", model: "", dim: 0, fingerprint: "", counts: { indexed: 0, pending: 0, failed: 0, unsupported: 0 }, backfill: { state: "idle", done: 0, total: 0 } };
  }
  readonly backfill: MediaIndexPort["backfill"] = {
    start: async () => this.fail(),
    pause: async () => this.fail(),
    resume: async () => this.fail(),
    cancel: async () => this.fail(),
  };
}

export function isDisabledMediaIndex(port: unknown): port is DisabledMediaIndex { return port instanceof DisabledMediaIndex; }
