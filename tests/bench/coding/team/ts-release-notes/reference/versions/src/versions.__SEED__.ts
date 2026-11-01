// SPDX-License-Identifier: MIT
/** Public task endpoint and authored domain implementation; only the public source tree is materialized. */
import type { Packet } from "./contracts.__SEED__.ts";
import { packet, payload, text } from "./contracts.__SEED__.ts";
function impl_solve(raw: string): string {
  if (!raw) return "";
  const versions: number[][] = [];
  for (const token of raw.split(",")) {
    if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(token)) return "error";
    const values = token.replace(/^v/, "").split(".").map(Number);
    if (!values.every(Number.isSafeInteger)) return "error";
    versions.push(values);
  }
  return [
    ...new Set(versions.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!).map((v) => v.join("."))),
  ].join(",");
}

/** Public endpoint; validates the instance frame and predecessor state before domain processing. */
export function solve__SEED__(raw: string): string {
  const input = raw;
  const value = input === undefined ? undefined : text(input);
  const result = value === undefined || value === "error" ? "error" : impl_solve(value);
  return result;
}
