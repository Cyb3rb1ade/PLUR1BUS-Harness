// SPDX-License-Identifier: MIT
/** Host-only semantic oracle; no fixture code or expected output is materialized. */
import { checkedCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  union: [
    ["__N__..__N2__,0..__NM1__,__N2__..__N3__", "0..__N3__"],
    ["-3..-1,0..0", "-3..0"],
    ["", ""],
    ["3..2", "error"],
  ],
  cardinality: [
    ["1..__N__", "__N__"],
    ["-2..-1,1..2", "4"],
    ["", "0"],
    ["1..3,2..4", "error"],
  ],
  describe: [
    ["__N__", "points=__N__"],
    ["0", "points=0"],
    ["004", "points=4"],
    ["-1", "error"],
    ["+1", "error"],
    ["", "error"],
    ["one", "error"],
  ],
  e2e: [
    ["1..__N__,2..__NM1__", "points=__N__"],
    ["-2..-1,1..2", "points=4"],
    ["", "points=0"],
  ],
};
/** Expand the private semantic and transport cases for one declared seed. */
export function casesForSeed(seed) {
  return checkedCases(TEMPLATE, seed);
}
/** Return deterministic instance metadata to the trusted materializer. */
export function instanceForSeed(seed) {
  return { taskId: "rs-range-set", ...seedValues(seed) };
}
