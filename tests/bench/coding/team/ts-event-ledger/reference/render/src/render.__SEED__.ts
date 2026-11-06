// SPDX-License-Identifier: MIT
/** Public task endpoint and authored domain implementation; only the public source tree is materialized. */
import type { Packet } from "./contracts.__SEED__.ts";
import { packet, payload, text } from "./contracts.__SEED__.ts";
function impl_solve(raw: string): string {
  const match = /^(\d+),(-?\d+)$/.exec(raw);
  return match && match.slice(1).every((value) => Number.isSafeInteger(Number(value)))
    ? `events=${Number(match[1])};total=${Number(match[2])}`
    : "error";
}

/** Public endpoint; validates the instance frame and predecessor state before domain processing. */
export function solve__SEED__(raw: string): string {
  const input = raw;
  const value = input === undefined ? undefined : text(input);
  const result = value === undefined || value === "error" ? "error" : impl_solve(value);
  return result;
}
