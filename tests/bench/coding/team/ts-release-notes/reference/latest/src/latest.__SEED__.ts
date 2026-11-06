// SPDX-License-Identifier: MIT
/** Public task endpoint and authored domain implementation; only the public source tree is materialized. */
import type { Packet } from "./contracts.__SEED__.ts";
import { packet, payload, text } from "./contracts.__SEED__.ts";
function impl_solve(raw: string): string {
  if (!raw) return "none";
  const rows = raw.split(",");
  if (
    rows.some(
      (row) =>
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(row) ||
        !row.split(".").map(Number).every(Number.isSafeInteger),
    )
  )
    return "error";
  return rows
    .sort((a, b) => {
      const x = a.split(".").map(Number),
        y = b.split(".").map(Number);
      return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
    })
    .at(-1)!;
}

/** Public endpoint; validates the instance frame and predecessor state before domain processing. */
export function solve__SEED__(raw: string): string {
  const input = raw;
  const value = input === undefined ? undefined : text(input);
  const result = value === undefined || value === "error" ? "error" : impl_solve(value);
  return result;
}
