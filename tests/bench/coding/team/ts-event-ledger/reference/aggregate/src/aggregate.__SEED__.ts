// SPDX-License-Identifier: MIT
/** Public task endpoint and authored domain implementation; only the public source tree is materialized. */
import type { Packet } from "./contracts.__SEED__.ts";
import { packet, payload, text } from "./contracts.__SEED__.ts";
function impl_solve(raw: string): string {
  if (!raw) return "0,0";
  const rows = raw.split(";");
  let total = 0;
  for (const row of rows) {
    const match = /^[A-Za-z0-9_]+:(-?\d+)$/.exec(row);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return "error";
    total += Number(match[1]);
    if (!Number.isSafeInteger(total)) return "error";
  }
  return `${rows.length},${total}`;
}

/** Public endpoint; validates the instance frame and predecessor state before domain processing. */
export function solve__SEED__(raw: string): string {
  const input = raw;
  const value = input === undefined ? undefined : text(input);
  const result = value === undefined || value === "error" ? "error" : impl_solve(value);
  return result;
}
