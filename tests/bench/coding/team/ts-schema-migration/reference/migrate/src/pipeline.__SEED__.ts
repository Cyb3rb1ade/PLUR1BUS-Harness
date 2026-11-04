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

function impl_migrate(raw: string): string {
  try {
    const value = JSON.parse(raw) as { version?: unknown; rows?: unknown };
    if (!value || value.version !== 1 || !Array.isArray(value.rows)) return "error";
    const sums = new Map<string, number>();
    for (const row of value.rows) {
      if (
        !Array.isArray(row) ||
        row.length !== 2 ||
        typeof row[0] !== "string" ||
        !/^[A-Za-z0-9_]+$/.test(row[0]) ||
        !Number.isSafeInteger(row[1])
      )
        return "error";
      const id = row[0].toLowerCase(),
        next = (sums.get(id) ?? 0) + Number(row[1]);
      if (!Number.isSafeInteger(next)) return "error";
      sums.set(id, next);
    }
    return JSON.stringify({
      version: 2,
      accounts: [...sums].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, balance]) => ({ id, balance })),
    });
  } catch {
    return "error";
  }
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
