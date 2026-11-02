// SPDX-License-Identifier: MIT
/** Public task endpoint and authored domain implementation; only the public source tree is materialized. */
import type { Packet } from "./contracts.__SEED__.ts";
import { packet, payload, text } from "./contracts.__SEED__.ts";
function impl_decode(raw: string): string {
  const rows: [string, number][] = [];
  if (raw)
    for (const token of raw.split(";")) {
      const match = /^([A-Za-z0-9_]+):(-?\d+)$/.exec(token);
      if (!match || !Number.isSafeInteger(Number(match[2]))) return "error";
      rows.push([match[1]!, Number(match[2])]);
    }
  return JSON.stringify({ version: 1, rows });
}

function impl_migrate(_raw: string): string {
  return "unimplemented";
}

function impl_project(_raw: string): string {
  return "unimplemented";
}

/** Public endpoint; validates the instance frame and predecessor state before domain processing. */
export function decode__SEED__(raw: string): Packet {
  const input = raw;
  const value = input === undefined ? undefined : text(input);
  const result = value === undefined || value === "error" ? "error" : impl_decode(value);
  return packet(result, 1);
}

/** Public endpoint; validates the instance frame and predecessor state before domain processing. */
export function migrate__SEED__(raw: Packet): Packet {
  const input = payload(raw, 1);
  const value = input === undefined ? undefined : text(input);
  const result = value === undefined || value === "error" ? "error" : impl_migrate(value);
  return packet(result, 2);
}

/** Public endpoint; validates the instance frame and predecessor state before domain processing. */
export function project__SEED__(raw: Packet): string {
  const input = payload(raw, 2);
  const value = input === undefined ? undefined : text(input);
  const result = value === undefined || value === "error" ? "error" : impl_project(value);
  return result;
}
