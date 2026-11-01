// SPDX-License-Identifier: MIT
/** Public task endpoint and authored domain implementation; only the public source tree is materialized. */
import type { Packet } from "./contracts.__SEED__.ts";
import { packet, payload, text } from "./contracts.__SEED__.ts";
function impl_solve(raw: string): string {
  if (!raw) return "none";
  const ranges: number[][] = [];
  for (const part of raw.split(",")) {
    const m = /^(\d+)\.\.(\d+)$/.exec(part);
    if (!m || Number(m[1]) >= Number(m[2]) || Number(m[2]) > 100) return "error";
    ranges.push([Number(m[1]), Number(m[2])]);
  }
  ranges.sort((a, b) => b[1]! - b[0]! - (a[1]! - a[0]!) || a[0]! - b[0]!);
  return ranges[0]!.join("..");
}

/** Public endpoint; validates the instance frame and predecessor state before domain processing. */
export function solve__SEED__(raw: string): string {
  const input = raw;
  const value = input === undefined ? undefined : text(input);
  const result = value === undefined || value === "error" ? "error" : impl_solve(value);
  return result;
}
