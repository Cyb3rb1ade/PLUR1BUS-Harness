// SPDX-License-Identifier: MIT
/** Host-only semantic oracle; no fixture code or expected output is materialized. */
import { checkedCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  decode: [
    ["/__TAG__/%20x", "/__TAG__/ x"],
    ["/%c3%a4", "/ä"],
    ["a+b", "a+b"],
    ["/%FF", "error"],
    ["/%x1", "error"],
    ["/%00", "error"],
    ["/a\u0000b", "error"],
  ],
  normalize: [
    ["/__TAG__/../ok//./", "/ok"],
    ["/a/../", "/"],
    ["/../x", "error"],
    ["relative", "error"],
    ["/a\u0000b", "error"],
  ],
  encode: [
    ["/__TAG__/a b", "/__TAG__/a%20b"],
    ["/ä", "/%C3%A4"],
    ["/a+b", "/a%2Bb"],
    ["x", "error"],
    ["/a\u0000b", "error"],
  ],
  e2e: [
    ["/__TAG__/%2e%2e/a%20b/", "path=/a%20b;segments=1;etag=79"],
    ["/%c3%a4/./", "path=/%C3%A4;segments=1;etag=64"],
    ["/a//b/../c", "path=/a/c;segments=2;etag=22"],
    ["/%00", "error"],
  ],
  segments: [
    ["/a/b", "path=/a/b;segments=2"],
    ["/", "path=/;segments=0"],
    ["/%C3%A4", "path=/%C3%A4;segments=1"],
    ["/%c3", "error"],
    ["x", "error"],
  ],
  etag: [
    ["path=/a/b;segments=2", "path=/a/b;segments=2;etag=21"],
    ["path=/;segments=0", "path=/;segments=0;etag=2f"],
    ["path=/a;segments=2", "error"],
    ["path=x;segments=1", "error"],
  ],
};
/** Expand the private semantic and transport cases for one declared seed. */
export function casesForSeed(seed) {
  return checkedCases(TEMPLATE, seed);
}
/** Return deterministic instance metadata to the trusted materializer. */
export function instanceForSeed(seed) {
  return { taskId: "rs-route-path", ...seedValues(seed) };
}
