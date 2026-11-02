// SPDX-License-Identifier: MIT
/** Public task endpoint and authored domain implementation; only the public source tree is materialized. */
import type { Packet } from "./contracts.__SEED__.ts";
import { packet, payload, text } from "./contracts.__SEED__.ts";
function impl_solve(raw: string): string {
  if (raw === "none") return JSON.stringify({ start: null, end: null, minutes: 0 });
  const match = /^(\d+)\.\.(\d+)$/.exec(raw);
  if (!match) return "error";
  const start = Number(match[1]),
    end = Number(match[2]);
  if (start >= end || end > 100) return "error";
  return JSON.stringify({ start, end, minutes: end - start });
}
/** Public endpoint; validates the instance frame and predecessor state before domain processing. */
export function solve__SEED__(raw: string): string {
  const input = raw;
  const value = input === undefined ? undefined : text(input);
  const result = value === undefined || value === "error" ? "error" : impl_solve(value);
  return result;
}
