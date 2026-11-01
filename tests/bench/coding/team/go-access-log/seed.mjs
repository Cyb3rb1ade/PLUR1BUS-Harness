// SPDX-License-Identifier: MIT
/** Host-only semantic oracle; no fixture code or expected output is materialized. */
import { checkedCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  parse: [
    ["GET /__TAG__ 200 __N__\nPOST /x 503 2\n", "200:__N__;503:2"],
    ["\n", ""],
    ["GET /x 999 2", "error"],
    ["GET /x 200 -1", "error"],
    ["GET missing 200 1", "error"],
    ["PATCH /a 200 1", "error"],
    ["GET /a 99 0", "error"],
    ["GET /a 600 0", "error"],
    ["GET /a 200 -1", "error"],
    ["GET /a 200 1 extra", "error"],
  ],
  families: [
    ["503:1;200:__N__;201:2", "2xx:2;5xx:1"],
    ["404:2", "4xx:1"],
    ["", ""],
    ["bad", "error"],
    ["99:0", "error"],
    ["600:0", "error"],
    ["200:-1", "error"],
  ],
  report: [
    ["2xx:__N__;4xx:2;5xx:1", "requests=__NP3__;errors=3"],
    ["1xx:2", "requests=2;errors=0"],
    ["", "requests=0;errors=0"],
    ["2xx:0", "error"],
    ["2yy:1", "error"],
    ["0xx:1", "error"],
    ["6xx:1", "error"],
    ["2xx:1;2xx:2", "error"],
  ],
  e2e: [
    ["GET /__TAG__ 200 __N__\nPOST /x 503 2\n", "requests=2;errors=1;errorPercent=50"],
    ["GET /x 404 2\nPUT /y 201 3", "requests=2;errors=1;errorPercent=50"],
    ["", "requests=0;errors=0;errorPercent=0"],
  ],
  rates: [
    ["requests=3;errors=1", "requests=3;errors=1;errorPercent=33"],
    ["requests=0;errors=0", "requests=0;errors=0;errorPercent=0"],
    ["requests=1;errors=2", "error"],
    ["x", "error"],
  ],
};
/** Expand the private semantic and transport cases for one declared seed. */
export function casesForSeed(seed) {
  return checkedCases(TEMPLATE, seed);
}
/** Return deterministic instance metadata to the trusted materializer. */
export function instanceForSeed(seed) {
  return { taskId: "go-access-log", ...seedValues(seed) };
}
