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
  const cases = checkedCases(TEMPLATE, seed);
  const payload = "a".repeat(65536);
  cases.decode.push({ id: "decode-max-bytes", input: "65536:" + payload, expected: payload });
  cases.decode.push({ id: "decode-too-many-bytes", input: "65537:" + payload + "a", expected: "error" });
  cases.hex.push({ id: "hex-max-payload", input: payload, expected: "61".repeat(65536) });
  cases.e2e.push({ id: "e2e-max-payload", input: "65536:" + payload, expected: "00" });
  return cases;
}
/** Return deterministic instance metadata to the trusted materializer. */
export function instanceForSeed(seed) {
  return { taskId: "rs-frame-checksum", ...seedValues(seed) };
}
