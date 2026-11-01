// SPDX-License-Identifier: MIT
/** Public task endpoint and authored domain implementation; only the public source tree is materialized. */
import type { Packet } from "./contracts.__SEED__.ts";
import { packet, payload, text } from "./contracts.__SEED__.ts";
function impl_solve(raw: string): string {
  try {
    const slot: { start: number | null; end: number | null; minutes: number } = JSON.parse(raw);
    if (Object.keys(slot).sort().join(",") !== "end,minutes,start") return "error";
    if (slot.start === null && slot.end === null && slot.minutes === 0) return "FULL";
    if (
      !Number.isInteger(slot.start) ||
      !Number.isInteger(slot.end) ||
      !Number.isInteger(slot.minutes) ||
      slot.start === null ||
      slot.end === null ||
      slot.start < 0 ||
      slot.start >= slot.end ||
      slot.end > 100 ||
      slot.minutes !== slot.end - slot.start
    )
      return "error";
    return `AVAILABLE ${slot.start}..${slot.end} (${slot.minutes} minutes)`;
  } catch {
    return "error";
  }
}
/** Public endpoint; validates the instance frame and predecessor state before domain processing. */
export function solve__SEED__(raw: string): string {
  const input = raw;
  const value = input === undefined ? undefined : text(input);
  const result = value === undefined || value === "error" ? "error" : impl_solve(value);
  return result;
}
