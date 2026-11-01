// SPDX-License-Identifier: MIT
/** Host-only semantic oracle; no fixture code or expected output is materialized. */
import { checkedCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  decode: [
    ["__TAGLEN__:__TAG__", "__TAG__"],
    ["2:ä", "ä"],
    ["0:", ""],
    ["1:ä", "error"],
    ["01:a", "error"],
    ["1:\u0000", "error"],
  ],
  hex: [
    ["__TAG__", "__TAGHEX__"],
    ["ä", "c3a4"],
    ["A:", "413a"],
    ["", ""],
    ["\u0000", "00"],
  ],
  checksum: [
    ["__TAGHEX__", "__TAGSUM__"],
    ["ff01", "00"],
    ["C3A4", "67"],
    ["", "00"],
    ["0", "error"],
    ["\u0000", "error"],
  ],
  e2e: [
    ["__TAGLEN__:__TAG__", "__TAGSUM__"],
    ["2:ä", "67"],
    ["0:", "00"],
    ["1:\u0000", "error"],
  ],
};
/** Expand the private semantic and transport cases for one declared seed. */
export function casesForSeed(seed) {
  return checkedCases(TEMPLATE, seed);
}
/** Return deterministic instance metadata to the trusted materializer. */
export function instanceForSeed(seed) {
  return { taskId: "rs-frame-checksum", ...seedValues(seed) };
}
