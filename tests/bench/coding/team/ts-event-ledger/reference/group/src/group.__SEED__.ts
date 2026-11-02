// SPDX-License-Identifier: MIT
/** Public task endpoint and authored domain implementation; only the public source tree is materialized. */
import type { Packet } from "./contracts.__SEED__.ts";
import { packet, payload, text } from "./contracts.__SEED__.ts";
function impl_solve(raw: string): string {
  const totals = new Map<string, number>();
  if (!raw) return "";
  for (const token of raw.split(";")) {
    const match = /^([A-Za-z0-9_]+):(-?\d+)$/.exec(token);
    if (!match) return "error";
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value)) return "error";
    const next = (totals.get(match[1]!) ?? 0) + value;
    if (!Number.isSafeInteger(next)) return "error";
    totals.set(match[1]!, next);
  }
  return [...totals]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, n]) => `${id}:${n}`)
    .join(";");
}

/** Public endpoint; validates the instance frame and predecessor state before domain processing. */
export function solve__SEED__(raw: string): string {
  const input = raw;
  const value = input === undefined ? undefined : text(input);
  const result = value === undefined || value === "error" ? "error" : impl_solve(value);
  return result;
}
