// SPDX-License-Identifier: MIT
/** Public task endpoint and authored domain implementation; only the public source tree is materialized. */
import type { Packet } from "./contracts.__SEED__.ts";
import { packet, payload, text } from "./contracts.__SEED__.ts";
function impl_solve(raw: string): string {
  let end = 0;
  const result: string[] = [];
  if (raw)
    for (const part of raw.split(",")) {
      const m = /^(\d+)\.\.(\d+)$/.exec(part);
      if (!m) return "error";
      const a = Number(m[1]),
        b = Number(m[2]);
      if (a < end || a >= b || b > 100) return "error";
      if (a > end) result.push(`${end}..${a}`);
      end = b;
    }
  if (end < 100) result.push(`${end}..100`);
  return result.join(",");
}

/** Public endpoint; validates the instance frame and predecessor state before domain processing. */
export function solve__SEED__(raw: string): string {
  const input = raw;
  const value = input === undefined ? undefined : text(input);
  const result = value === undefined || value === "error" ? "error" : impl_solve(value);
  return result;
}
