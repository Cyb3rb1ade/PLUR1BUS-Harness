// SPDX-License-Identifier: MIT
/** Public task endpoint and authored domain implementation; only the public source tree is materialized. */
/** Public UTF-8 frame and stage-state interface for this instance. No oracle or seed is present. */
const PROFILE = Number("__PROFILE__");
const SALT = Number("__SALT__");
/** Typed state produced by one stage and consumed by its successor. */
export interface Packet {
  payload: string;
  stage: number;
  stamp: number;
}
function stamp(value: string, stage: number): number {
  return [...Buffer.from(value)].reduce((sum, byte) => (sum + byte) % 65536, SALT * stage);
}
/** Construct state using the actual predecessor output, rather than a precomputed intermediate. */
export function packet(value: string, stage: number): Packet {
  return { payload: value, stage, stamp: stamp(value, stage) };
}
/** Refuse a stale, malformed or corrupted predecessor state. */
export function payload(value: Packet, stage: number): string | undefined {
  return value &&
    value.stage === stage &&
    typeof value.payload === "string" &&
    value.stamp === stamp(value.payload, stage)
    ? value.payload
    : undefined;
}
/** Accept raw text or this instance's optional @TEXT frame; lengths count UTF-8 bytes. */
export function text(raw: string): string | undefined {
  if (!raw.startsWith("@TEXT")) return raw;
  const split = raw.indexOf("\n");
  if (split < 0) return undefined;
  const body = raw.slice(split + 1);
  const bytes = Buffer.from(body);
  const sum = [...bytes].reduce((sum, byte) => (sum + byte) % 256, SALT);
  const suffix = PROFILE === 0 ? "" : PROFILE === 1 ? `:${bytes.length}` : `:${bytes.length}:${sum}`;
  return raw.slice(0, split) === `@TEXT${suffix}` ? body : undefined;
}
