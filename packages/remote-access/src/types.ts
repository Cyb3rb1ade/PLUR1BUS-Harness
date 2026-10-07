// Small shared types. Everything in this package works on plain data and injected ports (clock, exec, secret store),
// so the API package can wire it later without this package knowing about the core, the RPC layer or the disk.

/** Epoch milliseconds. Every time-dependent function takes the current time as a parameter. */
export type EpochMs = number;

/** Who confirmed the security notice shown when `remote.publish` = `network` is switched on, and when (spec §6.2). */
export interface NoticeAck {
  readonly by: string;
  readonly at: EpochMs;
}

/** A note from a planner or a check: a stable machine code plus a human sentence. */
export interface Note {
  readonly code: string;
  readonly message: string;
}

/** Where private keys live. The real implementation is the core's secret store (ADR-005); this package never writes a
 *  private key anywhere else, and a generated key leaves the module only through `put`. */
export interface SecretPort {
  put(ref: string, value: Uint8Array): Promise<void>;
  get(ref: string): Promise<Uint8Array | undefined>;
  delete(ref: string): Promise<void>;
}
