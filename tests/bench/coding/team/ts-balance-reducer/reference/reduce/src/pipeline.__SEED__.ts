// SPDX-License-Identifier: MIT
/** Public task endpoint and authored domain implementation; only the public source tree is materialized. */
import type { Packet } from "./contracts.__SEED__.ts";
import { packet, payload, text } from "./contracts.__SEED__.ts";
function impl_decode(raw: string): string {
  const events: [string, number][] = [];
  if (raw)
    for (const part of raw.split(";")) {
      const match = /^(add|sub)=(\d+)$/.exec(part);
      if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0) return "error";
      events.push([match[1]!, Number(match[2])]);
    }
  return JSON.stringify(events);
}

function impl_reduce(raw: string): string {
  try {
    const events: unknown = JSON.parse(raw);
    if (!Array.isArray(events)) return "error";
    let balance = 0,
      accepted = 0,
      rejected = 0;
    for (const event of events) {
      if (
        !Array.isArray(event) ||
        event.length !== 2 ||
        !["add", "sub"].includes(event[0]) ||
        !Number.isSafeInteger(event[1]) ||
        Number(event[1]) <= 0
      )
        return "error";
      const amount = Number(event[1]);
      if (event[0] === "sub" && amount > balance) {
        rejected++;
        continue;
      }
      balance += event[0] === "add" ? amount : -amount;
      if (!Number.isSafeInteger(balance)) return "error";
      accepted++;
    }
    return JSON.stringify({ balance, accepted, rejected });
  } catch {
    return "error";
  }
}

function impl_report(_raw: string): string {
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
export function reduce__SEED__(raw: Packet): Packet {
  const input = payload(raw, 1);
  const value = input === undefined ? undefined : text(input);
  const result = value === undefined || value === "error" ? "error" : impl_reduce(value);
  return packet(result, 2);
}

/** Public endpoint; validates the instance frame and predecessor state before domain processing. */
export function report__SEED__(raw: Packet): string {
  const input = payload(raw, 2);
  const value = input === undefined ? undefined : text(input);
  const result = value === undefined || value === "error" ? "error" : impl_report(value);
  return result;
}
