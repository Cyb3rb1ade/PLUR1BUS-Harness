// SPDX-License-Identifier: MIT
/** Host-only semantic oracle; no fixture code or expected output is materialized. */
import { checkedCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  merge: [
    ["__N2__..__N3__,0..__N__,__N__..__N2__", "0..__N3__"],
    ["1..2,5..6", "1..2,5..6"],
    ["", ""],
    ["4..4", "error"],
    ["garbage", "error"],
    ["-1..3", "error"],
    ["1..101", "error"],
  ],
  gaps: [
    ["0..__N__,__N2__..100", "__N__..__N2__"],
    ["0..100", ""],
    ["", "0..100"],
    ["5..10,2..4", "error"],
    ["garbage", "error"],
    ["4..4", "error"],
    ["1..101", "error"],
  ],
  choose: [
    ["0..__N__,__N2__..__N3__", "0..__N__"],
    ["20..30,0..5", "20..30"],
    ["", "none"],
    ["4..3", "error"],
    ["20..30,0..10", "0..10"],
  ],
  e2e: [
    ["__N__..__N2__,__N2__..100", "AVAILABLE 0..__N__ (__N__ minutes)"],
    ["0..100", "FULL"],
    ["", "AVAILABLE 0..100 (100 minutes)"],
  ],
  duration: [
    ["0..12", '{"start":0,"end":12,"minutes":12}'],
    ["none", '{"start":null,"end":null,"minutes":0}'],
    ["9..8", "error"],
    ["x", "error"],
  ],
  display: [
    ['{"start":0,"end":12,"minutes":12}', "AVAILABLE 0..12 (12 minutes)"],
    ['{"start":null,"end":null,"minutes":0}', "FULL"],
    ['{"start":0,"end":12,"minutes":11}', "error"],
    ["{}", "error"],
  ],
};
/** Expand the private semantic and transport cases for one declared seed. */
export function casesForSeed(seed) {
  return checkedCases(TEMPLATE, seed);
}
/** Return deterministic instance metadata to the trusted materializer. */
export function instanceForSeed(seed) {
  return { taskId: "ts-calendar", ...seedValues(seed) };
}
