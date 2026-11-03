// SPDX-License-Identifier: MIT
/** Public task endpoint and authored domain implementation; only the public source tree is materialized. */
import type { Packet } from "./contracts.__SEED__.ts";
import { packet, payload, text } from "./contracts.__SEED__.ts";
function impl_solve(raw: string): string {
  if (!raw) return "";
  const ranges: number[][] = [];
  for (const part of raw.split(",")) {
    const m = /^(\d+)\.\.(\d+)$/.exec(part);
    if (!m) return "error";
    const a = Number(m[1]),
      b = Number(m[2]);
    if (a >= b || b > 100) return "error";
    ranges.push([a, b]);
  }
  const result: number[][] = [];
  for (const [a, b] of ranges.sort((a, b) => a[0]! - b[0]!)) {
    const last = result.at(-1);
    if (last && a! <= last[1]!) last[1] = Math.max(last[1]!, b!);
    else result.push([a!, b!]);
  }
  return result.map((r) => r.join("..")).join(",");
}

/** Public endpoint; validates the instance frame and predecessor state before domain processing. */
export function solve__SEED__(raw: string): string {
  const input = raw;
  const value = input === undefined ? undefined : text(input);
  const result = value === undefined || value === "error" ? "error" : impl_solve(value);
  return result;
}
